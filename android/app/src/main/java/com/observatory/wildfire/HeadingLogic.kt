package com.observatory.wildfire

/**
 * v2.19.0 — heading math, Android-free (unit tests pin the conventions).
 *
 * The radar went from a decorative sweep to a real instrument: the rose,
 * ticks and blips rotate with the DEVICE heading (heading-up card). Two
 * pieces of pure math live here so both the sensor engine and the tests
 * share one authority:
 *
 *  - angleDeltaDeg: shortest signed rotation a→b on the 0..360 circle;
 *  - smoothAngleDeg: circular exponential smoothing (a plain lerp would
 *    explode when crossing the 359→1 wrap — the classic compass jitter).
 */
object HeadingLogic {

    /** Shortest signed delta b−a in (−180, 180]. e.g. (350, 10) → +20. */
    fun angleDeltaDeg(from: Double, to: Double): Double {
        var d = (to - from) % 360.0
        if (d > 180.0) d -= 360.0
        if (d <= -180.0) d += 360.0
        return d
    }

    /**
     * Circular exponential smoothing: prev + α·(shortest delta toward next).
     * α=1 snaps (no smoothing), α=0 freezes. 0.25 @ ~4 Hz ≈ the 0.4 s the
     * web 360-alpha compass family feels like — responsive, not twitchy.
     */
    fun smoothAngleDeg(prev: Double, next: Double, alpha: Double): Double {
        val a = alpha.coerceIn(0.0, 1.0)
        if (prev.isNaN()) return next
        val d = angleDeltaDeg(prev, next)
        val v = prev + a * d
        return (v % 360.0 + 360.0) % 360.0
    }

    /** Normalize any raw azimuth into [0, 360). */
    fun normalizeDeg(raw: Double): Double {
        val v = raw % 360.0
        return if (v < 0) v + 360.0 else v
    }
}
