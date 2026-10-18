package app.mullo.wear

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.MonochromaticImage
import androidx.wear.watchface.complications.data.MonochromaticImageComplicationData
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.data.SmallImage
import androidx.wear.watchface.complications.data.SmallImageComplicationData
import androidx.wear.watchface.complications.data.SmallImageType
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceService
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceUpdateRequester
import androidx.wear.watchface.complications.datasource.ComplicationRequest

/**
 * "Mullo record" as a button on any watch face (owner, 2026-10-09): not every Wear OS watch
 * lets a hardware button open an app, but every watch face takes complications. A tap runs
 * QuickRecordActivity, the same toggle as the double press: start / stop and send. The
 * recorder asks for a refresh on every start and stop, so the button says what a tap will do.
 */
class RecordComplicationService : ComplicationDataSourceService() {

    companion object {
        fun refresh(ctx: Context) {
            runCatching {
                ComplicationDataSourceUpdateRequester
                    .create(ctx, ComponentName(ctx, RecordComplicationService::class.java))
                    .requestUpdateAll()
            }
        }
    }

    override fun onComplicationRequest(request: ComplicationRequest, listener: ComplicationRequestListener) {
        listener.onComplicationData(data(request.complicationType, RecorderService.running))
    }

    override fun getPreviewData(type: ComplicationType): ComplicationData? = data(type, false)

    private fun data(type: ComplicationType, recording: Boolean): ComplicationData? {
        val tap = PendingIntent.getActivity(
            this, 0,
            Intent(this, QuickRecordActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val icon = Icon.createWithResource(this, if (recording) R.drawable.ic_stop else R.drawable.ic_mic)
        val says = PlainComplicationText.Builder(if (recording) "Stop" else "Rec").build()
        val means = PlainComplicationText.Builder(if (recording) "Stop recording and send" else "Start recording").build()
        val image = MonochromaticImage.Builder(icon).build()
        return when (type) {
            ComplicationType.SHORT_TEXT -> ShortTextComplicationData.Builder(says, means)
                .setMonochromaticImage(image).setTapAction(tap).build()
            ComplicationType.MONOCHROMATIC_IMAGE -> MonochromaticImageComplicationData.Builder(image, means)
                .setTapAction(tap).build()
            ComplicationType.SMALL_IMAGE -> SmallImageComplicationData.Builder(SmallImage.Builder(icon, SmallImageType.ICON).build(), means)
                .setTapAction(tap).build()
            else -> null
        }
    }
}
