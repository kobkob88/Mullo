package app.mullo.phone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.ServiceCompat

/**
 * "Mullo is recording": a foreground service of type microphone for as long as the web
 * app records (MulloNative.recordingStarted / recordingStopped, app/ui/panels/record.js).
 * The WebView still does the recording; this only keeps the mic and the CPU on. Without
 * it Android hands an app that isn't on screen silence from the mic, so a locked phone
 * recorded nothing. Android 14+ lets it start only while Mullo is on screen, which is
 * the only way it starts (the Record button). Same idea as the watch's RecorderService.
 */
class MicService : Service() {

    companion object {
        private const val CHANNEL = "recording"
        private const val NOTIFY_ID = 20 // 7 and 8 are the watch-note notifications
        private const val MAX_WAKE_MS = 4 * 3_600_000L // a stop that never comes can't hold the CPU forever

        /** → "ok", or why the mic can't be kept on (the recording still runs while Mullo is open). */
        fun start(ctx: Context): String = try {
            ctx.startForegroundService(Intent(ctx, MicService::class.java))
            "ok"
        } catch (e: Exception) {
            e.message ?: "Could not keep the microphone on"
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, MicService::class.java))
        }
    }

    private var wake: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Recording", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val n = Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Mullo is recording")
            .setContentText("Tap to open Mullo")
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        ServiceCompat.startForeground(this, NOTIFY_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        if (wake == null) {
            wake = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "mullo:recording")
                .apply { acquire(MAX_WAKE_MS) }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        wake?.let { if (it.isHeld) it.release() }
        wake = null
        super.onDestroy()
    }
}
