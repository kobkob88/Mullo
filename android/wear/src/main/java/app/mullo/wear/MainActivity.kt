package app.mullo.wear

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView

/** One big button, like the Apple Watch app (ios/MulloWatch/ContentView.swift): red dot = record,
 *  square = stop and send. Sending needs no button: a stop sends, and so does the phone coming
 *  back in reach (AckListenerService). */
class MainActivity : Activity() {
    private lateinit var title: TextView
    private lateinit var button: RecordButton
    private lateinit var status: TextView
    private val ui = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            refresh()
            ui.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val dp = resources.displayMetrics.density
        title = TextView(this).apply {
            gravity = Gravity.CENTER
            textSize = 17f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.WHITE)
        }
        button = RecordButton(this).apply {
            layoutParams = LinearLayout.LayoutParams((84 * dp).toInt(), (84 * dp).toInt()).apply {
                topMargin = (8 * dp).toInt(); bottomMargin = (8 * dp).toInt()
            }
            setOnClickListener { toggle() }
        }
        status = TextView(this).apply {
            gravity = Gravity.CENTER
            textSize = 13f
            setTextColor(Color.LTGRAY)
        }
        val pad = (resources.displayMetrics.widthPixels * 0.12).toInt() // round screen
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.BLACK)
            setPadding(pad, pad / 2, pad, pad / 2)
            addView(title)
            addView(button)
            addView(status)
        })

        val missing = listOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS)
            .filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) requestPermissions(missing.toTypedArray(), 1)
    }

    override fun onResume() {
        super.onResume()
        ui.post(tick)
        Sender.sendAllAsync(applicationContext) // anything left from before
    }

    override fun onPause() {
        ui.removeCallbacks(tick)
        super.onPause()
    }

    private fun toggle() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1)
            return
        }
        val action = if (RecorderService.running) RecorderService.ACTION_STOP else RecorderService.ACTION_START
        val intent = Intent(this, RecorderService::class.java).setAction(action)
        if (action == RecorderService.ACTION_START) startForegroundService(intent) else startService(intent)
        ui.postDelayed({ refresh() }, 300)
    }

    private fun refresh() {
        val running = RecorderService.running
        val micOk = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        title.text = if (running) {
            val s = (SystemClock.elapsedRealtime() - RecorderService.startedElapsed) / 1000
            "%d:%02d".format(s / 60, s % 60)
        } else "Mullo"
        button.recording = running
        button.contentDescription = if (running) "Stop and send" else "Start recording"
        val waiting = Proto.pendingCount(this)
        status.text = when {
            !micOk -> "Allow the microphone to record"
            running -> "Tap to stop and send"
            waiting > 0 -> "$waiting waiting for the phone"
            else -> "Tap to record"
        }
    }
}

/** The Apple Watch's button: a red circle with a white dot, or white with a red square while recording. */
private class RecordButton(context: Context) : View(context) {
    private val red = Color.rgb(255, 77, 94)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    var recording = false
        set(value) { if (field != value) { field = value; invalidate() } }

    init { isClickable = true; isFocusable = true }

    override fun onDraw(canvas: Canvas) {
        val cx = width / 2f
        val cy = height / 2f
        val r = minOf(width, height) / 2f
        paint.color = if (recording) Color.WHITE else red
        canvas.drawCircle(cx, cy, r, paint)
        if (recording) {
            val half = r * 30 / 84f
            paint.color = red
            canvas.drawRoundRect(cx - half, cy - half, cx + half, cy + half, r * 12 / 84f, r * 12 / 84f, paint)
        } else {
            paint.color = Color.WHITE
            canvas.drawCircle(cx, cy, r * 26 / 84f, paint)
        }
    }
}
