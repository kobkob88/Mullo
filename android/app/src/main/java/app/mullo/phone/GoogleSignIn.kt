package app.mullo.phone

import android.os.CancellationSignal
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import android.webkit.JavascriptInterface
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import org.json.JSONObject

/**
 * "Continue with Google": Android's own account sheet (Credential Manager). Google
 * blocks its sign-in page inside a WebView, so the sheet runs natively and hands
 * the web code only Google's ID token, which it trades with Supabase for a Mullo
 * session (app/core/account.js). The nonce the web code passes in (a SHA-256 of a
 * random value it keeps) ties the token to this one sign-in.
 *
 * Needs, in Google Cloud: a Web client (its id below; Supabase holds its secret)
 * and an Android client for app.mullo + this build's signing key SHA-1.
 */
object GoogleSignIn {
    /** The Web client's id. Public by design (it is in every Google sign-in page). */
    const val WEB_CLIENT_ID = "YOUR-GOOGLE-CLIENT-ID.apps.googleusercontent.com"

    // Mullo's own Google Cloud project, "Mullo" (G5, redone 2026-10-13: the first clients sat in
    // the shared lizai project). Its Android client knows app.mullo with the debug key's SHA-1;
    // a Play-signed build needs a second Android client (S17).
    private const val ON = true
    val available get() = ON && WEB_CLIENT_ID.isNotEmpty()

    /** Calls [done] with {"idToken":...} or {"error":..., "cancelled":bool}, on the main thread. */
    fun start(activity: MainActivity, nonceHash: String, done: (String) -> Unit) {
        val fail = { message: String, cancelled: Boolean ->
            done(JSONObject().put("error", message).put("cancelled", cancelled).toString())
        }
        if (!available) return fail("Google sign-in isn't set up in this build.", false)
        if (!Regex("[0-9a-f]{64}").matches(nonceHash)) return fail("Bad sign-in request.", false)
        val request = GetCredentialRequest.Builder()
            .addCredentialOption(GetSignInWithGoogleOption.Builder(WEB_CLIENT_ID).setNonce(nonceHash).build())
            .build()
        CredentialManager.create(activity).getCredentialAsync(
            activity, request, CancellationSignal(), activity.mainExecutor,
            object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
                override fun onResult(result: GetCredentialResponse) {
                    val cred = result.credential
                    if (cred is CustomCredential && cred.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                        val token = runCatching { GoogleIdTokenCredential.createFrom(cred.data).idToken }.getOrNull()
                        if (token != null) return done(JSONObject().put("idToken", token).toString())
                    }
                    fail("Google sent back something unexpected.", false)
                }

                override fun onError(e: GetCredentialException) = when (e) {
                    is GetCredentialCancellationException -> fail("Cancelled", true)
                    is NoCredentialException -> fail("No Google account on this phone. Add one in the phone's settings, or use your email.", false)
                    else -> fail(e.message ?: "Google sign-in didn't work. Try again, or use your email.", false)
                }
            },
        )
    }
}

/** `MulloGoogle` in the web code (app/core/native.js). The answer comes back as an `mullo-google` event. */
class MulloGoogleJs(private val activity: MainActivity) {
    @JavascriptInterface
    fun available(): Boolean = GoogleSignIn.available

    @JavascriptInterface
    fun signIn(nonceHash: String) {
        activity.runOnUiThread { GoogleSignIn.start(activity, nonceHash, activity::sendGoogleResult) }
    }
}
