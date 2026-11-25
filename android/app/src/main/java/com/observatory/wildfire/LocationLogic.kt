package com.observatory.wildfire

/**
 * v2.0.0 (native UI) — location status machine + fix selection, Android-free.
 *
 * THE field bug this app version exists for: "تحديد الموقع لا يشتغل". The
 * WebView stack made geolocation depend on an origin-gated browser prompt
 * chain the user could neither see nor debug. The native engine owns the
 * LocationManager directly, and THIS object owns every user-visible verdict:
 * the UI never invents a status, it renders what this machine computed from
 * (permission, providers, fix age) — so the reason a fix is missing is always
 * explainable on screen.
 */
object LocationLogic {

    const val FIX_FRESH_MS = 60_000L          // < 1 min: live fix
    const val FIX_STALE_DROP_MS = 10 * 60_000L // > 10 min: too old to trust
    // v2.15.0 audit fix: a FUTURE fix timestamp (clock skew or a hostile
    // source) used to pass every gate — (now - future) was negative, so it
    // read as "fresher than fresh" and ranked first in chooseBest. One
    // shared skew allowance now bounds how far ahead a timestamp may lie.
    const val CLOCK_SKEW_MS = 60_000L
    const val SEARCHING_AFTER_MS = 15_000L     // no fix within 15s → "searching"
    // Fix 53 (NMAP-5): GPS speed at/above this is "moving" — the map arrow
    // shows GPS course; below it (or with no speed) it shows the compass.
    // A judgment call, not a measured value: GPS noise at standstill is
    // typically below it, walking is ~1.2 m/s and up.
    const val MIN_MOVING_SPEED_MPS = 0.5f

    enum class Status {
        /** Runtime permission not granted — the ONLY fix is the user granting it. */
        NO_PERMISSION,
        /** Permission granted but every location provider is switched off. */
        PROVIDERS_OFF,
        /** Providers on, listening, but no usable fix yet. */
        SEARCHING,
        /** Usable fix in hand (fresh or stale — accuracy/age travel with it). */
        FIXED
    }

    /**
     * v2.16.0 (audit wave 3 — permission tier): Android 12+ lets the user
     * grant ONLY approximate (coarse) location while denying precise (fine).
     * The old engine keyed everything on ACCESS_FINE_LOCATION, so a
     * coarse-only grant — a perfectly valid system state — rendered as
     * NO_PERMISSION: the app showed "grant permission" while the system
     * showed "location granted", and every map/SOS feature died.
     *
     *  - NONE: no location permission at all;
     *  - COARSE: approximate only — NETWORK-class fixes, honest about it;
     *  - FINE: precise — GPS + NETWORK, full fidelity.
     */
    enum class Tier { NONE, COARSE, FINE }

    data class FixSnapshot(
        val lat: Double,
        val lng: Double,
        val accuracyM: Float,
        val timeMs: Long,
        val provider: String,
        /** v2.16.0: true when the grant tier is COARSE — the fix is a
         *  network-class approximation and the UI may say so. */
        val approximate: Boolean = false,
        /** v2.19.0: GPS course-over-ground (0..360) while moving — the map's
         *  user arrow prefers this over the compass (motion truth beats
         *  magnetometer). Null when stationary/no bearing. */
        val bearingDeg: Double? = null,
        /** Fix 52 (NLOC-1): true only when the provider reported an accuracy.
         *  A snapshot without one stores 0f in accuracyM, which must never be
         *  displayed as "0 m" — the UI shows "unknown" instead. */
        val hasAccuracy: Boolean = false,
        /** Fix 53 (NMAP-5): GPS speed in m/s at fix time, null when the
         *  provider reported none. The map arrow uses it (with freshness)
         *  to decide GPS course vs compass — see displayBearing. */
        val speedMps: Float? = null
    )

    /**
     * The single verdict function. Everything the UI shows about GPS flows
     * through here, so tests pin every combination once.
     *
     * @param permissionTier v2.16.0: NONE / COARSE (approximate only) / FINE
     * @param gpsEnabled / networkEnabled provider switches (Settings)
     * @param lastFixAgeMs age of the best fix in hand, null = none yet
     */
    fun computeStatus(
        permissionTier: Tier,
        gpsEnabled: Boolean,
        networkEnabled: Boolean,
        lastFixAgeMs: Long?
    ): Status {
        if (permissionTier == Tier.NONE) return Status.NO_PERMISSION
        // Fix 52b (NLOGL-1): a usable fix already in hand is never demoted
        // by the providers-off verdict — while the fix is inside the shared
        // freshness window (Fix 52 NLOGL-2: -CLOCK_SKEW_MS..FIX_STALE_DROP_MS)
        // the honest verdict is FIXED, even if the providers have since been
        // switched off. Only when there is no usable fix does the tier-aware
        // providers-off rule apply.
        val age = lastFixAgeMs
        if (age != null && age in -CLOCK_SKEW_MS..FIX_STALE_DROP_MS) return Status.FIXED
        // Fix 52 (NLOGL-1): COARSE has exactly one usable provider (NETWORK) —
        // a coarse user with GPS on but network off has NO provider to listen
        // to, so the verdict is PROVIDERS_OFF, not SEARCHING.
        val providersOff = when (permissionTier) {
            Tier.COARSE -> !networkEnabled
            else -> !gpsEnabled && !networkEnabled
        }
        if (providersOff) return Status.PROVIDERS_OFF
        return Status.SEARCHING
    }

    /** Legacy boolean form — a `true` here always meant FINE. Kept for the
     *  existing call sites/tests; new code should pass the tier. */
    fun computeStatus(
        permissionGranted: Boolean,
        gpsEnabled: Boolean,
        networkEnabled: Boolean,
        lastFixAgeMs: Long?
    ): Status = computeStatus(
        if (permissionGranted) Tier.FINE else Tier.NONE,
        gpsEnabled, networkEnabled, lastFixAgeMs
    )

    /**
     * Pick the best fix among providers' lastKnownLocation snapshots.
     * Score = freshness wins first (a 30s-old network fix beats a 5-min-old
     * GPS lock for a moving user), accuracy breaks near-ties. Deterministic
     * so the map/SOS/radar all display the SAME chosen fix.
     */
    fun chooseBest(fixes: List<FixSnapshot>, nowMs: Long): FixSnapshot? {
        val usable = fixes.filter {
            it.lat.isFinite() && it.lng.isFinite() &&
                it.timeMs > 0 &&
                (nowMs - it.timeMs) >= -CLOCK_SKEW_MS && // never a future fix beyond skew
                (nowMs - it.timeMs) <= FIX_STALE_DROP_MS
        }
        if (usable.isEmpty()) return null
        return usable.minByOrNull { fix ->
            val ageScore = (nowMs - fix.timeMs).toDouble()          // fresher first
            // Fix 52 (NLOC-1): a missing accuracy used to score as PERFECT
            // (0f wins ties). Unknown accuracy now scores the maximum
            // tie-break penalty instead, so a measured fix beats it.
            val accScore = if (fix.hasAccuracy) {
                fix.accuracyM.coerceAtLeast(0f).toDouble() * 1_000.0
            } else {
                15_000.0
            }
            // Accuracy acts only as a tie-breaker below 15s of freshness gap.
            ageScore + accScore.coerceAtMost(15_000.0)
        }
    }

    /** True when a fix is presentable as "live" on screen. */
    fun isFreshFix(fix: FixSnapshot?, nowMs: Long): Boolean =
        fix != null &&
            (nowMs - fix.timeMs) >= -CLOCK_SKEW_MS && // v2.15.0: never future
            (nowMs - fix.timeMs) <= FIX_FRESH_MS

    /**
     * Fix 53 (NMAP-5): which heading the map arrow shows. GPS course wins
     * only while the user is actually moving — a fresh fix whose speed is
     * above MIN_MOVING_SPEED_MPS. A standing fix (speed at/below the
     * threshold, or no speed reported) and a stale fix both fall back to
     * the compass; with neither, there is no heading to show. The freshness
     * half is load-bearing: a retained fix captured while moving still
     * carries its old speed, so speed alone would keep shadowing the
     * compass after the user stops.
     */
    fun displayBearing(fix: FixSnapshot?, compassDeg: Double?, nowMs: Long): Double? {
        if (fix?.bearingDeg != null && isFreshFix(fix, nowMs) &&
            fix.speedMps != null && fix.speedMps > MIN_MOVING_SPEED_MPS
        ) return fix.bearingDeg
        return compassDeg
    }

    /**
     * Fix 20: true when a fix is a real recent measurement (≤ 10 min),
     * not live. The bar for actions that must not be refused for want of
     * a 60 s lock (report submit, SOS) — always with age disclosure in
     * the UI. Shares the skew rule with [isFreshFix].
     */
    fun isUsableFix(fix: FixSnapshot?, nowMs: Long): Boolean =
        fix != null &&
            (nowMs - fix.timeMs) >= -CLOCK_SKEW_MS &&
            (nowMs - fix.timeMs) <= FIX_STALE_DROP_MS
}
