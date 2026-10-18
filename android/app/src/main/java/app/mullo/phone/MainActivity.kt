package app.mullo.phone

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.WindowInsets
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.window.OnBackInvokedDispatcher
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject

/**
 * Mullo, inside a WebView, from its own files bundled in the app. Locked down:
 * only app.mullo.lizai.io (answered here, never on the internet) loads in it;
 * every other link opens outside; no file:// or content:// access; the
 * microphone is granted only to Mullo's own page.
 */
class MainActivity : Activity() {

    companion object {
        /** Set while Mullo is on screen: tells the web code a watch recording landed. */
        @Volatile var onWatchRecording: (() -> Boolean)? = null
        /** Set while Mullo is on screen: asks the person before the account server changes
         *  (url null = back to Mullo's own). Settings → Developers → Your own server. */
        @Volatile var askServer: ((String?, String?) -> Unit)? = null
        /** Set while Mullo is on screen: the web code says whether every way into the account on
         *  Mullo's server is closed (true = switch to the server the person confirmed). */
        @Volatile var finishServer: ((Boolean) -> Unit)? = null
        /** Set while Mullo is on screen: Done / Snooze was tapped on a task reminder (Reminders.kt). */
        @Volatile var onReminderTap: (() -> Unit)? = null
        /** Set while Mullo is on screen: opens a system page on top of Mullo, so Back returns here. */
        @Volatile var openPage: ((Intent) -> Unit)? = null
        private const val REQ_MIC = 1
        private const val REQ_FILE = 2
        private const val REQ_NOTIFY = 3
    }

    private lateinit var web: WebView
    private var pendingMic: PermissionRequest? = null
    private var pendingFiles: ValueCallback<Array<Uri>>? = null

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        WebView.setWebContentsDebuggingEnabled(debuggable)

        val loader = WebViewAssetLoader.Builder()
            .setDomain(APP_HOST)
            .addPathHandler("/watch-inbox/", WatchAudio(this))
            .addPathHandler("/", WebFiles(this))
            .build()

        web = WebView(this)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = true
        }
        web.addJavascriptInterface(MulloWatchJs(applicationContext), "MulloWatch")
        web.addJavascriptInterface(MulloNativeJs(applicationContext), "MulloNative")
        web.addJavascriptInterface(MulloGoogleJs(this), "MulloGoogle")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                if (request.url.host == APP_HOST) loader.shouldInterceptRequest(request.url) else null

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == APP_HOST) return false
                openOutside(request.url) // mail, calendar, maps, web links - never inside Mullo's window
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val mic = PermissionRequest.RESOURCE_AUDIO_CAPTURE
                if (request.origin.host != APP_HOST || mic !in request.resources) {
                    request.deny()
                    return
                }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(arrayOf(mic))
                } else {
                    pendingMic = request
                    requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
                }
            }

            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                pendingFiles?.onReceiveValue(null)
                pendingFiles = callback
                return try {
                    @Suppress("DEPRECATION")
                    startActivityForResult(params.createIntent(), REQ_FILE)
                    true
                } catch (_: ActivityNotFoundException) {
                    pendingFiles = null
                    false
                }
            }
        }

        // Edge-to-edge (Android 15+): keep Mullo clear of the status bar, the gesture
        // bar and the keyboard. The spacing goes on a frame AROUND the WebView -
        // a WebView's own padding doesn't move position:fixed content (Mullo's
        // header and bottom nav), which then sat under the system bars.
        // Behind the bars: Mullo's own --bg (app.css), dark or light with the system.
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val frame = FrameLayout(this).apply { setBackgroundColor(Color.parseColor(if (night) "#000000" else "#f5f7f9")) }
        frame.addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        frame.setOnApplyWindowInsetsListener { v, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsets.CONSUMED
        }
        setContentView(frame)

        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { goBack() }
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
            }
        }

        handleBridgeIntent(intent)
        val task = taskToOpen(intent)
        if (savedInstanceState == null) web.loadUrl("$APP_ORIGIN/${task?.let { "#/actions/$it" } ?: ""}")
        else { web.restoreState(savedInstanceState); task?.let(::openTask) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleBridgeIntent(intent)
        taskToOpen(intent)?.let(::openTask)
    }

    /** A task reminder's notification was tapped: that task's id (checked: only letters,
     *  digits, - and _), else null. The most it can do is show the Actions screen. */
    private fun taskToOpen(intent: Intent?): String? =
        if (intent?.action == Reminders.ACTION_OPEN_TASK) intent.getStringExtra(Reminders.EXTRA_ID)?.takeIf(Reminders::validId) else null

    private fun openTask(id: String) {
        web.evaluateJavascript("location.hash = ${JSONObject.quote("#/actions/$id")}", null)
    }

    override fun onResume() {
        super.onResume()
        onWatchRecording = {
            runOnUiThread { web.evaluateJavascript("dispatchEvent(new Event('mullo-watch'))", null) }
            true
        }
        askServer = { url, key -> runOnUiThread { confirmServer(url, key) } }
        onReminderTap = { runOnUiThread { web.evaluateJavascript("dispatchEvent(new Event('mullo-reminder'))", null) } }
        openPage = { page -> runOnUiThread { try { startActivity(page) } catch (_: ActivityNotFoundException) { } } }
        finishServer = { ok ->
            runOnUiThread {
                val p = pendingServer
                pendingServer = null
                if (ok && p != null) { Cloud.setServer(this, p.first, p.second); web.reload() }
            }
        }
    }

    /** The own server the person said yes to, waiting while the web code closes Mullo's side.
     *  The web code can only say go or stop; it can never name a server itself. */
    private var pendingServer: Pair<String, String>? = null

    /** Where the notes are copied to changes only after the person says yes, here. */
    private fun confirmServer(url: String?, key: String?) {
        val toOwn = url != null && key != null
        AlertDialog.Builder(this)
            .setTitle(if (toOwn) "Use your own server?" else "Back to Mullo's server?")
            .setMessage(
                if (toOwn) "${Uri.parse(url).host}\n\nOn Mullo's server, every connected app (Claude, ChatGPT...) and API key is disconnected, and you're signed out on your other devices. This phone stays signed in to Mullo for the AI only: your plan, a Mullo Pro key or your own AI key keep working through it. Then sign in on your server: it's a new account there. The notes on this phone stay and are copied there once you sign in."
                else "You'll be signed out of your own server here. Your Mullo sign-in for the AI carries on as your Mullo account (or sign in again). The notes on this phone stay.",
            )
            .setPositiveButton(if (toOwn) "Use it" else "Use Mullo's server") { _, _ ->
                when {
                    // Leaving Mullo's server: the web code closes every way in there first.
                    toOwn && !Cloud.isOwn(this) -> {
                        pendingServer = url!! to key!!
                        web.evaluateJavascript("dispatchEvent(new Event('mullo-leave-server'))", null)
                    }
                    toOwn -> { Cloud.setServer(this, url!!, key!!); web.reload() }
                    else -> { Cloud.useMullo(this); web.reload() }
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    /** Google's answer (GoogleSignIn.kt) → the web code, as an `mullo-google` event. JSON-quoted: never code. */
    fun sendGoogleResult(json: String) {
        web.evaluateJavascript("dispatchEvent(new CustomEvent('mullo-google', { detail: ${JSONObject.quote(json)} }))", null)
    }

    override fun onPause() {
        onWatchRecording = null
        askServer = null
        finishServer = null
        onReminderTap = null
        openPage = null
        super.onPause()
    }

    // Mullo swiped away: the WebView and its recording are gone, so is "Mullo is recording".
    override fun onDestroy() {
        MicService.stop(this)
        super.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    // Android 12 and older only; 13+ uses the OnBackInvokedCallback registered in onCreate.
    @SuppressLint("GestureBackNavigation")
    @Deprecated("Android 12 and older")
    override fun onBackPressed() = goBack()

    private fun goBack() {
        if (web.canGoBack()) web.goBack() else finish()
    }

    /**
     * The AI bridge address (it changes with the dev tunnel). Set by sharing the
     * link to Mullo. ALWAYS asks: this activity is exported, so any app on the
     * phone can send it an intent - a silent change would let one redirect the
     * person's recordings to its own server.
     */
    private fun handleBridgeIntent(intent: Intent?) {
        intent ?: return
        if (intent.action != Intent.ACTION_SEND) return
        val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return
        val link = Regex("https://[^\\s]+").find(text)?.value ?: return
        val host = Uri.parse(link).host ?: return
        AlertDialog.Builder(this)
            .setTitle("Use as Mullo's AI bridge?")
            .setMessage("$host\n\nRecordings you transcribe will be sent there. Only use your own bridge.")
            .setPositiveButton("Use it") { _, _ -> if (Bridge.set(this, link) != null) web.reload() }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun openOutside(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
            // nothing on the phone handles it
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_MIC) return
        val req = pendingMic ?: return
        pendingMic = null
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            req.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        } else {
            req.deny()
        }
    }

    @Deprecated("Activity result API needs androidx.activity; a plain Activity keeps the dependency list short")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_FILE) return
        pendingFiles?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
        pendingFiles = null
    }
}
