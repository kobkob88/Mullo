package app.mullo.wear

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** One screen: Record/Stop, a timer, how many are waiting, and the result log. */
class MainActivity : Activity() {
    private lateinit var record: Button
    private lateinit var status: TextView
    private lateinit var log: TextView
    private val ui = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            refresh()
            ui.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (resources.displayMetrics.widthPixels * 0.12).toInt() // round screen
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(pad, pad / 2, pad, pad)
        }
        record = Button(this).apply { setOnClickListener { toggle() } }
        status = TextView(this).apply { gravity = Gravity.CENTER; textSize = 14f }
        val send = Button(this).apply {
            text = "Send now"
            setOnClickListener { Sender.sendAllAsync(applicationContext, force = true) }
        }
        log = TextView(this).apply { textSize = 11f; setTextColor(Color.LTGRAY) }
        column.addView(record)
        column.addView(status)
        column.addView(send)
        column.addView(log)
        setContentView(ScrollView(this).apply { addView(column) })

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
        record.text = if (running) "■ Stop" else "● Record"
        val time = if (running) {
            val s = (SystemClock.elapsedRealtime() - RecorderService.startedElapsed) / 1000
            "%d:%02d".format(s / 60, s % 60)
        } else ""
        status.text = "$time\n${Proto.pendingCount(this)} waiting to send · battery ${Proto.battery(this)}%"
        log.text = SpikeLog.tail(this, 12)
    }
}
