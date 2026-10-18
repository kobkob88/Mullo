package app.mullo.wear

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.ServiceCompat
import org.json.JSONObject

/**
 * Keeps the recording going with the screen off: a foreground service of type "microphone".
 * Android 14+ only lets this start while the app is on screen, which is the only way we start
 * it (the Record button, the double press, the watch-face button). The recording itself is
 * Capture's; the double press starts Capture before this service runs, so the mic doesn't
 * wait for it.
 */
class RecorderService : Service() {

    companion object {
        const val ACTION_START = "start"
        const val ACTION_STOP = "stop"
        private const val CHANNEL = "recording"

        val running get() = Capture.running
        val startedElapsed get() = Capture.startedElapsed
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> start()
            ACTION_STOP -> stop()
        }
        return START_NOT_STICKY
    }

    private fun start() {
        // startForegroundService must always end in startForeground, even if the mic then fails.
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Recording", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val n = Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Mullo is recording")
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        ServiceCompat.startForeground(this, 1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        if (!Capture.start(this)) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun stop() {
        val done = Capture.stop(this)
        if (done == null) {
            stopSelf()
            return
        }
        Buzz.stopped(this)

        val part = Proto.part(this, done.id)
        val audio = Proto.audio(this, done.id)
        if (done.ok && part.renameTo(audio)) {
            val batteryEnd = Proto.battery(this)
            val meta = JSONObject()
                .put("id", done.id)
                .put("size", audio.length())
                .put("sha256", Proto.sha256(audio))
                .put("duration_ms", done.durationMs)
                .put("started_at", done.startedWall)
                .put("battery_start", done.batteryStart)
                .put("battery_end", batteryEnd)
            Proto.meta(this, done.id).writeText(meta.toString())
            SpikeLog.line(
                this,
                "■ saved ${done.durationMs / 1000}s, ${audio.length() / 1024} KB, battery ${done.batteryStart}→$batteryEnd%",
            )
        } else {
            SpikeLog.line(this, "✗ could not finish file ${done.id}")
        }
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
        Sender.sendAllAsync(applicationContext)
    }

    override fun onDestroy() {
        // Ended by the system mid-recording: close the file whole, kept as a .part file (as before).
        if (Capture.running) Capture.stop(this)
        super.onDestroy()
    }
}
