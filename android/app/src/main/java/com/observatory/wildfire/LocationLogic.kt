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
    const val SEARCHING_AFTER_MS = 15_000L     // no fix within 15s → "searching"

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

    data class FixSnapshot(
        val lat: Double,
        val lng: Double,
        val accuracyM: Float,
        val timeMs: Long,
        val provider: String
    )

    /**
     * The single verdict function. Everything the UI shows about GPS flows
     * through here, so tests pin every combination once.
     *
     * @param permissionGranted ACCESS_FINE_LOCATION granted?
     * @param gpsEnabled / networkEnabled provider switches (Settings)
     * @param lastFixAgeMs age of the best fix in hand, null = none yet
     */
    fun computeStatus(
        permissionGranted: Boolean,
        gpsEnabled: Boolean,
        networkEnabled: Boolean,
        lastFixAgeMs: Long?
    ): Status {
        if (!permissionGranted) return Status.NO_PERMISSION
        if (!gpsEnabled && !networkEnabled) return Status.PROVIDERS_OFF
        val age = lastFixAgeMs ?: return Status.SEARCHING
        return if (age in 0..FIX_STALE_DROP_MS) Status.FIXED else Status.SEARCHING
    }

    /**
     * Pick the best fix among providers' lastKnownLocation snapshots.
     * Score = freshness wins first (a 30s-old network fix beats a 5-min-old
     * GPS lock for a moving user), accuracy breaks near-ties. Deterministic
     * so the map/SOS/radar all display the SAME chosen fix.
     */
    fun chooseBest(fixes: List<FixSnapshot>, nowMs: Long): FixSnapshot? {
        val usable = fixes.filter {
            it.lat.isFinite() && it.lng.isFinite() &&
                it.timeMs > 0 && (nowMs - it.timeMs) <= FIX_STALE_DROP_MS
        }
        if (usable.isEmpty()) return null
        return usable.minByOrNull { fix ->
            val ageScore = (nowMs - fix.timeMs).toDouble()          // fresher first
            val accScore = fix.accuracyM.coerceAtLeast(0f).toDouble() * 1_000.0
            // Accuracy acts only as a tie-breaker below 15s of freshness gap.
            ageScore + accScore.coerceAtMost(15_000.0)
        }
    }

    /** True when a fix is presentable as "live" on screen. */
    fun isFreshFix(fix: FixSnapshot?, nowMs: Long): Boolean =
        fix != null && (nowMs - fix.timeMs) <= FIX_FRESH_MS
}
