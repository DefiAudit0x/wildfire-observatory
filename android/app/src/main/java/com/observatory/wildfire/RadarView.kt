package com.observatory.wildfire

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.SweepGradient
import android.view.View
import android.view.animation.LinearInterpolator

/**
 * v2.0.0 — the native HUD radar, replacing the "stone age" decorative one.
 * A dumb painter over RadarModel (all math is unit-tested there):
 *  - 30 km range, rings at 5/10/20/30 km with Arabic km labels;
 *  - north-up compass ticks + ش/ق/ج/غ letters;
 *  - a 9s rotating sweep sector (leading edge + 70° fading trail);
 *  - FIRMS satellite hotspots (orange diamonds — these were NEVER shown in
 *    any previous app version), pending community reports (amber hollow),
 *    verified fires (red pulsing), safezones (green squares), mesh intel
 *    (cyan crosses);
 *  - the user is the triangle at the center; a wind arrow (if weather was
 *    fetched) shows where wind COMES FROM, labeled as reference-only.
 */
class RadarView @JvmOverloads constructor(
    context: Context,
    attrs: android.util.AttributeSet? = null,
    defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    data class UiBlip(val blip: RadarModel.Blip)

    private var blips: List<RadarModel.Blip> = emptyList()
    private var userHasFix: Boolean = false
    private var windFromDeg: Double? = null
    private var sweepDeg = 0f

    private val sweepAnimator = ValueAnimator.ofFloat(0f, 360f).apply {
        duration = 9_000
        interpolator = LinearInterpolator()
        repeatCount = ValueAnimator.INFINITE
        addUpdateListener {
            sweepDeg = it.animatedValue as Float
            invalidate()
        }
    }

    fun setData(blips: List<RadarModel.Blip>, userHasFix: Boolean, windFromDeg: Double?) {
        this.blips = blips
        this.userHasFix = userHasFix
        this.windFromDeg = windFromDeg
        invalidate()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        sweepAnimator.start()
    }

    override fun onDetachedFromWindow() {
        sweepAnimator.cancel()
        super.onDetachedFromWindow()
    }

    // Paints are built once; onDraw allocates nothing (jank discipline).
    private val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = 0xFF0B1220.toInt()
    }
    private val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = 0xFF2A3B55.toInt()
        strokeWidth = 2f
    }
    private val ringLabelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF7C8DA6.toInt()
        textSize = 22f
        textAlign = Paint.Align.CENTER
    }
    private val compassPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF9FB3CC.toInt()
        textSize = 30f
        textAlign = Paint.Align.CENTER
        isFakeBoldText = true
    }
    private val tickPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFF3B4F6B.toInt()
        strokeWidth = 3f
    }
    private val sweepPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
    }
    private val hotspotPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = 0xFFFF8C42.toInt() // FIRMS orange
    }
    private val pendingPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = 0xFFFBBF24.toInt() // amber
        strokeWidth = 4f
    }
    private val verifiedPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = 0xFFEF4444.toInt() // red
    }
    private val safezonePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = 0xFF10B981.toInt() // green
    }
    private val meshPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = 0xFF22D3EE.toInt() // cyan
        strokeWidth = 4f
    }
    private val userPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = 0xFFE2E8F0.toInt()
    }
    private val windPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = 0xFF94A3B8.toInt()
        strokeWidth = 5f
    }
    private val rimPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = 0xFF3B4F6B.toInt()
        strokeWidth = 3f
    }
    private val headPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = 0xFF94A3B8.toInt()
        strokeWidth = 5f
    }
    private val rectF = RectF()

    // Shaders depend on runtime geometry — built once per size, never per frame.
    private var glowShader: RadialGradient? = null
    private var sweepShader: SweepGradient? = null

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        val cx = w / 2f
        val cy = h / 2f
        val radius = minOf(w, h) / 2f - 34f
        if (radius <= 0f) return
        glowShader = RadialGradient(
            cx, cy, radius,
            intArrayOf(0x14382B55, 0x000B1220),
            floatArrayOf(0f, 1f),
            android.graphics.Shader.TileMode.CLAMP
        )
        sweepShader = SweepGradient(cx, cy, intArrayOf(0x33EF4444, 0x000B1220), floatArrayOf(0f, 1f))
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        val cx = w / 2f
        val cy = h / 2f
        val radius = minOf(w, h) / 2f - 34f

        canvas.drawColor(0xFF0B1220.toInt())

        // Faint center glow for depth.
        bgPaint.shader = glowShader
        if (glowShader != null) {
            canvas.drawCircle(cx, cy, radius, bgPaint)
        }
        bgPaint.shader = null

        // Sweep trail (under the rings): 70° wide, leading edge at sweepDeg.
        canvas.save()
        canvas.rotate(sweepDeg, cx, cy)
        sweepPaint.shader = sweepShader
        rectF.set(cx - radius, cy - radius, cx + radius, cy + radius)
        canvas.drawArc(rectF, -RadarModel.SWEEP_HALF_DEG.toFloat(), 70f, true, sweepPaint)
        sweepPaint.shader = null
        canvas.restore()

        // Rings + labels (RTL: numbers are fine as-is).
        for ((px, km) in RadarModel.rings(radius)) {
            canvas.drawCircle(cx, cy, px, ringPaint)
            canvas.drawText("${km}كلم", cx + px - 2f, cy - 10f, ringLabelPaint)
        }
        // Cross hairs.
        canvas.drawLine(cx - radius, cy, cx + radius, cy, ringPaint)
        canvas.drawLine(cx, cy - radius, cx, cy + radius, ringPaint)

        // Compass ticks every 30° (major at 90°).
        for (deg in 0 until 360 step 30) {
            val rad = Math.toRadians(deg.toDouble())
            val inner = radius - (if (deg % 90 == 0) 22f else 10f)
            canvas.drawLine(
                cx + inner * Math.sin(rad).toFloat(), cy - inner * Math.cos(rad).toFloat(),
                cx + radius * Math.sin(rad).toFloat(), cy - radius * Math.cos(rad).toFloat(),
                tickPaint
            )
        }
        canvas.drawText("ش", cx, cy - radius + 24f, compassPaint)
        canvas.drawText("ق", cx + radius - 4f, cy + 10f, compassPaint)
        canvas.drawText("ج", cx, cy + radius - 12f, compassPaint)
        canvas.drawText("غ", cx - radius + 4f, cy + 10f, compassPaint)
        canvas.drawCircle(cx, cy, radius, rimPaint)

        // Blips.
        val pulse = 1f + 0.35f * Math.sin(System.currentTimeMillis() / 300.0).toFloat()
        for (blip in blips) {
            val p = RadarModel.project(blip.angleDeg, blip.distKm, cx, cy, radius)
            when (blip.kind) {
                RadarModel.Kind.HOTSPOT -> drawDiamond(canvas, p.x, p.y, 9f, hotspotPaint)
                RadarModel.Kind.PENDING_REPORT -> canvas.drawCircle(p.x, p.y, 8f, pendingPaint)
                RadarModel.Kind.VERIFIED_REPORT -> {
                    canvas.drawCircle(p.x, p.y, 10f * pulse, verifiedPaint)
                    canvas.drawCircle(p.x, p.y, 5f, verifiedPaint)
                }
                RadarModel.Kind.SAFEZONE -> drawSquare(canvas, p.x, p.y, 9f, safezonePaint)
                RadarModel.Kind.MESH_INTEL -> {
                    canvas.drawLine(p.x - 8f, p.y - 8f, p.x + 8f, p.y + 8f, meshPaint)
                    canvas.drawLine(p.x - 8f, p.y + 8f, p.x + 8f, p.y - 8f, meshPaint)
                }
            }
        }

        // Wind arrow: direction the wind COMES FROM, at a fixed offset ring.
        windFromDeg?.let { fromDeg ->
            val p = RadarModel.project(fromDeg, 27.0, cx, cy, radius)
            val tail = RadarModel.project(fromDeg, 21.0, cx, cy, radius)
            canvas.drawLine(tail.x, tail.y, p.x, p.y, windPaint)
            // Arrowhead pointing INWARD (from where the wind arrives).
            val inP = RadarModel.project(fromDeg + 180.0, 27.6, cx, cy, radius)
            val left = RadarModel.project(fromDeg + 20.0, 26.0, cx, cy, radius)
            val right = RadarModel.project(fromDeg - 20.0, 26.0, cx, cy, radius)
            canvas.drawLine(p.x, p.y, left.x, left.y, headPaint)
            canvas.drawLine(p.x, p.y, right.x, right.y, headPaint)
            canvas.drawLine(p.x, p.y, inP.x, inP.y, headPaint)
        }

        // User triangle at center (or a dimmed dot when no fix yet).
        if (userHasFix) {
            val path = android.graphics.Path()
            path.moveTo(cx, cy - 14f)
            path.lineTo(cx - 10f, cy + 10f)
            path.lineTo(cx + 10f, cy + 10f)
            path.close()
            canvas.drawPath(path, userPaint)
        } else {
            userPaint.alpha = 90
            canvas.drawCircle(cx, cy, 8f, userPaint)
            userPaint.alpha = 255
        }
    }

    private fun drawDiamond(canvas: Canvas, x: Float, y: Float, r: Float, paint: Paint) {
        val path = android.graphics.Path()
        path.moveTo(x, y - r)
        path.lineTo(x + r, y)
        path.lineTo(x, y + r)
        path.lineTo(x - r, y)
        path.close()
        canvas.drawPath(path, paint)
    }

    private fun drawSquare(canvas: Canvas, x: Float, y: Float, r: Float, paint: Paint) {
        canvas.drawRect(x - r, y - r, x + r, y + r, paint)
    }
}
