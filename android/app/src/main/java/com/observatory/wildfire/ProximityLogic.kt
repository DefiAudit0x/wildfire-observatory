package com.observatory.wildfire

/**
 * v2.0.0 (native UI) — proximity alert rules, Android-free.
 *
 * The native observatory banner and the SOS "nearby fire" warning share this
 * ONE authority (the v1.0.4 web lesson: banner and SOS must never disagree).
 *
 * FIRMS semantics fixed in v1.0.4 apply here too: a satellite scanTime is the
 * OVERPASS moment, typically 10+ minutes before the app sees it — so the
 * freshness window is the same 30 minutes the web uses (isFreshThreatTimestamp),
 * never a "3 minutes ago" test that would reject every real hotspot forever.
 */
object ProximityLogic {

    const val THREAT_MAX_AGE_MS = 30 * 60_000L // mirrors THREAT_MAX_AGE_MS in src/utils/threats.ts

    // Alert ladder (distance from the USER to the freshest threat).
    const val CRITICAL_KM = 2.0
    const val WARNING_KM = 5.0
    const val WATCH_KM = 10.0

    enum class Level { CRITICAL, WARNING, WATCH }

    data class ThreatPin(val lat: Double, val lng: Double, val timestampMs: Long)

    fun isFresh(timestampMs: Long, nowMs: Long): Boolean {
        if (timestampMs <= 0L) return false
        val age = nowMs - timestampMs
        // Future timestamps beyond a small clock-skew allowance are hostile
        // data (garbled clocks), not "extra fresh".
        if (age < -60_000L) return false
        return age <= THREAT_MAX_AGE_MS
    }

    /**
     * Highest alert level among fresh threats, or null when the user is safe.
     * Distance uses the haversine twin in TeamLocationLogic (server-verified
     * formula). Stale threats NEVER trigger — an old blip is not a fire.
     */
    fun evaluate(
        userLat: Double,
        userLng: Double,
        threats: List<ThreatPin>,
        nowMs: Long
    ): Level? {
        var best: Level? = null
        for (t in threats) {
            if (!isFresh(t.timestampMs, nowMs)) continue
            if (!t.lat.isFinite() || !t.lng.isFinite()) continue
            val km = TeamLocationLogic.haversineMeters(userLat, userLng, t.lat, t.lng) / 1000.0
            val level = when {
                km <= CRITICAL_KM -> Level.CRITICAL
                km <= WARNING_KM -> Level.WARNING
                km <= WATCH_KM -> Level.WATCH
                else -> null
            } ?: continue
            best = when (best) {
                null, Level.WATCH -> level
                Level.WARNING -> if (level == Level.CRITICAL) level else best
                Level.CRITICAL -> best
            }
            if (best == Level.CRITICAL) return Level.CRITICAL
        }
        return best
    }

    /** Nearest fresh threat distance in km, or null when none are fresh. */
    fun nearestFreshKm(userLat: Double, userLng: Double, threats: List<ThreatPin>, nowMs: Long): Double? {
        var best: Double? = null
        for (t in threats) {
            if (!isFresh(t.timestampMs, nowMs)) continue
            // v2.15.0 audit fix: same validation contract as evaluate() — a
            // NaN-coordinate pin made km = NaN, and since `km < NaN` is
            // always false, one poisoned pin permanently returned NaN and
            // rendered a literal "NaN" in the proximity banner.
            if (!t.lat.isFinite() || !t.lng.isFinite() ||
                t.lat < -90.0 || t.lat > 90.0 || t.lng < -180.0 || t.lng > 180.0
            ) continue
            val km = TeamLocationLogic.haversineMeters(userLat, userLng, t.lat, t.lng) / 1000.0
            if (!km.isFinite()) continue
            if (best == null || km < best) best = km
        }
        return best
    }
}
