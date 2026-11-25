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
            // F18: the two original lines (verified+rejected, unverified+rejected)
            // were a duplicated guard — one check covers both arms.
            if (severity == "rejected") continue
            sum += w
        }
        val hotspotBonus = strongHotspots.coerceAtLeast(0).coerceAtMost(HOTSPOT_BONUS_MAX)
        val total = sum + hotspotBonus
        return Math.round(total).toInt().coerceIn(0, 100)
    }

    /** Label buckets aligned with the v2.16.0 five-level color bands
     *  (Low / Moderate / High / Very High / Extreme) — Fix 53 (NOBS-4):
     *  the old 25/50/75 thresholds disagreed with the 20-point bands. */
    fun labelAr(score: Int): String = when {
        score >= 80 -> "خطر كارثي"
        score >= 60 -> "خطر مرتفع جدًا"
        score >= 40 -> "خطر مرتفع"
        score >= 20 -> "خطر متوسط"
        score > 0 -> "خطر منخفض"
        else -> "لا توجد مؤشرات خطر حالية"
    }

    /** The single source for the 5 band colors (Fix 57, NRESBG-1) —
     *  the same bands labelAr uses. The observatory track gradient and
     *  the score text both read from here, so the drawable and the code
     *  can never disagree again (the old bg_risk_track.xml defined 3
     *  stops that matched neither the bands nor the code colors). */
    fun bandColor(score: Int): Int = when {
        score < 20 -> 0xFFC5D9BF.toInt() // 1 — Low (pale sage)
        score < 40 -> 0xFF8DB63C.toInt() // 2 — Moderate (lime green)
        score < 60 -> 0xFFFF6B35.toInt() // 3 — High (brand orange)
        score < 80 -> 0xFFF04E1F.toInt() // 4 — Very High (burnt orange)
        else -> 0xFFD21034.toInt()       // 5 — Extreme (brand red)
    }
}
