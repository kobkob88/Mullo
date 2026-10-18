package app.mullo.wear

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle

/**
 * "Mullo record" - one press toggles: start recording / stop and send. Reached three ways:
 * the watch's button shortcut (Galaxy: Settings → Advanced features → Customize buttons →
 * Double press), the Mullo record button on a watch face (RecordComplicationService), or
 * the launcher.
 *
 * The mic opens HERE, in onCreate, before this (invisible) window draws: it's allowed because
 * the activity is on screen, and it doesn't wait for the service, which used to run only after
 * the window was drawn (~0.3 s). Capture buzzes once the mic is really on. The foreground
 * service is started right after, to keep recording with the screen off.
 */
class QuickRecordActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        toggle()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        toggle()
    }

    // The main screen opens in its OWN task: started plainly it would join this
    // shortcut's task, and the next press would only bring that task forward
    // instead of running this toggle again.
    private fun openMain() {
        startActivity(
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        )
    }

    private fun toggle() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            // First run: the main screen asks for the microphone.
            openMain()
            finish()
            return
        }
        val intent = Intent(this, RecorderService::class.java)
        if (RecorderService.running) {
            startService(intent.setAction(RecorderService.ACTION_STOP))
            openMain()
            finish()
            return
        }
        if (Capture.start(this)) {
            try {
                startForegroundService(intent.setAction(RecorderService.ACTION_START))
            } catch (e: Exception) {
                // No foreground service = no recording with the screen off: don't pretend.
                SpikeLog.line(this, "✗ could not keep recording: ${e.message}")
                Capture.stop(this)
                Buzz.failed(this)
            }
        }
        openMain()
        finish()
    }
}
