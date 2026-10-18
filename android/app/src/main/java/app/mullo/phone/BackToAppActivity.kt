package app.mullo.phone

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * The browser's way back into Mullo: the "Back to Mullo" button on pages Mullo opens outside
 * itself (Google's "connected" page) links to mullo://open. Owner, 2026-10-14: the phone's Back
 * there led to Mullo's website, not the app.
 *
 * Takes nothing from the link (no data, no extras): it only brings Mullo to the front, so a web
 * page can't use it to hand Mullo anything. MainActivity gets a plain intent, which it ignores.
 */
class BackToAppActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        finish()
    }
}
