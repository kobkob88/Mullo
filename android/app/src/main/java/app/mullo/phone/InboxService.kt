package app.mullo.phone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.util.Log
import com.google.android.gms.wearable.ChannelClient
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.WearableListenerService
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * Receives recordings from the watch into app-private inbox/, checks size + sha256,
 * and only then tells the watch it may delete its copy. Never touches the network
 * itself; the AI work after it runs as a separate job (WatchAi).
 * The Data Layer only connects apps with this package name AND signing key, so
 * only our own watch app can send here.
 */
class InboxService : WearableListenerService() {

    companion object {
        private const val TAG = "Mullo"
        private const val CHANNEL = "watch"
        private const val NOTIFY_ID = 7
        private val openedAt = ConcurrentHashMap<String, Long>()
    }

    override fun onMessageReceived(event: MessageEvent) {
        if (event.path != Inbox.PATH_OFFER) return
        val meta = JSONObject(String(event.data))
        val id = meta.optString("id")
        if (Inbox.parseFilePath("${Inbox.PATH_FILE}$id/0/x") == null) return
        Inbox.offer(this, id).writeText(meta.toString())
    }

    override fun onChannelOpened(channel: ChannelClient.Channel) {
        val (id, size, _) = Inbox.parseFilePath(channel.path) ?: return
        if (Inbox.audio(this, id).exists()) {
            // Already have it (an earlier ack got lost): confirm again, don't re-receive.
            Wearable.getChannelClient(this).close(channel)
            ack(channel.nodeId, id, ok = true, ms = 0, reason = "already here")
            return
        }
        openedAt[channel.path] = SystemClock.elapsedRealtime()
        Log.i(TAG, "← receiving $id (${size / 1024} KB)")
        Wearable.getChannelClient(this).receiveFile(channel, Uri.fromFile(Inbox.part(this, id)), false)
    }

    override fun onInputClosed(channel: ChannelClient.Channel, closeReason: Int, appSpecificErrorCode: Int) {
        val (id, size, sha) = Inbox.parseFilePath(channel.path) ?: return
        val ms = SystemClock.elapsedRealtime() - (openedAt.remove(channel.path) ?: SystemClock.elapsedRealtime())
        val part = Inbox.part(this, id)
        val reason = when {
            closeReason != ChannelClient.ChannelCallback.CLOSE_REASON_NORMAL -> "channel closed ($closeReason)"
            !part.exists() -> "no file"
            part.length() != size -> "size ${part.length()} ≠ $size"
            Inbox.sha256(part) != sha -> "hash mismatch"
            !part.renameTo(Inbox.audio(this, id)) -> "could not keep the file"
            else -> null
        }
        if (reason != null) {
            part.delete()
            Log.i(TAG, "✗ $id: $reason")
            ack(channel.nodeId, id, ok = false, ms = ms, reason = reason)
            return
        }
        val offer = Inbox.offer(this, id).takeIf { it.exists() }?.readText()?.let(::JSONObject) ?: JSONObject()
        val received = offer.put("id", id).put("size", size).put("transfer_ms", ms)
            .put("received_at", System.currentTimeMillis())
        Inbox.received(this, id).writeText(received.toString())
        Inbox.offer(this, id).delete()
        ack(channel.nodeId, id, ok = true, ms = ms, reason = null)
        // Mullo open → it takes the recording now. Closed → the transcript and
        // summary are made in the background (WatchAi) and a notification says
        // when they're ready; without an AI to reach, a notification opens Mullo.
        when {
            MainActivity.onWatchRecording?.invoke() == true -> Unit
            WatchAi.canRun(this) -> WatchAi.enqueue(this, id)
            else -> notifyArrived(offer.optLong("duration_ms"))
        }
    }

    private fun notifyArrived(durationMs: Long) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "From your watch", NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val s = durationMs / 1000
        val n = Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Recording from your watch")
            .setContentText("%d:%02d · open Mullo to transcribe it".format(s / 60, s % 60))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        runCatching { nm.notify(NOTIFY_ID, n) } // no permission → the inbox still waits for the next open
    }

    private fun ack(nodeId: String, id: String, ok: Boolean, ms: Long, reason: String?) {
        val body = JSONObject().put("id", id).put("ok", ok).put("ms", ms)
        if (reason != null) body.put("reason", reason)
        Wearable.getMessageClient(this).sendMessage(nodeId, Inbox.PATH_ACK, body.toString().toByteArray())
    }
}
