package com.observatory.wildfire

/**
 * v2.0.0 (native UI) — threat scoring for the observatory screen, Android-free.
 *
 * Mirrors the intent of the web dashboard's risk gauge (/100) with a
 * deterministic, unit-tested formula: verified field reports weigh more than
 * pending ones, critical weighs more than everything, and satellite hotspots
 * add a capped bonus. Pure addition/clamp — no randomness, no time (freshness
 * filtering is ProximityLogic's job and happens BEFORE scoring).
 */
object RiskScore {

    // Verified report weights by severity.
    const val W_VERIFIED_CRITICAL = 25
    const val W_VERIFIED_HIGH = 12
    const val W_VERIFIED_MEDIUM = 6
    const val W_VERIFIED_LOW = 2

    // Pending reports count half — unverified intel must move the needle
    // without letting spam dominate the gauge.
    const val PENDING_FACTOR = 0.5

    // Satellite hotspots (confidence >= 70): +1 each, capped.
    const val HOTSPOT_BONUS_MAX = 25

    fun severityWeight(severity: String, verified: Boolean): Double {
        // All branches Int (a mixed Int/Double `when` would infer a useless
        // common supertype and break toDouble() — the CI round-1 lesson).
        val base = when (severity) {
            "critical" -> W_VERIFIED_CRITICAL
            "high" -> W_VERIFIED_HIGH
            "medium" -> W_VERIFIED_MEDIUM
            "low" -> W_VERIFIED_LOW
            else -> 0
        }
        return if (verified) base.toDouble() else base * PENDING_FACTOR
    }

    /**
     * @param reports (severity, statusIsVerifiedOrResolved counts as verified
     *                weight; pending/rejected count half/zero)
     * @param strongHotspots count of satellite detections with confidence >= 70
     * @return integer score 0..100
     */
    fun score(reports: List<Pair<String, Boolean>>, strongHotspots: Int): Int {
        var sum = 0.0
        for ((severity, verified) in reports) {
            val w = severityWeight(severity, verified)
            if (verified && severity == "rejected") continue
            if (!verified && severity == "rejected") continue
            sum += w
        }
        val hotspotBonus = strongHotspots.coerceAtLeast(0).coerceAtMost(HOTSPOT_BONUS_MAX)
        val total = sum + hotspotBonus
        return Math.round(total).toInt().coerceIn(0, 100)
    }

    /** Label buckets mirrored from the web gauge's Arabic labels. */
    fun labelAr(score: Int): String = when {
        score >= 75 -> "خطر كارثي"
        score >= 50 -> "خطر مرتفع"
        score >= 25 -> "خطر متوسط"
        score > 0 -> "خطر منخفض"
        else -> "لا خطر مرصود"
    }
}
