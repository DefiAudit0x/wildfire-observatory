package com.observatory.wildfire

/**
 * v2.0.0 (native UI) — radar HUD projection, Android-free.
 *
 * The user asked for the "stone age" radar to become a real instrument. The
 * native RadarView paints THIS model: all the math (range mapping, bearing →
 * screen coordinates, ring radii) is decided here where unit tests can pin
 * the conventions, and the View is a dumb painter.
 *
 * Conventions (life-threatening if mirrored):
 *  - bearing 0° = NORTH = screen UP, 90° = east = screen RIGHT;
 *  - distance maps LINEARLY onto the sweep radius, clamped at RANGE_KM;
 *  - blips beyond range are reported insideRange=false and clamped to the
 *    rim (so the user still sees "something that way" without a false
 *    impression of proximity).
 */
object RadarModel {

    const val RANGE_KM = 30.0
    val RING_KM = intArrayOf(5, 10, 20, 30)

    enum class Kind { HOTSPOT, PENDING_REPORT, VERIFIED_REPORT, SAFEZONE, MESH_INTEL }

    data class Blip(val angleDeg: Double, val distKm: Double, val kind: Kind, val label: String = "")

    data class ScreenPoint(val x: Float, val y: Float, val insideRange: Boolean)

    /**
     * v2.16.0 (audit wave 3 — per-frame allocation hygiene): a REUSABLE
     * projection target. onDraw runs at display cadence; the immutable
     * ScreenPoint allocates once per blip per frame. Hot paths use
     * projectInto() with a scratch holder instead — same math, single
     * source of truth (project() delegates to projectInto()).
     */
    class MutableScreenPoint {
        var x: Float = 0f
        var y: Float = 0f
        var insideRange: Boolean = false
    }

    fun projectInto(
        angleDeg: Double,
        distKm: Double,
        cx: Float,
        cy: Float,
        radiusPx: Float,
        out: MutableScreenPoint
    ): MutableScreenPoint {
        val clampedKm = distKm.coerceIn(0.0, RANGE_KM)
        val r = radiusPx * (clampedKm / RANGE_KM).toFloat()
        val rad = Math.toRadians(angleDeg)
        // 0° up, clockwise: x = cx + r·sin(θ), y = cy − r·cos(θ)
        out.x = cx + (r * Math.sin(rad)).toFloat()
        out.y = cy - (r * Math.cos(rad)).toFloat()
        out.insideRange = distKm <= RANGE_KM
        return out
    }

    fun project(angleDeg: Double, distKm: Double, cx: Float, cy: Float, radiusPx: Float): ScreenPoint {
        val out = projectInto(angleDeg, distKm, cx, cy, radiusPx, MutableScreenPoint())
        return ScreenPoint(out.x, out.y, out.insideRange)
    }

    /** Bearing + distance from the user to a lat/lng — the blip factory. */
    fun blipFrom(userLat: Double, userLng: Double, lat: Double, lng: Double, kind: Kind, label: String = ""): Blip {
        val distKm = TeamLocationLogic.haversineMeters(userLat, userLng, lat, lng) / 1000.0
        val bearing = GeoMath.bearingDeg(userLat, userLng, lat, lng)
        return Blip(bearing, distKm, kind, label)
    }

    /** Ring radii in px + their km labels, outermost first. */
    fun rings(radiusPx: Float): List<Pair<Float, Int>> =
        RING_KM.sortedDescending().map { km ->
            (radiusPx * (km.toDouble() / RANGE_KM)).toFloat() to km
        }

    /**
     * Sweep sector half-angle for the trailing gradient wedge. The sweep is
     * a 70°-wide sector whose LEADING edge sits at sweepDeg.
     */
    const val SWEEP_HALF_DEG = 35.0
}
