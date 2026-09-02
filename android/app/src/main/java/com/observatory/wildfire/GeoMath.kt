package com.observatory.wildfire

/**
 * v2.0.0 (native UI) — pure geometry for the field screens. Android-free by
 * design (same house pattern as TeamLocationLogic/MeshWire): every function
 * here must run on the JVM in unit tests with zero android.jar involvement.
 *
 * Haversine distance deliberately lives in TeamLocationLogic (it predates
 * this object and its server twin is verified there); everything else the
 * native map/radar/SOS screens need is here.
 */
object GeoMath {

    const val EARTH_RADIUS_M = 6_371_000.0

    /**
     * Initial bearing (0..360, 0 = north, clockwise) from point 1 to point 2.
     * This is the angle the native radar uses to place a blip around the
     * user: 0° must paint UP (north), 90° RIGHT (east) — the unit tests pin
     * that convention because a mirrored radar is a life-threatening bug.
     */
    fun bearingDeg(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
        val radLat1 = Math.toRadians(lat1)
        val radLat2 = Math.toRadians(lat2)
        val dLng = Math.toRadians(lng2 - lng1)
        val y = Math.sin(dLng) * Math.cos(radLat2)
        val x = Math.cos(radLat1) * Math.sin(radLat2) -
            Math.sin(radLat1) * Math.cos(radLat2) * Math.cos(dLng)
        val deg = Math.toDegrees(Math.atan2(y, x))
        return (deg + 360.0) % 360.0
    }

    /**
     * Spherical destination point: start + bearing + distance. Used by the
     * map screen to draw the accuracy circle and by the radar tests to
     * round-trip bearing/distance. Lat in -90..90, normalized lng.
     */
    fun destinationPoint(lat: Double, lng: Double, bearingDeg: Double, distanceM: Double): Pair<Double, Double> {
        val angular = distanceM / EARTH_RADIUS_M
        val theta = Math.toRadians(bearingDeg)
        val radLat = Math.toRadians(lat)
        val radLng = Math.toRadians(lng)
        val destLat = Math.asin(
            Math.sin(radLat) * Math.cos(angular) +
                Math.cos(radLat) * Math.sin(angular) * Math.cos(theta)
        )
        val destLng = radLng + Math.atan2(
            Math.sin(theta) * Math.sin(angular) * Math.cos(radLat),
            Math.cos(angular) - Math.sin(radLat) * Math.sin(destLat)
        )
        val normLng = Math.toDegrees(destLng)
        return Math.toDegrees(destLat) to ((normLng + 540.0) % 360.0 - 180.0)
    }

    /**
     * Distance in METERS from point P to the great-circle-ish segment A-B,
     * using a local equirectangular projection around the segment midpoint.
     * Accurate to well under a percent at evacuation-route scales (<300 km),
     * which is what the route fire-proximity check needs. Cross-track only:
     * beyond the segment ends the distance is to the nearest endpoint.
     */
    fun pointSegmentDistanceM(
        pLat: Double, pLng: Double,
        aLat: Double, aLng: Double,
        bLat: Double, bLng: Double
    ): Double {
        // Degenerate segment → plain distance to the single point.
        if (aLat == bLat && aLng == bLng) {
            return TeamLocationLogic.haversineMeters(pLat, pLng, aLat, aLng)
        }
        val midLat = (aLat + bLat) / 2.0
        val midLng = (aLng + bLng) / 2.0
        val kx = Math.cos(Math.toRadians(midLat)) * 111_320.0 // meters per degree lng at mid lat
        val ky = 110_540.0                                    // meters per degree lat
        fun xy(lat: Double, lng: Double): Pair<Double, Double> =
            (lng - midLng) * kx to (lat - midLat) * ky
        val (px, py) = xy(pLat, pLng)
        val (ax, ay) = xy(aLat, aLng)
        val (bx, by) = xy(bLat, bLng)
        val dx = bx - ax
        val dy = by - ay
        val len2 = dx * dx + dy * dy
        if (len2 <= 0.0) return TeamLocationLogic.haversineMeters(pLat, pLng, aLat, aLng)
        val t = (((px - ax) * dx + (py - ay) * dy) / len2).coerceIn(0.0, 1.0)
        val cx = ax + t * dx
        val cy = ay + t * dy
        val ex = px - cx
        val ey = py - cy
        return Math.sqrt(ex * ex + ey * ey)
    }

    /**
     * Minimum distance from point P to a polyline (route geometry). Returns
     * Double.MAX_VALUE for an empty/degenerate list so callers treat "no
     * route" as "no fire on route" rather than the 0m bug.
     */
    fun minDistanceToPolylineM(pLat: Double, pLng: Double, route: List<Pair<Double, Double>>): Double {
        if (route.isEmpty()) return Double.MAX_VALUE
        if (route.size == 1) {
            return TeamLocationLogic.haversineMeters(pLat, pLng, route[0].first, route[0].second)
        }
        var best = Double.MAX_VALUE
        for (i in 0 until route.size - 1) {
            val a = route[i]
            val b = route[i + 1]
            val d = pointSegmentDistanceM(pLat, pLng, a.first, a.second, b.first, b.second)
            if (d < best) best = d
        }
        return best
    }
}
