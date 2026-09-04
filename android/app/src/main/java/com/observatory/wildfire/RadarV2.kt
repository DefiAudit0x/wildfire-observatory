package com.observatory.wildfire

/**
 * v2.10.0 (S4 Radar v2) — pure decision layer for the integrated operational
 * map, Android-free by design (GeoMath/TeamLocationLogic house pattern): every
 * function here runs on the JVM in unit tests with zero android.jar.
 *
 * What S4 fuses into ONE native screen (all feeds real, nothing simulated —
 * the v2.3.0 purge discipline holds here too):
 *  - Live wind → drift heading + spread cone + wind chip. The wind itself is
 *    already fetched into the repository snapshot (WeatherNow, Open-Meteo,
 *    same provider the web EvacuationRadar calls client-direct) — parsing
 *    stays device-side in Models.parseWeather; this layer owns the DECISIONS.
 *  - Metric range rings (7.5/15/22.5/30 km) mirroring the web radar's ring spec.
 *  - OSRM route ALTERNATIVES ranked SAFETY-FIRST (max distance from fire beats
 *    shortest duration; the web never had this — the map corridor check now
 *    chooses between options instead of only warning on one).
 *  - AI situation briefing (POST /api/ai/guidance — server-side prompt
 *    sanitizing, rate limiting and fallback already exist there; this layer
 *    only mirrors the web client's cache/interval discipline).
 *
 * Honesty rules pinned here (tests enforce them):
 *  - No wind reading → no cone, no drift hint. Never a fabricated default.
 *  - Route with unknown fire distance can NOT claim "safest".
 *  - AI cache expires after 1h and identical requests wait ≥5s apart, so the
 *    6/min server limiter is never leaned on by hammering.
 */
object RadarV2 {

    // ---------- Wind decisions (input = Models.WeatherNow fields) ----------

    /**
     * Meteorological FROM direction → the direction a fire/smoke DRIFTS
     * toward (downwind). Identical arithmetic to the web EvacuationRadar
     * (driftHeading). A mirrored cone would point people INTO the fire, so
     * this is pinned by tests.
     */
    fun driftHeading(windFromDeg: Int): Int = (windFromDeg + 180) % 360

    /**
     * Plain-language wind descriptor for the map chip (honest, no model
     * claim — thresholds are Beaufort-ish, tuned for fire-spread awareness).
     */
    fun windBrief(speedKmh: Double): String = when {
        speedKmh < 2.0 -> "رياح هادئة"
        speedKmh < 12.0 -> "رياح خفيفة"
        speedKmh < 29.0 -> "رياح معتدلة"
        speedKmh < 49.0 -> "رياح قوية — خطر الانتشار مرتفع"
        else -> "رياح عاتية — خطر انتشار حرج"
    }

    /** Chip numerals stay western/dot-formatted (Locale.US) for consistency
     *  with the resource-formatted distances the map already prints. */
    fun speedLabel(kmh: Double): String =
        String.format(java.util.Locale.US, if (kmh >= 100.0) "%.0f" else "%.1f", kmh)

    fun tempLabel(celsius: Double): String =
        String.format(java.util.Locale.US, "%.0f", celsius)

    // ---------- Radar geometry (rings + spread cone) ----------

    /** Web radar ring spec: 4 metric rings inside a 30 km sweep. */
    val RANGE_RINGS_KM = doubleArrayOf(7.5, 15.0, 22.5, 30.0)
    const val RADAR_RANGE_KM = 30.0

    /** Web spread cone: ±22° sector, drawn out to 55% of the range. */
    const val CONE_HALF_ANGLE_DEG = 22.0
    const val CONE_RADIUS_FRACTION = 0.55

    /** Cone reach in km (16.5 at the web spec). */
    fun coneRadiusKm(): Double = RADAR_RANGE_KM * CONE_RADIUS_FRACTION

    /**
     * Great-circle destination point: start, initial bearing (0=north,
     * clockwise), distance. Standard spherical formulas with the SAME earth
     * radius GeoMath uses, so ring radii and corridor math agree.
     */
    fun destinationPoint(latDeg: Double, lngDeg: Double, bearingDeg: Double, distanceKm: Double): Pair<Double, Double> {
        val rKm = GeoMath.EARTH_RADIUS_M / 1000.0
        val delta = distanceKm / rKm
        val theta = Math.toRadians(bearingDeg)
        val phi1 = Math.toRadians(latDeg)
        val lam1 = Math.toRadians(lngDeg)
        val sinPhi2 = Math.sin(phi1) * Math.cos(delta) +
            Math.cos(phi1) * Math.sin(delta) * Math.cos(theta)
        val phi2 = Math.asin(sinPhi2)
        val lam2 = lam1 + Math.atan2(
            Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
            Math.cos(delta) - Math.sin(phi1) * sinPhi2
        )
        val lngOut = Math.toDegrees(lam2)
        return Math.toDegrees(phi2) to ((lngOut + 540.0) % 360.0 - 180.0)
    }

    /** A closed ring around (lat,lng) as polygon points, first == last. */
    fun circleGeoPoints(lat: Double, lng: Double, radiusKm: Double, steps: Int = 48): List<Pair<Double, Double>> {
        if (steps < 8 || radiusKm <= 0.0) return emptyList()
        val pts = ArrayList<Pair<Double, Double>>(steps + 1)
        for (i in 0 until steps) {
            val brg = i * 360.0 / steps
            pts.add(destinationPoint(lat, lng, brg, radiusKm))
        }
        pts.add(pts.first())
        return pts
    }

    /**
     * Spread-cone polygon for an osmdroid Polygon: the center vertex followed
     * by the arc from drift−22° to drift+22° (the overlay auto-closes the
     * shape back to the center). Empty list when drift is unknown — no wind,
     * no cone, per the honesty rule.
     */
    fun coneGeoPoints(lat: Double, lng: Double, driftHeadingDeg: Int?, steps: Int = 20): List<Pair<Double, Double>> {
        val drift = driftHeadingDeg ?: return emptyList()
        if (steps < 4) return emptyList()
        val r = coneRadiusKm()
        val pts = ArrayList<Pair<Double, Double>>(steps + 2)
        pts.add(lat to lng)
        for (i in 0..steps) {
            val angle = drift - CONE_HALF_ANGLE_DEG + (2 * CONE_HALF_ANGLE_DEG) * i / steps
            pts.add(destinationPoint(lat, lng, angle, r))
        }
        return pts
    }

    // ---------- Route alternatives (safety-first ranking) ----------

    /** Same corridor threshold the map route warning has always used. */
    const val ROUTE_FIRE_WARNING_M = 2_500.0

    /** One OSRM alternative with its measured fire-corridor clearance. */
    data class RouteOption(
        val points: List<Pair<Double, Double>>,
        val distanceM: Double,
        val durationS: Double,
        val minFireDistanceM: Double,
    ) {
        /** Unknown clearance must never masquerade as safe — NaN fails open to "crosses". */
        val crossesFire: Boolean
            get() = minFireDistanceM.isNaN() || minFireDistanceM < ROUTE_FIRE_WARNING_M
    }

    /**
     * SAFETY-FIRST ranking: the route whose whole length stays farthest from
     * any fire wins; equal clearance → shorter drive time wins. Routes with
     * no points sink to the end. Does not mutate the input.
     *
     * v2.15.0 audit fix: Kotlin Double ordering ranks NaN GREATER than every
     * finite value, so an unknown-clearance route used to rank FIRST — the
     * exact opposite of the NaN-fails-open honesty contract below. Unknown
     * clearance now sorts as negative (sinks last); it can still be drawn,
     * but it never claims "Safest" while a known-clearance route exists.
     */
    fun rankRoutes(options: List<RouteOption>): List<RouteOption> =
        options.filter { it.points.isNotEmpty() }
            .sortedWith(
                compareByDescending<RouteOption> { if (it.minFireDistanceM.isNaN()) -1.0 else it.minFireDistanceM }
                    .thenBy { it.durationS }
            )

    /** The route the map draws by default (safest of the alternatives). */
    fun pickSafest(options: List<RouteOption>): RouteOption? = rankRoutes(options).firstOrNull()

    // ---------- AI briefing client discipline (mirrors web AICopilot) ----------

    const val AI_CACHE_TTL_MS = 60L * 60L * 1000L          // 1h, as the web
    const val AI_MIN_REQUEST_INTERVAL_MS = 5_000L          // 5s spacing, as the web

    /** Cached briefing still fresh? */
    fun aiCacheFresh(cachedAtMs: Long, nowMs: Long): Boolean =
        cachedAtMs > 0 && nowMs >= cachedAtMs && (nowMs - cachedAtMs) < AI_CACHE_TTL_MS

    /** May a new guidance request go out (5s spacing since the last)? */
    fun aiRequestAllowed(lastRequestMs: Long, nowMs: Long): Boolean =
        lastRequestMs <= 0 || (nowMs >= lastRequestMs && (nowMs - lastRequestMs) >= AI_MIN_REQUEST_INTERVAL_MS)

    /**
     * Cache key shape shared with the web's ai_guidance_ keys: hour-bucketed
     * so a cached briefing never crosses an hour boundary even if TTL check
     * was skipped by a caller.
     */
    fun aiCacheKey(lat: Double?, lng: Double?, lang: String, hourBucket: Long): String =
        "ai_guidance_${lang}_${lat ?: "none"}_${lng ?: "none"}_$hourBucket"
}
