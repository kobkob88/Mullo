package app.mullo.phone

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.provider.CalendarContract
import android.webkit.JavascriptInterface
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.Calendar
import java.util.TimeZone

/**
 * Watch → phone protocol (same constants in wear/…/Proto.kt - see there), and
 * the inbox the web code drains: received/<id>.m4a + <id>.json, kept until
 * Mullo has saved the recording into its own library and called done(id).
 */
object Inbox {
    const val PATH_OFFER = "/mullo/offer"
    const val PATH_FILE = "/mullo/file/"
    const val PATH_ACK = "/mullo/ack"

    private val ID = Regex("[0-9]{8}-[0-9]{6}")
    fun validId(id: String) = ID.matches(id)

    fun dir(ctx: Context): File = File(ctx.filesDir, "inbox").apply { mkdirs() }
    fun part(ctx: Context, id: String) = File(dir(ctx), "$id.m4a.part")
    fun audio(ctx: Context, id: String) = File(dir(ctx), "$id.m4a")
    fun offer(ctx: Context, id: String) = File(dir(ctx), "$id.offer.json")
    fun received(ctx: Context, id: String) = File(dir(ctx), "$id.json")

    /** "/mullo/file/<id>/<size>/<sha256>" → Triple(id, size, sha256), or null. */
    fun parseFilePath(path: String): Triple<String, Long, String>? {
        if (!path.startsWith(PATH_FILE)) return null
        val parts = path.removePrefix(PATH_FILE).split("/")
        if (parts.size != 3) return null
        val id = parts[0]
        if (!validId(id)) return null // never a path from outside the outbox
        val size = parts[1].toLongOrNull() ?: return null
        return Triple(id, size, parts[2])
    }

    fun sha256(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    /**
     * Fully received recordings, oldest first: [{id, duration_ms, started_at, size, ...}].
     * With the background AI (WatchAi): "ai" = its result when there is one (or
     * {state: "sent", job} for a transcription it sent but didn't collect), and
     * "ai_state": "working" while it runs, so the web app waits instead of
     * sending the same note twice. A job older than WatchAi.STALE_MS doesn't count.
     */
    fun pending(ctx: Context): JSONArray {
        val out = JSONArray()
        dir(ctx).listFiles { f -> f.name.endsWith(".json") && !f.name.endsWith(".offer.json") && !f.name.endsWith(".ai.json") }
            ?.sortedBy { it.name }
            ?.forEach { f ->
                val id = f.name.removeSuffix(".json")
                if (!validId(id) || !audio(ctx, id).exists()) return@forEach
                val entry = JSONObject(f.readText())
                val ai = WatchAi.result(ctx, id).takeIf { it.exists() }
                    ?.let { runCatching { JSONObject(it.readText()) }.getOrNull() }
                    // Sent but not collected: the web app collects that job (capture.js 'sent').
                    ?: WatchAi.job(ctx, id).takeIf { it.exists() }
                        ?.let { runCatching { JSONObject(it.readText()) }.getOrNull() }
                        ?.let { JSONObject().put("state", "sent").put("job", it) }
                ai?.let { entry.put("ai", it) }
                val lock = WatchAi.lock(ctx, id)
                if (lock.exists() && System.currentTimeMillis() - lock.lastModified() < WatchAi.STALE_MS) entry.put("ai_state", "working")
                out.put(entry)
            }
        return out
    }

    fun release(ctx: Context, id: String) {
        if (!validId(id)) return
        audio(ctx, id).delete()
        received(ctx, id).delete()
        WatchAi.result(ctx, id).delete()
        WatchAi.job(ctx, id).delete()
    }
}

/** `MulloNative` in the web code (app/core/native.js): the Mullo Pro key, encrypted here. */
class MulloNativeJs(private val ctx: Context) {
    @JavascriptInterface
    fun setProKey(key: String): String = Bridge.setProKey(ctx, key) ?: "ok"

    @JavascriptInterface
    fun clearProKey() = Bridge.clearProKey(ctx)

    /** A recording started: keep the mic on with the screen locked (MicService). "ok" or why not. */
    @JavascriptInterface
    fun recordingStarted(): String = MicService.start(ctx)

    @JavascriptInterface
    fun recordingStopped() = MicService.stop(ctx)

    /** The person's own AI key as Mullo's server sealed it (never the key itself). "ok" or why not. */
    @JavascriptInterface
    fun setOwnKey(sealed: String): String = Bridge.setOwnKey(ctx, sealed) ?: "ok"

    @JavascriptInterface
    fun clearOwnKey() = Bridge.clearOwnKey(ctx)

    /** The person's own Supabase project. Checked here (a secret key is refused), then the
     *  person confirms in a native dialog. → "asked", or why not. */
    @JavascriptInterface
    fun setServer(url: String, key: String): String {
        val (clean, why) = Cloud.check(url, key)
        if (clean == null) return why ?: "That server can't be used."
        val ask = MainActivity.askServer ?: return "Open Mullo to change the server."
        ask(clean.first, clean.second)
        return "asked"
    }

    /** After `mullo-leave-server`: go (true) or stop (false). Applies only the server the person
     *  already confirmed in the native dialog; nothing to apply = nothing happens. */
    @JavascriptInterface
    fun finishServerChange(ok: Boolean) { MainActivity.finishServer?.invoke(ok) }

    @JavascriptInterface
    fun useMulloServer(): String {
        val ask = MainActivity.askServer ?: return "Open Mullo to change the server."
        ask(null, null)
        return "asked"
    }

    /** The Mullo account session (app/core/account.js), sealed with the Keystore. */
    @JavascriptInterface
    fun saveSession(json: String) = Cloud.saveSession(ctx, json)

    @JavascriptInterface
    fun loadSession(): String = Cloud.loadSession(ctx)

    @JavascriptInterface
    fun clearSession() = Cloud.clearSession(ctx)

    /** On their own server, the second session: Mullo's account, for the AI (S25, mulloSessionStore). */
    @JavascriptInterface
    fun saveMulloSession(json: String) = Cloud.saveMulloSession(ctx, json)

    @JavascriptInterface
    fun loadMulloSession(): String = Cloud.loadMulloSession(ctx)

    @JavascriptInterface
    fun clearMulloSession() = Cloud.clearMulloSession(ctx)

    /** Task reminders (S47, Reminders.kt): the whole list, after every change. */
    @JavascriptInterface
    fun setReminders(json: String) = Reminders.save(ctx, json)

    /** Done / Snooze tapped on reminders, waiting to be written by the web code. */
    @JavascriptInterface
    fun reminderTaps(): String = Reminders.taps(ctx)

    @JavascriptInterface
    fun reminderTapsDone(json: String) = Reminders.tapsDone(ctx, json)

    @JavascriptInterface
    fun exactAlarmsAllowed(): Boolean = Reminders.exactAllowed(ctx)

    @JavascriptInterface
    fun askExactAlarms() = Reminders.askExact(ctx)

    /** Last 4 characters only; the screens never need more to show which key it is. */
    @JavascriptInterface
    fun proKeyHint(): String = Bridge.proKey(ctx)?.takeLast(4) ?: ""

    /** Language, names list and summary format, so watch notes can be made ready
     *  with Mullo closed (WatchAi). Not secret; capped in size. */
    @JavascriptInterface
    fun setAiPrefs(json: String): Boolean = WatchAi.setPrefs(ctx, json)

    /** The phone's share sheet (WebView has no navigator.share). Mullo itself is
     *  left out: its own share target changes the bridge address. */
    @JavascriptInterface
    fun shareText(title: String, text: String) {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, title.take(200))
            putExtra(Intent.EXTRA_TEXT, text.take(MAX_SHARE))
        }
        val chooser = Intent.createChooser(send, title.take(200)).apply {
            putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, arrayOf(ComponentName(ctx, MainActivity::class.java)))
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        ctx.startActivity(chooser)
    }

    /** A long share (a meeting's transcript): messaging apps cut long text (Telegram at
     *  4,096 characters, WhatsApp around 65,000), so the whole text goes as a .txt file and
     *  `caption` (summary + tasks) as the message. Only the previous share's file is kept. */
    @JavascriptInterface
    fun shareTextFile(title: String, caption: String, text: String) {
        val dir = File(ctx.cacheDir, "share").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val name = title.replace(Regex("[^\\p{L}\\p{N} _-]+"), " ").trim().take(60).ifEmpty { "Mullo note" }
        val file = File(dir, "$name.txt")
        file.writeText(text)
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.share", file)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, title.take(200))
            putExtra(Intent.EXTRA_TEXT, caption.take(MAX_SHARE))
            putExtra(Intent.EXTRA_STREAM, uri)
            clipData = ClipData.newRawUri(name, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(send, title.take(200)).apply {
            putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, arrayOf(ComponentName(ctx, MainActivity::class.java)))
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        ctx.startActivity(chooser)
    }

    /** A task → the phone's calendar app with the event filled in (all day on `date`,
     *  YYYY-MM-DD). The person saves it there, so Mullo needs no calendar permission.
     *  → false when the date isn't one or no calendar app answers. */
    @JavascriptInterface
    fun addToCalendar(title: String, description: String, date: String): Boolean {
        val m = Regex("^(\\d{4})-(\\d{2})-(\\d{2})$").find(date) ?: return false
        val (y, mo, d) = m.destructured
        // All-day events are stored at UTC midnight.
        val start = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { clear(); set(y.toInt(), mo.toInt() - 1, d.toInt()) }.timeInMillis
        val insert = Intent(Intent.ACTION_INSERT).apply {
            data = CalendarContract.Events.CONTENT_URI
            putExtra(CalendarContract.Events.TITLE, title.take(500))
            if (description.isNotBlank()) putExtra(CalendarContract.Events.DESCRIPTION, description.take(5_000))
            putExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, true)
            putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, start)
            putExtra(CalendarContract.EXTRA_EVENT_END_TIME, start + 86_400_000L)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return try { ctx.startActivity(insert); true } catch (_: ActivityNotFoundException) { false }
    }

    @JavascriptInterface
    fun copyText(text: String) {
        val clip = ctx.getSystemService(ClipboardManager::class.java) ?: return
        clip.setPrimaryClip(ClipData.newPlainText("Mullo", text.take(MAX_SHARE)))
    }

    private companion object {
        /** An intent over ~1 MB fails (UTF-16, so 2 bytes a character). */
        const val MAX_SHARE = 200_000
    }
}

/** `MulloWatch` in the web code (app/capture/watch-inbox.js). */
class MulloWatchJs(private val ctx: Context) {
    @JavascriptInterface
    fun list(): String = Inbox.pending(ctx).toString()

    @JavascriptInterface
    fun done(id: String) = Inbox.release(ctx, id)
}
