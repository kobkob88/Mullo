package app.mullo.phone

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

/**
 * Task reminders (S47): a task with a day and a time rings then, like Google Tasks. The web
 * code (app/domain/reminders.js) hands over the whole list after every change; it is kept
 * here so the alarms can be set again after a reboot or a time-zone change with Mullo
 * closed. Times stay LOCAL ("2026-10-16T15:00") and are turned into an instant only when an
 * alarm is set, so a trip to another time zone rings at 15:00 there.
 *
 * Done / Snooze on the notification are handled here at once (the notification goes, a
 * snoozed alarm is set again) and queued for the web code, which writes them through
 * actions.js (activity log, sync). No server ever reads tasks for this.
 *
 * The notification shows only the task's text and the note it came from. "Hide task text on
 * the lock screen" = VISIBILITY_SECRET: Android's PRIVATE is redacted only when the phone's
 * own setting hides sensitive content, so it couldn't keep the promise; SECRET does (it
 * still rings and shows once the phone is unlocked).
 */
object Reminders {
    private const val PREFS = "mullo"
    private const val LIST = "reminders"            // { hideOnLock, items: [{ id, at, text, from }] }
    private const val SET = "reminders_set"         // ids with an alarm set now
    private const val TAPS = "reminder_taps"        // Done / Snooze waiting for the web code
    private const val CHANNEL = "reminders"
    private const val TAG = "reminder"
    private const val MAX = 64
    private const val INEXACT_WINDOW_MS = 10 * 60_000L
    private val ID = Regex("[A-Za-z0-9_-]{1,64}")
    // ASCII digits whatever the phone's language (ofPattern keeps DecimalStyle.STANDARD).
    private val AT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm")
    private val HHMM = DateTimeFormatter.ofPattern("HH:mm")
    private val lock = Any()

    const val ACTION_RING = "app.mullo.phone.REMINDER_RING"
    const val ACTION_DONE = "app.mullo.phone.REMINDER_DONE"
    const val ACTION_HOUR = "app.mullo.phone.REMINDER_HOUR"
    const val ACTION_TOMORROW = "app.mullo.phone.REMINDER_TOMORROW"
    const val ACTION_OPEN_TASK = "app.mullo.phone.OPEN_TASK"
    const val EXTRA_ID = "task"
    const val EXTRA_AT = "at"

    fun validId(id: String?) = id != null && ID.matches(id)

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun parseAt(at: String): LocalDateTime? = runCatching { LocalDateTime.parse(at, AT) }.getOrNull()

    private fun list(ctx: Context): JSONObject =
        runCatching { JSONObject(prefs(ctx).getString(LIST, null) ?: "{}") }.getOrDefault(JSONObject())

    private fun items(ctx: Context): List<JSONObject> {
        val a = list(ctx).optJSONArray("items") ?: return emptyList()
        return (0 until a.length()).mapNotNull { a.optJSONObject(it) }
    }

    /** From the web code: the whole list, checked and capped, then the alarms follow it. */
    fun save(ctx: Context, json: String) {
        val raw = runCatching { JSONObject(json) }.getOrNull() ?: return
        // A Done / Snooze the web code hasn't written yet wins over the list it sent: its
        // task row still has the old time, and the snoozed alarm must not be lost.
        val waiting = synchronized(lock) { runCatching { JSONArray(prefs(ctx).getString(TAPS, "[]")) }.getOrDefault(JSONArray()) }
        val pending = (0 until waiting.length()).mapNotNull { waiting.optJSONObject(it) }.associateBy { it.optString("id") }
        val clean = JSONArray()
        val a = raw.optJSONArray("items") ?: JSONArray()
        for (i in 0 until minOf(a.length(), MAX)) {
            val it = a.optJSONObject(i) ?: continue
            val id = it.optString("id")
            val tap = pending[id]
            if (tap?.optString("act") == "done") continue
            val at = if (tap?.has("date") == true) "${tap.optString("date")}T${tap.optString("time")}" else it.optString("at")
            if (!validId(id) || parseAt(at) == null) continue
            clean.put(JSONObject()
                .put("id", id)
                .put("at", at)
                .put("text", it.optString("text").take(300))
                .put("from", if (it.isNull("from")) JSONObject.NULL else it.optString("from").take(200)))
        }
        // A snoozed task the web code left out (its old time has passed) stays, at its new time.
        val sent = (0 until clean.length()).map { clean.getJSONObject(it).optString("id") }.toSet()
        for (item in if (raw.optBoolean("on", true)) items(ctx) else emptyList()) {
            val tap = pending[item.optString("id")] ?: continue
            if (item.optString("id") in sent || !tap.has("date")) continue
            clean.put(JSONObject(item.toString()).put("at", "${tap.optString("date")}T${tap.optString("time")}"))
        }
        channel(ctx) // there from the first list on, so its switch is in Android's settings
        synchronized(lock) {
            prefs(ctx).edit().putString(LIST, JSONObject().put("hideOnLock", raw.optBoolean("hideOnLock")).put("items", clean).toString()).apply()
        }
        scheduleAll(ctx)
    }

    /** Every alarm again from the kept list: after a change, a reboot, a time-zone change,
     *  or exact alarms being allowed. Alarms for tasks no longer in the list are taken away. */
    fun scheduleAll(ctx: Context) = synchronized(lock) {
        val am = ctx.getSystemService(AlarmManager::class.java)
        val now = System.currentTimeMillis()
        val keep = mutableSetOf<String>()
        for (item in items(ctx)) {
            val id = item.optString("id")
            val at = item.optString("at")
            val millis = parseAt(at)?.atZone(ZoneId.systemDefault())?.toInstant()?.toEpochMilli() ?: continue
            if (millis < now - 60_000) continue // already past (its minute counts)
            val pi = ringIntent(ctx, id, at)
            if (exactAllowed(ctx)) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, millis, pi)
            else am.setWindow(AlarmManager.RTC_WAKEUP, millis, INEXACT_WINDOW_MS, pi) // refused: within ~10 minutes
            keep += id
        }
        val before = prefs(ctx).getStringSet(SET, emptySet()) ?: emptySet()
        for (id in before - keep) am.cancel(ringIntent(ctx, id, null))
        prefs(ctx).edit().putStringSet(SET, keep).apply()
    }

    fun exactAllowed(ctx: Context): Boolean =
        ctx.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()

    /** Android's "Alarms & reminders" page for Mullo; the person decides there. Opened from
     *  Mullo's own window, so Back comes back to Mullo: as a new task it landed in a Settings
     *  window already open elsewhere, and Back went to Developer options (owner, 2026-10-15). */
    fun askExact(ctx: Context) {
        val page = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${ctx.packageName}"))
        MainActivity.openPage?.invoke(page) ?: runCatching { ctx.startActivity(page.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    // One PendingIntent per task: the data URI tells them apart (extras don't), so a
    // newer list replaces the alarm and cancel finds it.
    private fun ringIntent(ctx: Context, id: String, at: String?): PendingIntent {
        val i = Intent(ctx, ReminderReceiver::class.java)
            .setAction(ACTION_RING)
            .setData(Uri.parse("mullo-reminder://ring/$id"))
            .putExtra(EXTRA_ID, id)
        if (at != null) i.putExtra(EXTRA_AT, at)
        return PendingIntent.getBroadcast(ctx, 0, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun tapIntent(ctx: Context, action: String, id: String) = PendingIntent.getBroadcast(
        ctx, 0,
        Intent(ctx, ReminderReceiver::class.java).setAction(action).setData(Uri.parse("mullo-reminder://$action/$id")).putExtra(EXTRA_ID, id),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    // Its own channel, so a person can silence task reminders alone in Android's settings.
    private fun channel(ctx: Context): NotificationManager {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Task reminders", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "A task with a day and a time, at that time"
        })
        return nm
    }

    /** The alarm went off. Rings only if the task still has that time in the kept list. */
    fun ring(ctx: Context, id: String, at: String?) {
        val item = items(ctx).firstOrNull { it.optString("id") == id } ?: return
        if (at != null && item.optString("at") != at) return // moved meanwhile: its new alarm will ring
        val nm = channel(ctx)
        val text = item.optString("text").ifBlank { "A task is due" }
        val from = if (item.isNull("from")) null else item.optString("from").ifBlank { null }
        val open = PendingIntent.getActivity(
            ctx, 0,
            Intent(ctx, MainActivity::class.java).setAction(ACTION_OPEN_TASK).setData(Uri.parse("mullo-reminder://open/$id"))
                .putExtra(EXTRA_ID, id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val hide = list(ctx).optBoolean("hideOnLock")
        val n = Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle(text)
            .apply { if (from != null) setContentText("from $from") }
            .setCategory(Notification.CATEGORY_REMINDER)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setVisibility(if (hide) Notification.VISIBILITY_SECRET else Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_popup_reminder)
                .setContentTitle("Task reminder")
                .setContentText("Mullo")
                .build())
            .addAction(Notification.Action.Builder(null, "Done", tapIntent(ctx, ACTION_DONE, id)).build())
            .addAction(Notification.Action.Builder(null, "1 hour", tapIntent(ctx, ACTION_HOUR, id)).build())
            .addAction(Notification.Action.Builder(null, "Tomorrow", tapIntent(ctx, ACTION_TOMORROW, id)).build())
            .build()
        runCatching { nm.notify(TAG, id.hashCode(), n) } // no permission: nothing shows; the task stays in Mullo
    }

    /** Done or Snooze on the notification: it goes now; the change waits for the web code. */
    fun tapped(ctx: Context, action: String, id: String) {
        ctx.getSystemService(NotificationManager::class.java).cancel(TAG, id.hashCode())
        val tap = JSONObject().put("key", "${System.currentTimeMillis()}-${id.hashCode()}").put("id", id)
        synchronized(lock) {
            val l = list(ctx)
            val all = l.optJSONArray("items") ?: JSONArray()
            val kept = JSONArray()
            for (i in 0 until all.length()) {
                val item = all.optJSONObject(i) ?: continue
                if (item.optString("id") != id) { kept.put(item); continue }
                if (action == ACTION_DONE) continue
                // Snooze: an hour from now, or tomorrow at the reminder's own time.
                val was = parseAt(item.optString("at")) ?: LocalDateTime.now()
                val next = if (action == ACTION_HOUR) LocalDateTime.now().plusHours(1).truncatedTo(ChronoUnit.MINUTES)
                else LocalDate.now().plusDays(1).atTime(LocalTime.of(was.hour, was.minute))
                item.put("at", next.format(AT))
                tap.put("date", next.toLocalDate().toString()).put("time", next.toLocalTime().format(HHMM))
                kept.put(item)
            }
            tap.put("act", if (action == ACTION_DONE) "done" else "snooze")
            val taps = runCatching { JSONArray(prefs(ctx).getString(TAPS, "[]")) }.getOrDefault(JSONArray())
            if (taps.length() < 200) taps.put(tap)
            prefs(ctx).edit().putString(LIST, l.put("items", kept).toString()).putString(TAPS, taps.toString()).commit()
        }
        scheduleAll(ctx)
        MainActivity.onReminderTap?.invoke()
    }

    /** The waiting taps, for the web code (app/domain/reminders.js applyReminderTaps). */
    fun taps(ctx: Context): String = synchronized(lock) { prefs(ctx).getString(TAPS, "[]") ?: "[]" }

    /** The web code wrote these: they go. Taps that came in meanwhile stay. */
    fun tapsDone(ctx: Context, json: String) = synchronized(lock) {
        val done = runCatching { JSONArray(json) }.getOrNull() ?: return@synchronized
        val keys = (0 until done.length()).map { done.optString(it) }.toSet()
        val taps = runCatching { JSONArray(prefs(ctx).getString(TAPS, "[]")) }.getOrDefault(JSONArray())
        val left = JSONArray()
        for (i in 0 until taps.length()) taps.optJSONObject(i)?.let { if (it.optString("key") !in keys) left.put(it) }
        prefs(ctx).edit().putString(TAPS, left.toString()).apply()
    }
}

/** Mullo's own alarms and notification buttons (explicit intents only, never exported). */
class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val id = intent.getStringExtra(Reminders.EXTRA_ID)?.takeIf(Reminders::validId) ?: return
        when (intent.action) {
            Reminders.ACTION_RING -> Reminders.ring(ctx, id, intent.getStringExtra(Reminders.EXTRA_AT))
            Reminders.ACTION_DONE, Reminders.ACTION_HOUR, Reminders.ACTION_TOMORROW -> Reminders.tapped(ctx, intent.action!!, id)
        }
    }
}

/** The system's own moments to set the alarms again: a reboot, an app update, the clock or
 *  time zone changing, exact alarms being allowed. All protected broadcasts; whatever the
 *  intent says, this only re-reads Mullo's own kept list. */
class ReminderReschedule : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        Reminders.scheduleAll(ctx)
    }
}
