package app.mullo.wear

import android.content.Context
import android.net.Uri
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.Node
import com.google.android.gms.wearable.Wearable
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** Sends every finished recording in the outbox to the phone. Never deletes - only an ack does. */
object Sender {
    private val exec = Executors.newSingleThreadExecutor()
    private val inFlight = mutableSetOf<String>()

    fun sendAllAsync(ctx: Context, force: Boolean = false) = exec.execute {
        try {
            if (force) synchronized(inFlight) { inFlight.clear() }
            sendAll(ctx)
        } catch (e: Exception) {
            SpikeLog.line(ctx, "✗ send failed: ${e.javaClass.simpleName} ${e.message}")
        }
    }

    fun delivered(id: String) = synchronized(inFlight) { inFlight.remove(id) }

    private fun sendAll(ctx: Context) {
        val pending = Proto.outbox(ctx).listFiles { f -> f.name.endsWith(".json") }?.sortedBy { it.name }.orEmpty()
        if (pending.isEmpty()) return
        val info = Tasks.await(
            Wearable.getCapabilityClient(ctx).getCapability(Proto.CAP_PHONE, CapabilityClient.FILTER_REACHABLE),
            30, TimeUnit.SECONDS,
        )
        val node = info.nodes.firstOrNull { it.isNearby } ?: info.nodes.firstOrNull()
        if (node == null) {
            SpikeLog.line(ctx, "… no phone with Mullo reachable - ${pending.size} waiting")
            return
        }
        for (metaFile in pending) send(ctx, node, metaFile)
    }

    private fun send(ctx: Context, node: Node, metaFile: File) {
        val meta = JSONObject(metaFile.readText())
        val id = meta.getString("id")
        synchronized(inFlight) { if (!inFlight.add(id)) return }
        val audio = Proto.audio(ctx, id)
        if (!audio.exists()) {
            metaFile.delete()
            delivered(id)
            return
        }
        meta.put("sent_at", System.currentTimeMillis()).put("nearby", node.isNearby)

        val messages = Wearable.getMessageClient(ctx)
        val channels = Wearable.getChannelClient(ctx)
        Tasks.await(messages.sendMessage(node.id, Proto.PATH_OFFER, meta.toString().toByteArray()), 30, TimeUnit.SECONDS)
        val path = "${Proto.PATH_FILE}$id/${meta.getLong("size")}/${meta.getString("sha256")}"
        val channel = Tasks.await(channels.openChannel(node.id, path), 30, TimeUnit.SECONDS)
        // Bluetooth can be as slow as ~16 KB/s: a 28-minute meeting (~6.5 MB) took longer
        // than a flat 30 s. Running out of patience here doesn't stop the transfer, and the
        // phone's ack (size + hash checked) is what counts, so it's said as "still sending".
        val waitSec = 60L + audio.length() / (16 * 1024)
        try {
            Tasks.await(channels.sendFile(channel, Uri.fromFile(audio)), waitSec, TimeUnit.SECONDS)
        } catch (_: TimeoutException) {
            SpikeLog.line(ctx, "… still sending $id (${audio.length() / 1024} KB) - the phone confirms when it has it")
            return
        }
        SpikeLog.line(
            ctx,
            "→ sending $id (${audio.length() / 1024} KB) to ${node.displayName}${if (node.isNearby) " [nearby]" else " [not nearby]"}",
        )
    }
}
