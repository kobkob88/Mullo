package app.mullo.wear

import android.content.Context
import android.os.BatteryManager
import java.io.File
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Watch → phone protocol (same constants in the phone module).
 *
 *  1. watch: message  /mullo/offer             {id, size, sha256, duration_ms, ...}  (info only)
 *  2. watch: channel  /mullo/file/<id>/<size>/<sha256>  + the .m4a bytes
 *  3. phone: checks size + sha256 from the channel path, keeps the file, then
 *     message  /mullo/ack  {id, ok, reason?, ms}
 *  4. watch: deletes its copy ONLY on ok=true.
 *
 * Size and hash ride in the channel path so the check never depends on which of
 * (1) and (2) arrives first.
 */
object Proto {
    const val CAP_PHONE = "mullo_phone"
    const val PATH_OFFER = "/mullo/offer"
    const val PATH_FILE = "/mullo/file/"
    const val PATH_ACK = "/mullo/ack"

    fun outbox(ctx: Context): File = File(ctx.filesDir, "outbox").apply { mkdirs() }
    fun part(ctx: Context, id: String) = File(outbox(ctx), "$id.m4a.part")
    fun audio(ctx: Context, id: String) = File(outbox(ctx), "$id.m4a")
    fun meta(ctx: Context, id: String) = File(outbox(ctx), "$id.json")

    fun newId(): String = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())

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

    fun battery(ctx: Context): Int =
        (ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager)
            .getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)

    fun pendingCount(ctx: Context) = outbox(ctx).listFiles { f -> f.name.endsWith(".json") }?.size ?: 0
}

/** A tiny on-disk log the screen shows - the spike's results live here. */
object SpikeLog {
    private val fmt = SimpleDateFormat("HH:mm:ss", Locale.US)

    @Synchronized
    fun line(ctx: Context, text: String) {
        android.util.Log.i("MulloSpike", text)
        File(ctx.filesDir, "log.txt").appendText("${fmt.format(Date())}  $text\n")
    }

    fun tail(ctx: Context, lines: Int): String {
        val f = File(ctx.filesDir, "log.txt")
        if (!f.exists()) return ""
        return f.readLines().takeLast(lines).reversed().joinToString("\n")
    }
}
