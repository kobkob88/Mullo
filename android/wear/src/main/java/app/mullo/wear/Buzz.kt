package app.mullo.wear

import android.content.Context
import android.os.VibrationEffect
import android.os.Vibrator

/**
 * What the wrist feels. Sent by the recorder itself, so each buzz is a fact, not a request:
 * one = the microphone is on, two = stopped and saved, one long = couldn't start.
 */
object Buzz {
    fun started(ctx: Context) = buzz(ctx, VibrationEffect.createOneShot(150, VibrationEffect.DEFAULT_AMPLITUDE))
    fun stopped(ctx: Context) = buzz(ctx, VibrationEffect.createWaveform(longArrayOf(0, 80, 120, 80), -1))
    fun failed(ctx: Context) = buzz(ctx, VibrationEffect.createOneShot(600, VibrationEffect.DEFAULT_AMPLITUDE))

    private fun buzz(ctx: Context, effect: VibrationEffect) {
        ctx.getSystemService(Vibrator::class.java)?.vibrate(effect)
    }
}
