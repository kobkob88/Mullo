package app.mullo.phone

import android.content.Context
import android.net.Uri
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.FileInputStream

/** The private address Mullo's own files are served from. Answered inside the app; never on the internet. */
const val APP_HOST = "app.mullo.lizai.io"
const val APP_ORIGIN = "https://$APP_HOST"

/**
 * Serves Mullo's web files, bundled in assets/web/ (copied from dist/ by
 * scripts/build-android.mjs), with the same security headers the static host
 * would send (_headers). Two things differ from the web build:
 *  - config.json is written here from the bridge address saved on the phone,
 *  - the CSP connect-src names exactly that bridge, and nothing else.
 * No key is ever here: the bridge holds the Gemini key.
 */
class WebFiles(private val ctx: Context) : WebViewAssetLoader.PathHandler {

    private val baseHeaders: Map<String, String> by lazy { parseHeaders() }

    override fun handle(path: String): WebResourceResponse? {
        val rel = path.ifEmpty { "index.html" }
        if (rel.contains("..")) return null
        if (rel == "config.json") return json(configJson())
        val stream = try {
            ctx.assets.open("web/$rel")
        } catch (_: Exception) {
            return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }
        return WebResourceResponse(mimeOf(rel), if (isText(rel)) "utf-8" else null, 200, "OK", headers(), stream)
    }

    // With a Mullo Pro key: the hosted Worker + the key. With a dev bridge set: that.
    // Otherwise the hosted Worker with the Mullo sign-in, as far as the account's plan allows.
    private fun configJson(): String {
        val pro = Bridge.proKey(ctx)
        val url = Bridge.appUrl(ctx)
        return JSONObject()
            .put("backend", "local")
            .put("supabaseUrl", Cloud.url(ctx))
            .put("supabaseAnonKey", Cloud.key(ctx))
            .put("ownServer", Cloud.isOwn(ctx))
            .put("bridgeUrl", url)
            .put("aiPlan", when {
                pro != null -> "pro"
                url == Bridge.PRO_URL -> "account"
                else -> JSONObject.NULL
            })
            .put("aiKey", pro ?: JSONObject.NULL)
            .put("aiOwnKey", Bridge.ownKey(ctx) ?: JSONObject.NULL)
            // On their own server, Mullo's account server too: the AI needs a Mullo sign-in (S25).
            .put("mulloSupabaseUrl", if (Cloud.isOwn(ctx)) Cloud.URL else JSONObject.NULL)
            .put("mulloSupabaseAnonKey", if (Cloud.isOwn(ctx)) Cloud.PUBLISHABLE_KEY else JSONObject.NULL)
            .toString()
    }

    private fun json(body: String) = WebResourceResponse(
        "application/json", "utf-8", 200, "OK", headers() + ("Cache-Control" to "no-store"),
        ByteArrayInputStream(body.toByteArray()),
    )

    private fun headers(): Map<String, String> {
        val out = baseHeaders.toMutableMap()
        out["Content-Security-Policy"]?.let { csp ->
            val bridge = Uri.parse(Bridge.appUrl(ctx)).let { u -> "${u.scheme}://${u.authority}" }
            // Their own server, and Mullo's account server for the AI sign-in (S25).
            val mulloAccount = if (Cloud.isOwn(ctx)) Cloud.URL else ""
            out["Content-Security-Policy"] = csp.replace(Regex("connect-src [^;]*"), "connect-src 'self' ${Cloud.url(ctx)} $mulloAccount $bridge".replace(Regex(" +"), " ").trim())
        }
        return out
    }

    // The catch-all block of _headers (Cloudflare Pages format).
    private fun parseHeaders(): Map<String, String> {
        val text = try { ctx.assets.open("web/_headers").bufferedReader().readText() } catch (_: Exception) { return emptyMap() }
        val out = linkedMapOf<String, String>()
        var inAll = false
        for (line in text.lines()) {
            if (line.isBlank() || line.trimStart().startsWith("#")) continue
            if (!line.startsWith(" ") && !line.startsWith("\t")) { inAll = line.trim() == "/*"; continue }
            if (!inAll) continue
            val i = line.indexOf(':')
            if (i > 0) out[line.substring(0, i).trim()] = line.substring(i + 1).trim()
        }
        return out
    }

    private fun isText(p: String) = Regex("\\.(html|css|js|json|txt|svg|webmanifest)$").containsMatchIn(p)

    private fun mimeOf(p: String) = when (p.substringAfterLast('.', "").lowercase()) {
        "html" -> "text/html"
        "css" -> "text/css"
        "js" -> "text/javascript"
        "json" -> "application/json"
        "txt" -> "text/plain"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "webmanifest" -> "application/manifest+json"
        else -> "application/octet-stream"
    }
}

/**
 * The Mullo account server (Supabase, project "Mullo"). Both values are public by
 * design, like a website's address: the publishable key only identifies the project,
 * and row-level security decides what a signed-in person can reach. Never put a
 * secret (sb_secret_...) key here.
 */
object Cloud {
    const val URL = "https://YOUR-PROJECT.supabase.co"
    const val PUBLISHABLE_KEY = "sb_publishable_YOUR-KEY"

    private const val PREFS = "mullo"
    private const val SESSION = "account_session_sealed"
    // On their own server, the second sign-in: to Mullo's account, for the AI and the Terms (S25).
    // On Mullo's own server the one SESSION is both.
    private const val MULLO_SESSION = "mullo_session_sealed"
    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun save(ctx: Context, slot: String, json: String) {
        if (json.length > 16_000) return
        prefs(ctx).edit().putString(slot, SecretBox.seal(json)).apply()
    }
    private fun load(ctx: Context, slot: String): String = prefs(ctx).getString(slot, null)?.let(SecretBox::open) ?: ""

    /** The sign-in session (tokens) for the server the notes sync with, sealed with the Keystore like the Pro key. */
    fun saveSession(ctx: Context, json: String) = save(ctx, SESSION, json)
    fun loadSession(ctx: Context): String = load(ctx, SESSION)
    fun clearSession(ctx: Context) = prefs(ctx).edit().remove(SESSION).apply()

    /** On their own server, the Mullo sign-in for the AI (app/core/account.js mulloSessionStore). */
    fun saveMulloSession(ctx: Context, json: String) = save(ctx, MULLO_SESSION, json)
    fun loadMulloSession(ctx: Context): String = load(ctx, MULLO_SESSION)
    fun clearMulloSession(ctx: Context) = prefs(ctx).edit().remove(MULLO_SESSION).apply()

    /** Where the Mullo sign-in the AI goes through is kept. */
    private fun mulloSlot(ctx: Context) = if (isOwn(ctx)) MULLO_SESSION else SESSION
    fun hasMulloSession(ctx: Context) = load(ctx, mulloSlot(ctx)).isNotBlank()

    /**
     * A Mullo sign-in token good for at least another minute, for WatchAi (Mullo closed), or null.
     * Refreshes like app/core/account.js and saves the new session in the same sealed store;
     * the web code takes a newer stored session instead of sending its used refresh token.
     * Never signs out: a refused refresh leaves the session for the web code to judge.
     * Always Mullo's account (on their own server, its second sign-in): the Worker accepts no
     * other project's sign-in.
     */
    @Synchronized
    fun accessToken(ctx: Context): String? {
        val slot = mulloSlot(ctx)
        val session = runCatching { JSONObject(load(ctx, slot)) }.getOrNull() ?: return null
        val now = System.currentTimeMillis() / 1000
        if (session.optLong("expires_at") - 60 > now) return session.optString("access_token").ifBlank { null }
        val refresh = session.optString("refresh_token").ifBlank { return null }
        val conn = java.net.URL("$URL/auth/v1/token?grant_type=refresh_token").openConnection() as java.net.HttpURLConnection
        return try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 20_000
            conn.readTimeout = 20_000
            conn.doOutput = true
            conn.setRequestProperty("apikey", PUBLISHABLE_KEY)
            conn.setRequestProperty("Content-Type", "application/json")
            conn.outputStream.use { it.write(JSONObject().put("refresh_token", refresh).toString().toByteArray()) }
            if (conn.responseCode !in 200..299) return null
            val body = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
            val user = body.optJSONObject("user")
            if (body.optString("access_token").isBlank() || body.optString("refresh_token").isBlank()
                || user?.optString("id") != session.optJSONObject("user")?.optString("id")) return null
            // The same shape as account.js toSession(), so the web code reads it as its own.
            val expiresAt = body.optLong("expires_at").takeIf { it > 0 } ?: (now + body.optLong("expires_in", 3600))
            val next = JSONObject()
                .put("access_token", body.getString("access_token"))
                .put("refresh_token", body.getString("refresh_token"))
                .put("expires_at", expiresAt)
                .put("user", session.optJSONObject("user"))
            save(ctx, slot, next.toString())
            next.getString("access_token")
        } catch (_: Exception) {
            null
        } finally {
            conn.disconnect()
        }
    }

    /**
     * The person's own Supabase project instead of Mullo's (Settings, Developers, Your own
     * server). Set only after the person confirms in a native dialog (MainActivity), since
     * where notes are copied to must never change silently. A session belongs to one server,
     * so changing it signs out of the notes' server; this phone's Mullo sign-in carries on for
     * the AI (S25: leaving Mullo's server moves it to MULLO_SESSION, coming back moves it back).
     */
    private const val SERVER_URL = "server_url"
    private const val SERVER_KEY = "server_key"

    fun url(ctx: Context): String = prefs(ctx).getString(SERVER_URL, null) ?: URL
    fun key(ctx: Context): String = prefs(ctx).getString(SERVER_KEY, null) ?: PUBLISHABLE_KEY
    fun isOwn(ctx: Context) = prefs(ctx).contains(SERVER_URL)

    /** → (url, key) cleaned, or null with `why` set. A secret key is refused, never stored. */
    fun check(rawUrl: String, rawKey: String): Pair<Pair<String, String>?, String?> {
        val u = Uri.parse(rawUrl.trim())
        if (u.scheme != "https" || u.host.isNullOrBlank()) return null to "The project address starts with https://"
        val key = rawKey.trim()
        if (key.startsWith("sb_secret_")) return null to "That's a secret key. Use the publishable key: a secret key must never be on a phone."
        val role = if (key.count { it == '.' } == 2) runCatching {
            JSONObject(String(android.util.Base64.decode(key.split(".")[1], android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP))).optString("role")
        }.getOrNull() else null
        if (role == "service_role") return null to "That's the service key. Use the anon or publishable key: the service key must never be on a phone."
        val looksPublic = Regex("sb_publishable_[A-Za-z0-9_-]{10,200}").matches(key) || role == "anon"
        if (!looksPublic) return null to "That doesn't look like a publishable key (sb_publishable_...)."
        return ("https://${u.authority}" to key) to null
    }

    fun setServer(ctx: Context, url: String, key: String) {
        val p = prefs(ctx)
        val edit = p.edit().putString(SERVER_URL, url).putString(SERVER_KEY, key)
        val mullo = if (isOwn(ctx)) null else p.getString(SESSION, null)
        if (mullo != null) edit.putString(MULLO_SESSION, mullo)
        edit.remove(SESSION).apply()
    }

    fun useMullo(ctx: Context) {
        val p = prefs(ctx)
        val mullo = p.getString(MULLO_SESSION, null)
        val edit = p.edit().remove(SERVER_URL).remove(SERVER_KEY).remove(MULLO_SESSION)
        if (mullo != null) edit.putString(SESSION, mullo) else edit.remove(SESSION)
        edit.apply()
    }
}

/** /watch-inbox/<id> → the watch recording's audio, for the web code to save into its library. */
class WatchAudio(private val ctx: Context) : WebViewAssetLoader.PathHandler {
    override fun handle(path: String): WebResourceResponse? {
        if (!Inbox.validId(path)) return null
        val f = Inbox.audio(ctx, path)
        if (!f.exists()) return null
        return WebResourceResponse("audio/mp4", null, 200, "OK", mapOf("Cache-Control" to "no-store"), FileInputStream(f))
    }
}

/**
 * Where the AI calls go. With a Mullo Pro key: the hosted Mullo Pro Worker.
 * Without: the dev bridge address saved on this phone (it changes with the dev
 * tunnel; set by sharing the link to Mullo, which always asks first).
 */
object Bridge {
    private const val PREFS = "mullo"
    private const val KEY = "bridge_url"
    private const val PRO_KEY = "pro_key_sealed"

    /** The Mullo Pro Worker (worker/ in the repo), on its custom domain. Public address; nothing secret. */
    const val PRO_URL = "https://mullo.lizai.io"
    private val PRO_KEY_SHAPE = Regex("echo_[A-Za-z0-9_-]{20,100}")

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun url(ctx: Context): String? = prefs(ctx).getString(KEY, null)

    /** Where a call with a key goes: the Worker with a Pro key or the person's own AI key,
     *  else the dev bridge, else nowhere. */
    fun effectiveUrl(ctx: Context): String? = if (proKey(ctx) != null || ownKey(ctx) != null) PRO_URL else url(ctx)

    /** Where the app's calls go: as above, and with neither, the Worker (the sign-in decides). */
    fun appUrl(ctx: Context): String = effectiveUrl(ctx) ?: PRO_URL

    /** Where WatchAi (Mullo closed) sends a note: as effectiveUrl, and with neither key nor dev
     *  bridge, the Worker on the sign-in's plan (S12) when signed in to Mullo (on their own
     *  server too, through its second sign-in, S25). */
    fun watchUrl(ctx: Context): String? =
        effectiveUrl(ctx) ?: PRO_URL.takeIf { Cloud.hasMulloSession(ctx) }

    fun proKey(ctx: Context): String? = prefs(ctx).getString(PRO_KEY, null)?.let(SecretBox::open)

    /** Returns null when saved, or why not. */
    fun setProKey(ctx: Context, raw: String): String? {
        val key = raw.trim()
        if (!PRO_KEY_SHAPE.matches(key)) return "That doesn't look like a Mullo Pro key (it starts with echo_)."
        prefs(ctx).edit().putString(PRO_KEY, SecretBox.seal(key)).apply()
        return null
    }

    fun clearProKey(ctx: Context) = prefs(ctx).edit().remove(PRO_KEY).apply()

    /**
     * The person's own AI key, as the Worker SEALED it (worker/src/ownkey.mjs): only Mullo's
     * Worker can open it, and it's sealed again here with the Keystore. Sent with every AI call
     * (X-Mullo-Own-Key); the plain key is never stored anywhere.
     */
    private const val OWN_KEY = "own_ai_sealed"
    private val OWN_KEY_SHAPE = Regex("mk1\\.[A-Za-z0-9_-]{16}\\.[A-Za-z0-9_-]{20,2000}")

    fun ownKey(ctx: Context): String? = prefs(ctx).getString(OWN_KEY, null)?.let(SecretBox::open)

    fun setOwnKey(ctx: Context, sealed: String): String? {
        if (!OWN_KEY_SHAPE.matches(sealed)) return "That key didn't come back from Mullo's server as expected."
        prefs(ctx).edit().putString(OWN_KEY, SecretBox.seal(sealed)).apply()
        return null
    }

    fun clearOwnKey(ctx: Context) = prefs(ctx).edit().remove(OWN_KEY).apply()

    /** Only https URLs with a host, path-less. Returns the normalised value or null if refused. */
    fun set(ctx: Context, raw: String?): String? {
        val u = raw?.trim()?.let(Uri::parse) ?: return null
        if (u.scheme != "https" || u.host.isNullOrBlank()) return null
        val clean = "https://${u.authority}"
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, clean).apply()
        return clean
    }
}
