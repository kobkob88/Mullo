package app.mullo.wear

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.media.MediaRecorder
import android.os.PowerManager
import android.os.Process
import android.os.SystemClock
import java.io.File
import java.io.IOException

/**
 * The microphone → an .m4a file (AAC-LC, 16 kHz mono, 32 kbps: the same file MediaRecorder made,
 * so the phone, the silence check and the AI see no difference).
 *
 * Why not MediaRecorder (owner, 2026-10-14: "the record starts a second later"): MediaRecorder
 * opens the mic only after its MP4 writer is ready, and on a Galaxy Watch that took 0.005-0.84 s
 * depending on storage load. Here the mic opens first (AudioRecord, ~0.05 s) and buzzes; the
 * encoder and the file get ready on their own thread while the sound waits in AudioRecord's
 * buffer (BUFFER_SECONDS), so nothing said right after the buzz is lost.
 *
 * Started from QuickRecordActivity (on screen, so the mic is allowed) before its window draws,
 * or from RecorderService (the Record button). The foreground service keeps it going after.
 * One recording at a time; state lives here, not in the service.
 */
object Capture {
    private const val RATE = 16_000
    private const val BIT_RATE = 32_000
    private const val BUFFER_SECONDS = 6
    private const val CHUNK_BYTES = 4096 // 128 ms of 16-bit mono
    private const val MAX_HOURS = 4L

    @Volatile var running = false
        private set
    @Volatile var startedElapsed = 0L
        private set

    class Finished(val id: String, val durationMs: Long, val startedWall: Long, val batteryStart: Int, val ok: Boolean)

    private var record: AudioRecord? = null
    private var worker: Thread? = null
    private var wake: PowerManager.WakeLock? = null
    private var id: String? = null
    private var startedWall = 0L
    private var batteryStart = -1
    @Volatile private var stopAsked = false
    @Volatile private var samples = 0L
    @Volatile private var saved = false

    /** true = the microphone is on (and the wrist buzzed). Call on the main thread. */
    @SuppressLint("MissingPermission") // checked just below
    @Synchronized
    fun start(ctx: Context): Boolean {
        if (running) return true
        val app = ctx.applicationContext
        if (app.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return false
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val r = try {
            AudioRecord(
                MediaRecorder.AudioSource.MIC, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                maxOf(min, RATE * 2 * BUFFER_SECONDS),
            )
        } catch (e: Exception) {
            return failed(app, "✗ could not open the mic: ${e.message}")
        }
        if (r.state != AudioRecord.STATE_INITIALIZED) {
            r.release()
            return failed(app, "✗ could not open the mic")
        }
        try {
            r.startRecording()
        } catch (e: IllegalStateException) {
            r.release()
            return failed(app, "✗ could not start: ${e.message}")
        }
        if (r.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
            r.release()
            return failed(app, "✗ the mic did not start (in use?)")
        }

        val newId = Proto.newId()
        record = r
        id = newId
        samples = 0
        saved = false
        stopAsked = false
        startedWall = System.currentTimeMillis()
        startedElapsed = SystemClock.elapsedRealtime()
        running = true
        // The buzz means "the microphone is on now" (owner, 2026-10-09).
        Buzz.started(app)
        wake = app.getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "mullo:recording")
            .apply { acquire(MAX_HOURS * 3_600_000) }
        worker = Thread({ encode(app, r, Proto.part(app, newId)) }, "mullo-encode").apply { start() }
        RecordComplicationService.refresh(app)
        batteryStart = Proto.battery(app)
        SpikeLog.line(app, "● recording $newId (battery $batteryStart%)")
        return true
    }

    /** Stops, finishes the file (the moov box is written here) and says how it went; null = wasn't recording. */
    @Synchronized
    fun stop(ctx: Context): Finished? {
        val r = record ?: return null
        stopAsked = true
        runCatching { r.stop() } // the worker reads what is left in the buffer, then ends the file
        worker?.join(15_000)
        r.release()
        wake?.let { if (it.isHeld) it.release() }
        record = null
        worker = null
        wake = null
        running = false
        RecordComplicationService.refresh(ctx.applicationContext)
        return Finished(id!!, samples * 1000 / RATE, startedWall, batteryStart, saved && samples > 0)
    }

    private fun failed(ctx: Context, why: String): Boolean {
        SpikeLog.line(ctx, why)
        Buzz.failed(ctx)
        return false
    }

    // Mic → AAC encoder → MP4. Blocking reads while recording; once stop is asked, reads
    // without waiting until the buffer is empty, then marks the end so the file is closed whole.
    private fun encode(ctx: Context, r: AudioRecord, out: File) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        var codec: MediaCodec? = null
        var muxer: MediaMuxer? = null
        var track = -1
        val info = MediaCodec.BufferInfo()
        val pcm = ByteArray(CHUNK_BYTES)
        try {
            val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, RATE, 1).apply {
                setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                setInteger(MediaFormat.KEY_BIT_RATE, BIT_RATE)
                setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, CHUNK_BYTES)
            }
            codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC).apply {
                configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                start()
            }
            muxer = MediaMuxer(out.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            var inputDone = false
            var outputDone = false
            while (!outputDone) {
                if (!inputDone) {
                    val ix = codec.dequeueInputBuffer(10_000)
                    if (ix >= 0) {
                        val buf = codec.getInputBuffer(ix)!!
                        buf.clear()
                        val ending = stopAsked
                        var n = r.read(pcm, 0, minOf(buf.remaining(), CHUNK_BYTES),
                            if (ending) AudioRecord.READ_NON_BLOCKING else AudioRecord.READ_BLOCKING)
                        if (n < 0) {
                            // Once stopping, a refusing mic only means "nothing left": close the file whole.
                            if (!ending) throw IOException("mic read failed ($n)")
                            n = 0
                        }
                        buf.put(pcm, 0, n)
                        val last = ending && n == 0
                        codec.queueInputBuffer(ix, 0, n, samples * 1_000_000 / RATE, if (last) MediaCodec.BUFFER_FLAG_END_OF_STREAM else 0)
                        samples += n / 2
                        inputDone = last
                    }
                }
                while (true) {
                    val ox = codec.dequeueOutputBuffer(info, if (inputDone) 10_000 else 0)
                    if (ox == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        track = muxer.addTrack(codec.outputFormat)
                        muxer.start()
                    } else if (ox >= 0) {
                        val ob = codec.getOutputBuffer(ox)!!
                        if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) info.size = 0
                        if (info.size > 0 && track >= 0) {
                            ob.position(info.offset)
                            ob.limit(info.offset + info.size)
                            muxer.writeSampleData(track, ob, info)
                        }
                        codec.releaseOutputBuffer(ox, false)
                        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
                            outputDone = true
                            break
                        }
                    } else {
                        break // nothing ready yet (or, once ending, try again)
                    }
                }
            }
            if (track >= 0) {
                muxer.stop()
                saved = true
            }
        } catch (e: Exception) {
            SpikeLog.line(ctx, "✗ recording broke: ${e.message}")
            Buzz.failed(ctx)
        } finally {
            runCatching { codec?.stop() }
            runCatching { codec?.release() }
            runCatching { muxer?.release() }
        }
    }
}
