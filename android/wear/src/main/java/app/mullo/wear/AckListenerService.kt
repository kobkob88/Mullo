package app.mullo.wear

import com.google.android.gms.wearable.CapabilityInfo
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService
import org.json.JSONObject

/** The phone's receipt. Only ok=true deletes the watch's copy. */
class AckListenerService : WearableListenerService() {
    /** The phone with Mullo is reachable again: send what waited, like the Apple Watch's queue does.
     *  Forced: a send cut off by the lost link left its id "in flight". The phone answers a repeat
     *  of a note it already has with "already here", so nothing arrives twice. */
    override fun onCapabilityChanged(info: CapabilityInfo) {
        if (info.name == Proto.CAP_PHONE && info.nodes.isNotEmpty()) Sender.sendAllAsync(applicationContext, force = true)
    }

    override fun onMessageReceived(event: MessageEvent) {
        if (event.path != Proto.PATH_ACK) return
        val ack = JSONObject(String(event.data))
        val id = ack.getString("id")
        Sender.delivered(id)
        if (ack.optBoolean("ok")) {
            Proto.audio(this, id).delete()
            Proto.meta(this, id).delete()
            SpikeLog.line(this, "✓ $id on the phone (${ack.optLong("ms") / 1000.0}s transfer) - deleted here")
        } else {
            SpikeLog.line(this, "✗ phone refused $id: ${ack.optString("reason")} - kept, will resend")
        }
    }
}
