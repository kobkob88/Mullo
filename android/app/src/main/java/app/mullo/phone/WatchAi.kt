package app.mullo.phone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.os.Build
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteOrder
import java.time.LocalDate
import java.util.UUID
import kotlin.math.log10
import kotlin.math.sqrt

/**
 * A watch note, made ready while Mullo is closed (owner, 2026-10-06: "when I stop
 * the recording it should transcribe right away, and when I open the app it's
 * all ready"). The same calls the web app makes - a transcription job
 * (send now, collect later), then /api/process - to the same Worker (or the PC
 * bridge), with the same settings the web app handed over (setAiPrefs), paid by
 * a Mullo Pro key, the person's own AI key, or the sign-in's plan (S12). The
 * result waits next to the audio as <id>.ai.json; the web app saves it into the
 * library without calling the AI again. A job sent but not collected yet waits
 * as <id>.ai.job: the next try, or the web app, collects it instead of sending
 * the audio again. Anything else that goes wrong leaves no result, and the web
 * app does the work itself when opened - nothing is lost either way.
 */
object WatchAi {
    private const val TAG = "Mullo"
    private const val PREFS = "mullo"
    private const val AI_PREFS = "ai_prefs"
    private const val CHANNEL = "watch"
    private const val NOTIFY_ID = 7
    /** A job older than this is assumed dead; the web app takes the note over. */
    const val STALE_MS = 5 * 60_000L

    fun result(ctx: Context, id: String) = File(Inbox.dir(ctx), "$id.ai.json")
    fun lock(ctx: Context, id: String) = File(Inbox.dir(ctx), "$id.ai.lock")
    /** {id, language, target}: a transcription job the server has, not collected yet. */
    fun job(ctx: Context, id: String) = File(Inbox.dir(ctx), "$id.ai.job")

    /** S45: worker/src/jobs.mjs KEEP_CHOICES; anything else is never sent. */
    private val KEEP_CHOICES = setOf("collected", "1h", "6h", "24h")
    private const val POLL_MS = 3_000L
    /** WorkManager stops a job at 10 minutes; past this, the next try (or the app) collects it. */
    private const val COLLECT_FOR_MS = 7 * 60_000L

    private class HttpError(val code: Int, path: String) : Exception("$path → $code")

    /** Not secret: language, names list, summary format. Set by the web app. */
    fun setPrefs(ctx: Context, json: String): Boolean {
        if (json.length > 64_000) return false
        val ok = runCatching { JSONObject(json) }.isSuccess
        if (ok) ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(AI_PREFS, json).apply()
        return ok
    }

    private fun prefs(ctx: Context): JSONObject? =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(AI_PREFS, null)?.let { runCatching { JSONObject(it) }.getOrNull() }

    /** Only when there is somewhere to send it and the web app has said how. */
    fun canRun(ctx: Context) = Bridge.watchUrl(ctx) != null && prefs(ctx) != null

    /** The Authorization for this call: the Mullo sign-in (Mullo's Worker only; S25, a Pro key or
     *  own AI key still pays, the sign-in says who). The Pro key alone only if there's no token,
     *  for a Worker from before S25's sign-in gate. */
    private fun bearer(ctx: Context, base: String): String? =
        if (base == Bridge.PRO_URL) Cloud.accessToken(ctx) ?: Bridge.proKey(ctx) else null

    fun enqueue(ctx: Context, id: String) {
        val req = OneTimeWorkRequestBuilder<WatchAiJob>()
            .setInputData(workDataOf("id" to id))
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .build()
        WorkManager.getInstance(ctx).enqueueUniqueWork("watch-ai-$id", ExistingWorkPolicy.KEEP, req)
    }

    /** true = done (a result or nothing to do), false = try again later. */
    fun run(ctx: Context, id: String): Boolean {
        val audio = Inbox.audio(ctx, id)
        if (!audio.exists() || result(ctx, id).exists()) return true // already taken, or already done
        val base = Bridge.watchUrl(ctx) ?: return true
        val p = prefs(ctx) ?: return true
        val ownKey = Bridge.ownKey(ctx)
        if (base == Bridge.PRO_URL) {
            // Not signed in to Mullo (S25): the note waits for the app, which asks for a sign-in.
            if (!Cloud.hasMulloSession(ctx)) return true
            // Signed in, with no token right now (offline while it ran out): try later.
            if (Cloud.accessToken(ctx) == null) return false
        }
        lock(ctx, id).writeText(System.currentTimeMillis().toString())
        try {
            val meta = Inbox.received(ctx, id).takeIf { it.exists() }?.readText()?.let(::JSONObject) ?: JSONObject()
            val durationMs = meta.optLong("duration_ms", 0)

            // The speech map travels with the audio; only the levels are kept with the note.
            val check = Silence.check(audio)
            val ranges = check.remove("ranges") as? JSONArray
            if (check.optBoolean("checked") && !check.optBoolean("speech")) {
                write(ctx, id, JSONObject().put("state", "silent").put("check", check))
                notify(ctx, "No speech heard in your watch note", "Nothing was sent to the AI.")
                return true
            }

            val listen = p.optString("listen").takeIf { it.isNotBlank() && it != "auto" }
            val target = p.optString("target").takeIf { it.isNotBlank() && it != "null" }
            val vocabulary = p.optJSONArray("vocabulary") ?: JSONArray()
            // Names go in the body, never the URL (a URL ends up in request logs).
            val options = JSONObject()
                .put("lang", listen ?: JSONObject.NULL)
                .put("out", target ?: JSONObject.NULL)
                .put("vocabulary", JSONArray().also { a -> for (i in 0 until minOf(vocabulary.length(), 60)) a.put(vocabulary.optString(i)) })
                .put("duration_ms", if (durationMs > 0) durationMs else JSONObject.NULL)
                .put("mime", "audio/mp4")
                .put("speech", if (ranges != null && check.optLong("audioMs") > 0)
                    JSONObject().put("ranges", ranges).put("duration_ms", check.optLong("audioMs")) else JSONObject.NULL)
            // S45: how long Mullo's server keeps the result (the web app's setting). Only the
            // Worker's list; left out otherwise (the server's default, a day).
            val keep = p.optString("keep").takeIf { it in KEEP_CHOICES }
            keep?.let { options.put("keep", it) }
            val boundary = "mullo" + UUID.randomUUID().toString().replace("-", "")
            val form = ByteArrayOutputStream().apply {
                fun text(s: String) = write(s.toByteArray(Charsets.UTF_8))
                text("--$boundary\r\nContent-Disposition: form-data; name=\"options\"\r\nContent-Type: application/json\r\n\r\n")
                text(options.toString())
                text("\r\n--$boundary\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"audio\"\r\nContent-Type: audio/mp4\r\n\r\n")
                write(audio.readBytes())
                text("\r\n--$boundary--\r\n")
            }.toByteArray()

            val (transcript, jobId) = transcribe(ctx, id, base, "multipart/form-data; boundary=$boundary", form, ownKey, listen, target)
            // S45 "as soon as my phone has it": the server forgets the job once the result is
            // written here, never on the first read (a reply lost on weak Wi-Fi would lose it).
            val gotIt = { if (keep == "collected" && jobId != null) release(ctx, base, jobId, ownKey) }
            val segments = transcript.optJSONArray("segments") ?: JSONArray()
            if (segments.length() == 0) {
                write(ctx, id, JSONObject().put("state", "silent").put("check", check))
                gotIt()
                notify(ctx, "No speech heard in your watch note", "Nothing came back from the AI.")
                return true
            }
            val language = target ?: listen
            val body = JSONObject()
                .put("segments", segments)
                .put("template", p.opt("template") ?: "general")
                .put("language", language ?: JSONObject.NULL)
                .put("today", LocalDate.now().toString())
                .put("vocabulary", vocabulary)
            val processed = post(base, "/api/process", bearer(ctx, base), "application/json", body.toString().toByteArray(), ownKey)

            if (!audio.exists()) return true // the app took it meanwhile; it did its own
            write(ctx, id, JSONObject()
                .put("state", "done")
                .put("check", check)
                .put("template_id", p.optString("template_id", "general"))
                .put("transcript", JSONObject().put("segments", segments).put("language", language ?: JSONObject.NULL)
                    .put("engine", transcript.optString("engine", "ai")))
                .put("processed", processed))
            gotIt()
            val tasks = processed.optJSONArray("actions")?.let { a -> (0 until a.length()).map { a.optJSONObject(it)?.optString("label").orEmpty() } } ?: emptyList()
            val title = processed.optString("title").ifBlank { "Watch note" }
            notify(ctx, "Ready: $title",
                if (tasks.isEmpty()) "No tasks in it." else "${tasks.size} task${if (tasks.size > 1) "s" else ""}: ${tasks.joinToString(" · ")}")
            return true
        } catch (e: HttpError) {
            Log.i(TAG, "watch note $id: AI refused (${e.message})")
            // Signed out, no plan or minutes left, not allowed: trying again won't change it.
            // The web app does the note when opened, and says why if it still can't.
            if (e.code in 400..499 && e.code != 408 && e.code != 429) {
                notify(ctx, "Recording from your watch", "Open Mullo to transcribe it.")
                return true
            }
            return false
        } catch (e: Exception) {
            Log.i(TAG, "watch note $id: AI not reached (${e.message})")
            return false
        } finally {
            lock(ctx, id).delete()
            // Mullo open now → let it pick the result (or the note) up straight away.
            MainActivity.onWatchRecording?.invoke()
        }
    }

    private fun write(ctx: Context, id: String, json: JSONObject) {
        val tmp = File(Inbox.dir(ctx), "$id.ai.json.part")
        tmp.writeText(json.toString())
        tmp.renameTo(result(ctx, id))
    }

    /**
     * Send now, collect later (worker/src/jobs.mjs), like the web app's remote engine: the audio
     * goes up once and the server works on it whatever the signal does. A job from an earlier
     * try with the same languages is collected first. A server without jobs (the PC bridge)
     * answers 404 and gets the one request held open instead.
     * → the transcript, and the server's job id (null for the one-request way).
     */
    private fun transcribe(ctx: Context, id: String, base: String, type: String, form: ByteArray, ownKey: String?,
                           listen: String?, target: String?): Pair<JSONObject, String?> {
        val ticket = job(ctx, id)
        val earlier = ticket.takeIf { it.exists() }?.let { runCatching { JSONObject(it.readText()) }.getOrNull() }
            ?.takeIf { it.opt("language") == (listen ?: JSONObject.NULL) && it.opt("target") == (target ?: JSONObject.NULL) }
            ?.optString("id")?.takeIf { it.isNotBlank() }
        if (earlier != null) collect(ctx, id, base, earlier, ownKey)?.let { ticket.delete(); return it to earlier }
        ticket.delete()

        val started = try {
            post(base, "/api/transcribe/jobs", bearer(ctx, base), type, form, ownKey)
        } catch (e: HttpError) {
            if (e.code != 404) throw e
            return post(base, "/api/transcribe", bearer(ctx, base), type, form, ownKey) to null
        }
        val jobId = started.optString("job").ifBlank { throw IllegalStateException("no job id") }
        val tmp = File(Inbox.dir(ctx), "$id.ai.job.part")
        tmp.writeText(JSONObject().put("id", jobId).put("language", listen ?: JSONObject.NULL)
            .put("target", target ?: JSONObject.NULL).toString())
        tmp.renameTo(ticket)
        val out = collect(ctx, id, base, jobId, ownKey) ?: throw IllegalStateException("the server lost the transcription")
        ticket.delete()
        return out to jobId
    }

    /** S45 "got it": DELETE on the same job path, same sign-in. Best effort: if it doesn't
     *  arrive, the server forgets the result after an hour anyway. */
    private fun release(ctx: Context, base: String, jobId: String, ownKey: String?) {
        runCatching { request(base, "/api/transcribe/jobs/$jobId", bearer(ctx, base), null, null, ownKey, "DELETE") }
            .onFailure { Log.i(TAG, "job $jobId: \"got it\" not sent (${it.message}); the server forgets it within the hour") }
    }

    /** The job's transcript, or null when the server no longer has it. Throws while it's still
     *  working past COLLECT_FOR_MS (the ticket stays), or when the job failed (it doesn't). */
    private fun collect(ctx: Context, id: String, base: String, jobId: String, ownKey: String?): JSONObject? {
        val until = System.currentTimeMillis() + COLLECT_FOR_MS
        while (System.currentTimeMillis() < until) {
            Thread.sleep(POLL_MS)
            lock(ctx, id).writeText(System.currentTimeMillis().toString()) // still working: the app keeps waiting
            val status = try {
                request(base, "/api/transcribe/jobs/$jobId", bearer(ctx, base), null, null, ownKey)
            } catch (e: HttpError) {
                if (e.code == 404) return null
                if (e.code >= 500) continue
                throw e
            } catch (e: java.io.IOException) {
                continue // signal dropped: the server keeps working, ask again
            }
            when (status.optString("state")) {
                "done" -> status.optJSONObject("result")?.takeIf { it.has("segments") }?.let { return it }
                "failed" -> { job(ctx, id).delete(); throw IllegalStateException(status.optString("error", "transcription failed")) }
            }
        }
        throw IllegalStateException("still transcribing; collected on the next try")
    }

    private fun post(base: String, path: String, key: String?, type: String, body: ByteArray, ownKey: String? = null) =
        request(base, path, key, type, body, ownKey)

    private fun request(base: String, path: String, key: String?, type: String?, body: ByteArray?, ownKey: String?,
                        method: String? = null): JSONObject {
        val conn = URL(base + path).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method ?: if (body != null) "POST" else "GET"
            conn.connectTimeout = 20_000
            // Only the PC bridge's one-request route holds the answer until the whole transcript
            // is written (minutes for a meeting). The job itself must end within 10.
            conn.readTimeout = 8 * 60_000
            if (key != null) conn.setRequestProperty("Authorization", "Bearer $key")
            // The person's own AI key (sealed by Mullo's server): their AI company bills them, no minutes.
            ownKey?.let { conn.setRequestProperty("X-Mullo-Own-Key", it) }
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", type)
                conn.outputStream.use { it.write(body) }
            }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (code !in 200..299) throw HttpError(code, path)
            return if (text.isBlank()) JSONObject() else JSONObject(text) // 204: no body

        } finally {
            conn.disconnect()
        }
    }

    fun notify(ctx: Context, title: String, text: String) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "From your watch", NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(
            ctx, 0, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(title.take(120))
            .setContentText(text.take(200))
            .setStyle(Notification.BigTextStyle().bigText(text.take(600)))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        runCatching { nm.notify(NOTIFY_ID, n) }
    }

    fun foregroundInfo(ctx: Context): ForegroundInfo {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "From your watch", NotificationManager.IMPORTANCE_DEFAULT))
        val n = Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Transcribing your watch note")
            .build()
        return if (Build.VERSION.SDK_INT >= 29) ForegroundInfo(NOTIFY_ID + 1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else ForegroundInfo(NOTIFY_ID + 1, n)
    }
}

/** WorkManager runs it soon after the note lands, with a network, even with Mullo closed. */
class WatchAiJob(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        val id = inputData.getString("id") ?: return Result.success()
        if (!Inbox.validId(id)) return Result.success()
        if (WatchAi.run(applicationContext, id)) return Result.success()
        if (runAttemptCount < 2) return Result.retry()
        WatchAi.notify(applicationContext, "Recording from your watch", "Open Mullo to transcribe it.")
        return Result.success()
    }

    /** Only used where an expedited job must run as a short foreground service (Android 11). */
    override fun getForegroundInfo(): ForegroundInfo = WatchAi.foregroundInfo(applicationContext)
}

/**
 * Is there speech in the note? The same measure as the web app's
 * capture/silence.js (keep the numbers in step): 50 ms windows, a window counts
 * when it is 12 dB over the room's noise (10th percentile) and at least -55 dBFS,
 * 0.4 s of those in total is speech. Any doubt = speech.
 * Only watch notes come here, so the first 0.4 s (the watch's "mic is on" buzz) and
 * the last 0.3 s (the tap on Stop) don't count as speech (WATCH_EDGES in silence.js).
 * Also the speech map (ranges): where sound was heard, sounds under 1 s apart
 * joined. Unlike the web app it checks notes of any length: it decodes as a
 * stream and keeps only one level per 50 ms.
 */
object Silence {
    private const val WINDOW_MS = 50
    private const val ABOVE_FLOOR_DB = 12.0
    private const val MIN_LOUD_DB = -55.0
    private const val MIN_SPEECH_MS = 400
    private const val JOIN_MS = 1000
    private const val DECODE_LIMIT_MS = 120_000L
    private const val WATCH_START_MS = 400
    private const val WATCH_END_MS = 300

    private fun unsure() = JSONObject().put("speech", true).put("checked", false)

    fun check(file: File): JSONObject {
        return runCatching { decodeLevels(file)?.let { judge(it, WATCH_START_MS, WATCH_END_MS) } ?: unsure() }
            .getOrElse { unsure() }
    }

    fun judge(levels: List<Double>, skipStartMs: Int = 0, skipEndMs: Int = 0): JSONObject {
        if (levels.isEmpty()) return JSONObject().put("speech", false).put("checked", true).put("speechMs", 0)
            .put("audioMs", 0).put("ranges", JSONArray())
        val sorted = levels.sorted()
        val floor = sorted[(sorted.size * 0.1).toInt()]
        val peak = sorted.last()
        val ranges = JSONArray()
        var start = -1
        var end = -1
        val countTo = levels.size * WINDOW_MS - skipEndMs
        var loud = 0
        levels.forEachIndexed { i, l ->
            if (l < MIN_LOUD_DB || l < floor + ABOVE_FLOOR_DB) return@forEachIndexed
            val at = i * WINDOW_MS
            if (at >= skipStartMs && at + WINDOW_MS <= countTo) loud += 1
            if (start >= 0 && at - end < JOIN_MS) end = at + WINDOW_MS
            else {
                if (start >= 0) ranges.put(JSONArray().put(start).put(end))
                start = at
                end = at + WINDOW_MS
            }
        }
        if (start >= 0) ranges.put(JSONArray().put(start).put(end))
        val speechMs = loud * WINDOW_MS
        fun r(x: Double): Any = if (x.isFinite()) Math.round(x * 10) / 10.0 else JSONObject.NULL
        return JSONObject().put("speech", speechMs >= MIN_SPEECH_MS).put("checked", true)
            .put("speechMs", speechMs).put("floorDb", r(floor)).put("peakDb", r(peak))
            .put("audioMs", levels.size * WINDOW_MS).put("ranges", ranges)
    }

    /** dBFS of each 50 ms of the first channel, or null if it can't be decoded. */
    private fun decodeLevels(file: File): List<Double>? {
        val ex = MediaExtractor()
        try {
            ex.setDataSource(file.path)
            val track = (0 until ex.trackCount).firstOrNull {
                ex.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
            } ?: return null
            ex.selectTrack(track)
            val format = ex.getTrackFormat(track)
            val codec = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
            codec.configure(format, null, null, 0)
            codec.start()
            var rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            var channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            val levels = ArrayList<Double>()
            var sum = 0.0
            var count = 0
            var window = rate * WINDOW_MS / 1000
            val info = MediaCodec.BufferInfo()
            var inputDone = false
            var outputDone = false
            val deadline = System.currentTimeMillis() + DECODE_LIMIT_MS
            try {
                while (!outputDone && System.currentTimeMillis() < deadline) {
                    if (!inputDone) {
                        val i = codec.dequeueInputBuffer(10_000)
                        if (i >= 0) {
                            val n = ex.readSampleData(codec.getInputBuffer(i)!!, 0)
                            if (n < 0) {
                                codec.queueInputBuffer(i, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                                inputDone = true
                            } else {
                                codec.queueInputBuffer(i, 0, n, ex.sampleTime, 0)
                                ex.advance()
                            }
                        }
                    }
                    val o = codec.dequeueOutputBuffer(info, 10_000)
                    if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        rate = codec.outputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                        channels = codec.outputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                        window = rate * WINDOW_MS / 1000
                    } else if (o >= 0) {
                        val buf = codec.getOutputBuffer(o)!!.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
                        val frames = buf.remaining() / channels
                        for (f in 0 until frames) {
                            val s = buf.get(f * channels) / 32768.0
                            sum += s * s
                            count += 1
                            if (count == window) {
                                val rms = sqrt(sum / count)
                                levels.add(if (rms > 0) 20 * log10(rms) else Double.NEGATIVE_INFINITY)
                                sum = 0.0
                                count = 0
                            }
                        }
                        codec.releaseOutputBuffer(o, false)
                        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outputDone = true
                    }
                }
            } finally {
                codec.stop()
                codec.release()
            }
            return if (outputDone) levels else null
        } finally {
            ex.release()
        }
    }
}
