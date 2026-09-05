package com.observatory.wildfire

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.SweepGradient
import android.graphics.Typeface
import android.view.View
import android.view.animation.LinearInterpolator
import androidx.core.content.res.ResourcesCompat

/**
 * v2.20.0 — the NEON radar (Neo design system). Same dumb-painter contract
 * over RadarModel (all math is unit-tested there), same heading-up v2.19.0
 * logic, same zero-allocation-onDraw discipline — everything the 2024 card
 * drew flat now GLOWS:
 *  - the dish: near-black green body with an emerald radial core glow;
 *  - the sweep: bright #00FF8C leading edge with a layered fading trail;
 *  - rings/ticks/letters in glass whites and brand green, Cairo faces;
 *  - every blip wears a soft halo; verified fires pulse double rings;
 *  - the user triangle breathes, and with a compass a view-cone opens in
 *    front of it (screen-fixed — you are always "up");
 *  - no heading → the legacy north-up card, pixel-for-pixel (no sensor
 *    must never mean a fake one).
 */
class RadarView @JvmOverloads constructor(
    context: Context,
    attrs: android.util.AttributeSet? = null,
    defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    private var blips: List<RadarModel.Blip> = emptyList()
    private var userHasFix: Boolean = false
    private var windFromDeg: Double? = null
    /** v2.19.0: smoothed device bearing (0..360), null = no compass → north-up. */
    private var headingDeg: Double? = null
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

    fun setData(
        blips: List<RadarModel.Blip>,
        userHasFix: Boolean,
        windFromDeg: Double?,
        headingDeg: Double? = null
    ) {
        this.blips = blips
        this.userHasFix = userHasFix
        this.windFromDeg = windFromDeg
        this.headingDeg = headingDeg
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

    // ── Palette (Aurora Obsidian neon) ────────────────────────────────
    private val bodyColor = 0xFF050807.toInt()
    private val coreGlowColor = 0x3300E676
    private val ringColor = 0x1AFFFFFF   // white/10 glass rings
    private val crossColor = 0x0DFFFFFF  // white/5 crosshair
    private val tickMinor = 0x1FFFFFFF
    private val tickMajor = 0x73006233   // brand green/45
    private val tickCardinal = 0x8CFFFFFF.toInt()
    private val letterColor = 0xFFE8F2EC.toInt()
    private val labelColor = 0xB3FFFFFF.toInt()  // white/70 ring labels
    private val neonColor = 0xFF00FF8C.toInt()
    private val neonSoft = 0x5500E676

    // Paints are built once; onDraw allocates nothing (jank discipline).
    private val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = bodyColor
    }
    private val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = ringColor
        strokeWidth = 1.6f
    }
    private val crossPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = crossColor
        strokeWidth = 1.2f
    }
    private val ringLabelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = labelColor
        textSize = 21f
        textAlign = Paint.Align.CENTER
        typeface = ResourcesCompat.getFont(context, R.font.cairo_semibold)
            ?: Typeface.create("sans-serif-medium", Typeface.NORMAL)
    }
    private val compassPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = letterColor
        textSize = 30f
        textAlign = Paint.Align.CENTER
        isFakeBoldText = true
        typeface = ResourcesCompat.getFont(context, R.font.cairo_bold)
            ?: Typeface.create("sans-serif-bold", Typeface.NORMAL)
    }
    private val tickPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 2.4f
    }
    private val sweepPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
    }
    private val sweepEdgeGlowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = 0x3300FF8C
        strokeWidth = 12f
    }
    private val sweepEdgePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = 0xC400FF8C.toInt()
        strokeWidth = 2.4f
    }
    private val hotspotPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = 0xFFFF8C42.toInt()
    }
    private val hotspotHaloPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = 0x2EFF8C42
    }
    private val pendingPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = 0xFFFF6B35.toInt()
        strokeWidth = 3.4f
    }
    private val pendingHaloPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = 0x1EFF6B35
    }
    private val verifiedPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = 0xFFFF3B52.toInt()
    }
    private val verifiedHaloPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = 0xFFFF3B52.toInt()
        strokeWidth = 2.4f
    }
    private val safezonePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = 0xFF00E676.toInt()
    }
    private val safezoneHaloPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = 0x2E00E676
    }
    private val meshPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = 0xFF3AE8FF.toInt()
        strokeWidth = 3.4f
        strokeCap = Paint.Cap.ROUND
    }
    private val meshHaloPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = 0x2E3AE8FF
        strokeWidth = 8f
        strokeCap = Paint.Cap.ROUND
    }
    private val userPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = 0xFFF8FAFC.toInt()
    }
    private val userGlowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = 0x5900E676
    }
    private val userBreathPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = 0xFF00E676.toInt()
        strokeWidth = 2f
    }
    private val conePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = 0x1400E676
    }
    private val coneEdgePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = 0x2900E676
        strokeWidth = 1.4f
    }
    private val windPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = 0xFFB8C4BE.toInt()
        strokeWidth = 4.4f
        strokeCap = Paint.Cap.ROUND
    }
    private val windGlowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = 0x33B8C4BE.toInt()
        strokeWidth = 10f
        strokeCap = Paint.Cap.ROUND
    }
    private val rimGlowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = 0x2600E676
        strokeWidth = 9f
    }
    private val rimPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = 0x6600E676
        strokeWidth = 2f
    }
    private val headPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = 0xFFFF6B35.toInt() // wind arrowhead rides the brand orange
        strokeWidth = 4f
        strokeCap = Paint.Cap.ROUND
    }
    private val rectF = RectF()

    // Shaders depend on runtime geometry — built once per size, never per frame.
    private var glowShader: RadialGradient? = null
    private var sweepShader: SweepGradient? = null
    private var sweepCoreShader: SweepGradient? = null

    // v2.16.0 (audit wave 3 — per-frame allocation hygiene): everything
    // onDraw touches at 60fps is pre-allocated. Paths rewind in place,
    // projections write into scratch holders, and the ring list (+ labels)
    // is cached with the shaders — onDraw now allocates NOTHING in steady
    // state (GC churn mid-sweep read as radar jitter on low-end devices).
    private val diamondPath = Path()
    private val trianglePath = Path()
    private val conePath = Path()
    private val blipScratch = RadarModel.MutableScreenPoint()
    private val windScratch = Array(5) { RadarModel.MutableScreenPoint() }
    private var cachedRings: List<Pair<Float, String>> = emptyList()

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        val cx = w / 2f
        val cy = h / 2f
        val radius = minOf(w, h) / 2f - 34f
        if (radius <= 0f) {
            cachedRings = emptyList()
            return
        }
        glowShader = RadialGradient(
            cx, cy, radius,
            intArrayOf(coreGlowColor, bodyColor),
            floatArrayOf(0f, 1f),
            android.graphics.Shader.TileMode.CLAMP
        )
        sweepShader = SweepGradient(
            cx, cy,
            intArrayOf(neonSoft, 0x001B4332, 0x000D2015, 0x000D2015),
            floatArrayOf(0f, 0.28f, 0.62f, 1f)
        )
        sweepCoreShader = SweepGradient(
            cx, cy,
            intArrayOf(0x8800FF8C.toInt(), 0x0000FF8C),
            floatArrayOf(0f, 0.16f)
        )
        cachedRings = RadarModel.rings(radius).map { (px, km) -> px to "${km}كلم" }

        // View cone (screen-fixed, points UP = where you face in heading-up
        // mode): rebuilt once per size.
        val len = radius * 0.92f
        val halfW = len * 0.38f // ~21° half-angle
        conePath.rewind()
        conePath.moveTo(cx, cy)
        conePath.lineTo(cx - halfW, cy - len)
        conePath.quadTo(cx, cy - len * 1.12f, cx + halfW, cy - len)
        conePath.close()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        val cx = w / 2f
        val cy = h / 2f
        val radius = minOf(w, h) / 2f - 34f
        if (radius <= 0f) return

        canvas.drawColor(bodyColor)

        // Emerald core glow for depth (the dish is never flat black again).
        bgPaint.shader = glowShader
        if (glowShader != null) {
            canvas.drawCircle(cx, cy, radius, bgPaint)
        }
        bgPaint.shader = null

        // v2.19.0 heading-up: the ROSE (sweep, rings, ticks, letters) rotates
        // by −heading so "ش" sits toward TRUE north on screen; blips project
        // with the same adjusted angle below. heading == null → rotation 0 →
        // the legacy north-up card, byte-for-byte.
        val heading = headingDeg
        val roseRotation = (heading?.let { -it } ?: 0.0).toFloat()

        canvas.save()
        canvas.rotate(roseRotation, cx, cy)

        // Sweep trail (under the rings): layered wedges + bright leading edge.
        canvas.rotate(sweepDeg, cx, cy)
        rectF.set(cx - radius, cy - radius, cx + radius, cy + radius)
        sweepPaint.shader = sweepShader
        canvas.drawArc(rectF, -RadarModel.SWEEP_HALF_DEG.toFloat(), 70f, true, sweepPaint)
        sweepPaint.shader = sweepCoreShader
        canvas.drawArc(rectF, -RadarModel.SWEEP_HALF_DEG.toFloat(), 26f, true, sweepPaint)
        sweepPaint.shader = null
        // Leading edge: glow halo + neon core.
        val edgeRad = Math.toRadians(-RadarModel.SWEEP_HALF_DEG.toDouble())
        val ex = cx + radius * Math.sin(edgeRad).toFloat()
        val ey = cy - radius * Math.cos(edgeRad).toFloat()
        canvas.drawLine(cx, cy, ex, ey, sweepEdgeGlowPaint)
        canvas.drawLine(cx, cy, ex, ey, sweepEdgePaint)
        canvas.rotate(-sweepDeg, cx, cy)

        // Rings (circles are rotation-invariant — drawn inside for one save).
        for ((px, _) in cachedRings) {
            canvas.drawCircle(cx, cy, px, ringPaint)
        }
        // Cross hairs (whisper-thin now — structure, not grid paper).
        canvas.drawLine(cx - radius, cy, cx + radius, cy, crossPaint)
        canvas.drawLine(cx, cy - radius, cx, cy + radius, crossPaint)

        // Compass ticks: minor every 6°, major every 30°, cardinal 90° white.
        for (deg in 0 until 360 step 6) {
            val rad = Math.toRadians(deg.toDouble())
            val sin = Math.sin(rad).toFloat()
            val cos = Math.cos(rad).toFloat()
            val isCardinal = deg % 90 == 0
            val isMajor = deg % 30 == 0
            if (isCardinal) {
                tickPaint.color = tickCardinal
                tickPaint.strokeWidth = 3.4f
            } else if (isMajor) {
                tickPaint.color = tickMajor
                tickPaint.strokeWidth = 3f
            } else {
                tickPaint.color = tickMinor
                tickPaint.strokeWidth = 1.8f
            }
            val inner = radius - when {
                isCardinal -> 24f
                isMajor -> 14f
                else -> 8f
            }
            canvas.drawLine(
                cx + inner * sin, cy - inner * cos,
                cx + radius * sin, cy - radius * cos,
                tickPaint
            )
        }
        canvas.drawText("ش", cx, cy - radius + 26f, compassPaint)
        canvas.drawText("ق", cx + radius - 2f, cy + 11f, compassPaint)
        canvas.drawText("ج", cx, cy + radius - 14f, compassPaint)
        canvas.drawText("غ", cx - radius + 2f, cy + 11f, compassPaint)

        // Rim: glow halo + neon main stroke (the observatory signature).
        canvas.drawCircle(cx, cy, radius, rimGlowPaint)
        canvas.drawCircle(cx, cy, radius, rimPaint)

        canvas.restore()

        // Ring distance labels stay screen-fixed (they label SIZES, not
        // directions — rotating text reads badly at any card angle).
        for ((px, label) in cachedRings) {
            canvas.drawText(label, cx + px - 2f, cy - 10f, ringLabelPaint)
        }

        // View cone — screen-fixed, opens in front of YOU (up), only when
        // the compass is alive; north-up cards stay exactly as they were.
        if (heading != null && userHasFix) {
            canvas.drawPath(conePath, conePaint)
            canvas.drawPath(conePath, coneEdgePaint)
        }

        // Blips — projected with the heading-adjusted angle (pure math, the
        // same projectInto contract; null heading leaves angles untouched).
        val t = System.currentTimeMillis()
        val pulse = 1f + 0.35f * Math.sin(t / 300.0).toFloat()
        val screenAngleBase = heading ?: 0.0
        // Verified-fire expanding ring phase (1.4s cycle → radius + alpha).
        val ringPhase = ((t % 1400L) / 1400.0).toFloat()
        val ringR = 12f + 16f * ringPhase
        val ringA = (1f - ringPhase) * 150f
        for (blip in blips) {
            val p = RadarModel.projectInto(blip.angleDeg - screenAngleBase, blip.distKm, cx, cy, radius, blipScratch)
            when (blip.kind) {
                RadarModel.Kind.HOTSPOT -> {
                    canvas.drawCircle(p.x, p.y, 17f, hotspotHaloPaint)
                    drawDiamond(canvas, p.x, p.y, 9f, hotspotPaint)
                }
                RadarModel.Kind.PENDING_REPORT -> {
                    canvas.drawCircle(p.x, p.y, 15f, pendingHaloPaint)
                    canvas.drawCircle(p.x, p.y, 8f, pendingPaint)
                }
                RadarModel.Kind.VERIFIED_REPORT -> {
                    verifiedHaloPaint.alpha = ringA.toInt()
                    canvas.drawCircle(p.x, p.y, ringR, verifiedHaloPaint)
                    canvas.drawCircle(p.x, p.y, 10f * pulse, verifiedHaloPaint)
                    canvas.drawCircle(p.x, p.y, 5.5f, verifiedPaint)
                }
                RadarModel.Kind.SAFEZONE -> {
                    canvas.drawCircle(p.x, p.y, 16f, safezoneHaloPaint)
                    drawSquare(canvas, p.x, p.y, 8f, safezonePaint)
                }
                RadarModel.Kind.MESH_INTEL -> {
                    canvas.drawLine(p.x - 8f, p.y - 8f, p.x + 8f, p.y + 8f, meshHaloPaint)
                    canvas.drawLine(p.x - 8f, p.y + 8f, p.x + 8f, p.y - 8f, meshHaloPaint)
                    canvas.drawLine(p.x - 8f, p.y - 8f, p.x + 8f, p.y + 8f, meshPaint)
                    canvas.drawLine(p.x - 8f, p.y + 8f, p.x + 8f, p.y - 8f, meshPaint)
                }
            }
        }

        // Wind arrow: direction the wind COMES FROM, at a fixed offset ring
        // (same heading adjustment as the blips — the whole card agrees).
        windFromDeg?.let { fromDeg ->
            val s = windScratch
            val from = fromDeg - screenAngleBase
            val p = RadarModel.projectInto(from, 27.0, cx, cy, radius, s[0])
            val tail = RadarModel.projectInto(from, 21.0, cx, cy, radius, s[1])
            canvas.drawLine(tail.x, tail.y, p.x, p.y, windGlowPaint)
            canvas.drawLine(tail.x, tail.y, p.x, p.y, windPaint)
            // Arrowhead pointing INWARD (from where the wind arrives).
            val inP = RadarModel.projectInto(from + 180.0, 27.6, cx, cy, radius, s[2])
            val left = RadarModel.projectInto(from + 20.0, 26.0, cx, cy, radius, s[3])
            val right = RadarModel.projectInto(from - 20.0, 26.0, cx, cy, radius, s[4])
            canvas.drawLine(p.x, p.y, left.x, left.y, headPaint)
            canvas.drawLine(p.x, p.y, right.x, right.y, headPaint)
            canvas.drawLine(p.x, p.y, inP.x, inP.y, headPaint)
        }

        // User triangle at center — breathing glow ring + halo + core (or a
        // dimmed dot when no fix yet).
        if (userHasFix) {
            val breathPhase = ((t % 2200L) / 2200.0).toFloat()
            userBreathPaint.alpha = ((1f - breathPhase) * 120f).toInt()
            canvas.drawCircle(cx, cy, 14f + 14f * breathPhase, userBreathPaint)
            canvas.drawCircle(cx, cy, 20f, userGlowPaint)
            trianglePath.rewind()
            trianglePath.moveTo(cx, cy - 14f)
            trianglePath.lineTo(cx - 10f, cy + 10f)
            trianglePath.lineTo(cx + 10f, cy + 10f)
            trianglePath.close()
            canvas.drawPath(trianglePath, userPaint)
        } else {
            userPaint.alpha = 90
            canvas.drawCircle(cx, cy, 8f, userPaint)
            userPaint.alpha = 255
        }
    }

    private fun drawDiamond(canvas: Canvas, x: Float, y: Float, r: Float, paint: Paint) {
        diamondPath.rewind()
        diamondPath.moveTo(x, y - r)
        diamondPath.lineTo(x + r, y)
        diamondPath.lineTo(x, y + r)
        diamondPath.lineTo(x - r, y)
        diamondPath.close()
        canvas.drawPath(diamondPath, paint)
    }

    private fun drawSquare(canvas: Canvas, x: Float, y: Float, r: Float, paint: Paint) {
        // 2025 rounding: a rounded square, not a raw rect.
        rectF.set(x - r, y - r, x + r, y + r)
        canvas.drawRoundRect(rectF, 3.5f, 3.5f, paint)
    }
}
