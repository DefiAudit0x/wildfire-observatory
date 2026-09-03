package com.observatory.wildfire

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Typeface
import android.media.ExifInterface
import java.io.File

/**
 * S3 (v2.9.0) — the evidentiary watermark renderer: draws the web
 * captureSnapshot HUD (crosshair, corner bounds, telemetry lines) onto the
 * captured bitmap, scaled from the web's 640×480 reference frame so the
 * composition is identical on any sensor aspect.
 *
 * Device side only — pure geometry/text lives in TelemetryCamera (JVM-tested).
 * All colors are the web canvas rgba values verbatim:
 *   crosshair rgba(239,68,68,.5)   title rgba(248,250,252,.9)
 *   disclaimer rgba(239,68,68,.9)  body rgba(241,245,249,.8)
 *   matched rgba(34,197,94,.9)     no-match rgba(239,68,68,.9)
 * A soft black shadow keeps the stamp legible over bright sky/ash frames.
 */
object TelemetryOverlay {

    private const val REF_W = 640f
    private const val REF_H = 480f

    fun stamp(
        bitmap: Bitmap,
        stamp: TelemetryCamera.Stamp,
        alignment: TelemetryCamera.Alignment?
    ): Bitmap {
        val w = bitmap.width.toFloat()
        val h = bitmap.height.toFloat()
        val scale = minOf(w / REF_W, h / REF_H)
        fun x(ref: Float) = w * ref / REF_W
        fun y(ref: Float) = h * ref / REF_H

        val canvas = Canvas(bitmap)

        // Crosshair target (web: vertical 320,200→320,280; horizontal 280,240→360,240)
        val cross = strokePaint(1.5f * scale, 0x80EF4444.toInt())
        canvas.drawLine(x(320f), y(200f), x(320f), y(280f), cross)
        canvas.drawLine(x(280f), y(240f), x(360f), y(240f), cross)

        // Technical bounds indicators — 4 corners, two 20px strokes each
        corner(canvas, x(20f), y(40f), 1f, 1f, scale)   // TL: → and ↓
        corner(canvas, x(620f), y(40f), -1f, 1f, scale)  // TR: ← and ↓
        corner(canvas, x(20f), y(440f), 1f, -1f, scale)  // BL: → and ↑
        corner(canvas, x(620f), y(440f), -1f, -1f, scale) // BR: ← and ↑

        // Branded telemetry labels — factual only (the stamp is an evidentiary
        // aid, not a cryptographic proof — same claim discipline as the web).
        canvas.drawText(
            "MAGHREB WILDFIRE OBSERVATORY - TELEMETRY CAPTURE", x(30f), y(70f),
            textPaint(13f, 0xE6F8FAFC.toInt(), bold = true, scale = scale)
        )
        canvas.drawText(
            "FIELD VISUAL ASSIST - ALIGNMENT ESTIMATE (NOT PROOF)", x(30f), y(90f),
            textPaint(10f, 0xE6EF4444.toInt(), bold = false, scale = scale)
        )
        val body = textPaint(9f, 0xCCF1F5F9.toInt(), bold = false, scale = scale)
        canvas.drawText("GPS LAT: ${stamp.latText}", x(30f), y(115f), body)
        canvas.drawText("GPS LNG: ${stamp.lngText}", x(30f), y(130f), body)
        if (stamp.bearingLine != null) {
            canvas.drawText(stamp.bearingLine, x(30f), y(145f), body)
            stamp.pitchLine?.let { canvas.drawText(it, x(30f), y(160f), body) }
        } else {
            canvas.drawText(TelemetryCamera.STAMP_OFF_LINE, x(30f), y(145f), body)
        }
        canvas.drawText(stamp.utcText, x(30f), y(175f), body)

        if (alignment != null) {
            val matched = textPaint(9f, 0xE622C55E.toInt(), bold = false, scale = scale)
            val lines = TelemetryCamera.alignmentStampLines(alignment)
            canvas.drawText(lines[0], x(30f), y(200f), matched)
            canvas.drawText(lines[1], x(30f), y(215f), matched)
        } else {
            canvas.drawText(
                TelemetryCamera.alignmentStampLines(null)[0], x(30f), y(200f),
                textPaint(9f, 0xE6EF4444.toInt(), bold = false, scale = scale)
            )
        }
        return bitmap
    }

    /**
     * Decode the captured JPEG EXIF-rotated to upright pixels (so the stamp
     * is never sideways) and bounded by [maxDim] through PhotoPipeline's
     * sampler. Returns null when the file cannot be decoded — the caller
     * keeps the unstamped file rather than inventing an image.
     */
    fun decodeUpright(file: File, maxDim: Int = PhotoPipeline.MAX_DIM_PX): Bitmap? {
        val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        android.graphics.BitmapFactory.decodeFile(file.absolutePath, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val opts = android.graphics.BitmapFactory.Options().apply {
            inSampleSize = PhotoPipeline.targetSample(bounds.outWidth, bounds.outHeight, maxDim)
        }
        val raw = android.graphics.BitmapFactory.decodeFile(file.absolutePath, opts) ?: return null
        val rotationDeg = when (exifRotationDegrees(file)) {
            ExifInterface.ORIENTATION_ROTATE_90 -> 90f
            ExifInterface.ORIENTATION_ROTATE_180 -> 180f
            ExifInterface.ORIENTATION_ROTATE_270 -> 270f
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL, ExifInterface.ORIENTATION_FLIP_VERTICAL,
            ExifInterface.ORIENTATION_TRANSPOSE, ExifInterface.ORIENTATION_TRANSVERSE -> {
                // Rare sensor cases: normalize to the nearest pure rotation —
                // the stamp must stay level more than it must stay mirrored.
                180f
            }
            else -> 0f
        }
        if (rotationDeg == 0f) return raw
        val matrix = Matrix().apply { postRotate(rotationDeg) }
        val rotated = Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, matrix, true)
        if (rotated != raw) raw.recycle()
        return rotated
    }

    /** 50×50 ARGB downsample for TelemetryCamera.preScan (device bridge). */
    fun downsamplePixels(bitmap: Bitmap, size: Int = 50): IntArray {
        val scaled = Bitmap.createScaledBitmap(bitmap, size, size, true)
        val pixels = IntArray(size * size)
        scaled.getPixels(pixels, 0, size, 0, 0, size, size)
        if (scaled !== bitmap) scaled.recycle()
        return pixels
    }

    private fun exifRotationDegrees(file: File): Int = try {
        ExifInterface(file.absolutePath).getAttributeInt(
            ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL
        )
    } catch (_: Exception) {
        ExifInterface.ORIENTATION_NORMAL
    }

    private fun strokePaint(widthPx: Float, color: Int): Paint =
        Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = widthPx
            this.color = color
        }

    /** One L-shaped corner mark: two 20-ref-px strokes from (px,py) inward. */
    private fun corner(canvas: Canvas, px: Float, py: Float, dx: Float, dy: Float, scale: Float) {
        val p = strokePaint(1.5f * scale, 0x80EF4444.toInt())
        canvas.drawLine(px, py, px + dx * (20f * scale), py, p)
        canvas.drawLine(px, py, px, py + dy * (20f * scale), p)
    }

    private fun textPaint(sizePx: Float, color: Int, bold: Boolean, scale: Float): Paint =
        Paint(Paint.ANTI_ALIAS_FLAG).apply {
            textSize = sizePx * scale
            this.color = color
            typeface = Typeface.create("monospace", if (bold) Typeface.BOLD else Typeface.NORMAL)
            setShadowLayer(2f * scale, 0f, 0f, 0xAA000000.toInt())
        }
}
