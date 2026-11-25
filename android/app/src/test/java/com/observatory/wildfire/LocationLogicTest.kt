package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LocationLogicTest {

    private val now = 5_000_000_000L

    // Fix 52: fixtures carry a REAL reported accuracy (hasAccuracy = true) —
    // the accuracy values below are measurements, and the chooseBest
    // tie-break tests depend on them scoring as measured, not as unknown.
    private fun fix(ageMs: Long, accuracyM: Float = 10f) = LocationLogic.FixSnapshot(
        36.75, 3.05, accuracyM, now - ageMs, "gps", hasAccuracy = true
    )

    @Test
    fun `no permission dominates everything`() {
        assertEquals(
            LocationLogic.Status.NO_PERMISSION,
            LocationLogic.computeStatus(false, gpsEnabled = true, networkEnabled = true, lastFixAgeMs = 0L)
        )
    }

    @Test
    fun `permission with both providers off`() {
        assertEquals(
            LocationLogic.Status.PROVIDERS_OFF,
            LocationLogic.computeStatus(true, gpsEnabled = false, networkEnabled = false, lastFixAgeMs = null)
        )
    }

    @Test
    fun `providers on without fix is searching`() {
        assertEquals(
            LocationLogic.Status.SEARCHING,
            LocationLogic.computeStatus(true, gpsEnabled = true, networkEnabled = false, lastFixAgeMs = null)
        )
    }

    @Test
    fun `fresh fix is fixed stale beyond drop window is searching`() {
        assertEquals(
            LocationLogic.Status.FIXED,
            LocationLogic.computeStatus(true, true, true, lastFixAgeMs = 30_000L)
        )
        assertEquals(
            LocationLogic.Status.FIXED,
            LocationLogic.computeStatus(true, true, true, lastFixAgeMs = LocationLogic.FIX_STALE_DROP_MS)
        )
        assertEquals(
            LocationLogic.Status.SEARCHING,
            LocationLogic.computeStatus(true, true, true, lastFixAgeMs = LocationLogic.FIX_STALE_DROP_MS + 1)
        )
        // Fix 52 (NLOGL-2): a small negative age is inside the shared 60 s
        // skew window chooseBest and isFreshFix already allow — FIXED.
        assertEquals(
            LocationLogic.Status.FIXED,
            LocationLogic.computeStatus(true, true, true, lastFixAgeMs = -5_000L)
        )
    }

    // Fix 52 (NLOGL-2): the status machine accepts the shared skew window.
    @Test
    fun `status accepts negative age inside skew window`() {
        assertEquals(
            LocationLogic.Status.FIXED,
            LocationLogic.computeStatus(true, true, true, lastFixAgeMs = -30_000L)
        )
    }

    // Fix 52 (NLOGL-2): beyond the 60 s skew allowance the fix is rejected.
    @Test
    fun `status rejects negative age beyond skew window`() {
        assertEquals(
            LocationLogic.Status.SEARCHING,
            LocationLogic.computeStatus(true, true, true, lastFixAgeMs = -61_000L)
        )
    }

    // Fix 52 (NLOC-1): an unknown-accuracy snapshot scores the maximum
    // tie-break penalty, so a measured fix wins an equal-freshness tie.
    @Test
    fun `unknown accuracy loses freshness tie to measured fix`() {
        val unknown = fix(ageMs = 5_000, accuracyM = 0f).copy(hasAccuracy = false)
        val measured = fix(ageMs = 5_000, accuracyM = 5f)
        assertEquals(5f, LocationLogic.chooseBest(listOf(unknown, measured), now)?.accuracyM)
    }

    // Fix 52 (NLOC-1): unknown accuracy is a penalty, not a disqualifier —
    // alone, or strictly fresher by more than the 15 s tie-break cap, it
    // is still the best fix in hand.
    @Test
    fun `unknown accuracy still selectable alone or when strictly fresher`() {
        val unknown = fix(ageMs = 5_000, accuracyM = 0f).copy(hasAccuracy = false)
        assertEquals(unknown, LocationLogic.chooseBest(listOf(unknown), now))
        val fresherUnknown = fix(ageMs = 1_000, accuracyM = 0f).copy(hasAccuracy = false)
        val olderMeasured = fix(ageMs = 20_000, accuracyM = 5f)
        assertEquals(fresherUnknown, LocationLogic.chooseBest(listOf(olderMeasured, fresherUnknown), now))
    }

    // Fix 52 (NLOC-1): the flag defaults to false and copy preserves it.
    @Test
    fun `hasAccuracy defaults false`() {
        val snapshot = LocationLogic.FixSnapshot(36.75, 3.05, 0f, now - 1_000, "gps")
        assertFalse(snapshot.hasAccuracy)
        assertTrue(snapshot.copy(hasAccuracy = true).hasAccuracy)
    }

    @Test
    fun `choose best prefers fresher fix even with worse accuracy`() {
        val network = fix(ageMs = 5_000, accuracyM = 80f)   // fresh + coarse
        val gps = fix(ageMs = 200_000, accuracyM = 5f)      // stale + fine
        val best = LocationLogic.chooseBest(listOf(gps, network), now)
        // The helper names every snapshot "gps" — assert on the CHOSEN
        // accuracy (80 = the fresh coarse one), not the provider string.
        assertEquals(80f, best?.accuracyM)
    }

    @Test
    fun `choose best uses accuracy only as near tie-break`() {
        val a = fix(ageMs = 5_000, accuracyM = 20f)
        val b = fix(ageMs = 5_000, accuracyM = 5f)
        assertEquals(5f, LocationLogic.chooseBest(listOf(a, b), now)?.accuracyM)
    }

    @Test
    fun `choose best drops nonfinite and ancient`() {
        val nan = LocationLogic.FixSnapshot(Double.NaN, 3.0, 10f, now - 1_000, "gps")
        val ancient = fix(ageMs = LocationLogic.FIX_STALE_DROP_MS + 60_000)
        val good = fix(ageMs = 1_000)
        assertEquals(good, LocationLogic.chooseBest(listOf(nan, ancient, good), now))
        assertNull(LocationLogic.chooseBest(listOf(nan, ancient), now))
        assertNull(LocationLogic.chooseBest(emptyList(), now))
    }

    @Test
    fun `freshness window for display`() {
        assertTrue(LocationLogic.isFreshFix(fix(30_000), now))
        assertTrue(!LocationLogic.isFreshFix(fix(120_000), now))
        assertTrue(!LocationLogic.isFreshFix(null, now))
    }

    // Fix 20: the 10-minute usable window (report submit, SOS) — a real
    // recent measurement, not live. Fail-without-fix: the helper is new
    // code; the 61 s case is usable but NOT fresh, which is the whole
    // point of the two bars.
    @Test
    fun `usable window is ten minutes`() {
        assertTrue(!LocationLogic.isUsableFix(null, now))
        assertTrue(LocationLogic.isUsableFix(fix(30_000), now))
        // 61 s: past the 60 s live bar, still usable.
        assertTrue(!LocationLogic.isFreshFix(fix(61_000), now))
        assertTrue(LocationLogic.isUsableFix(fix(61_000), now))
        // Exactly 10 min is usable; one millisecond more is not.
        assertTrue(LocationLogic.isUsableFix(fix(LocationLogic.FIX_STALE_DROP_MS), now))
        assertTrue(!LocationLogic.isUsableFix(fix(LocationLogic.FIX_STALE_DROP_MS + 1), now))
        // Future beyond the 60 s skew allowance is usable for neither bar;
        // a small drift inside the skew is tolerated by both.
        val farFuture = LocationLogic.FixSnapshot(36.8, 7.6, 10f, now + 5 * 60_000L, "gps")
        assertTrue(!LocationLogic.isUsableFix(farFuture, now))
        assertTrue(!LocationLogic.isFreshFix(farFuture, now))
        val slightlyFuture = LocationLogic.FixSnapshot(36.8, 7.6, 10f, now + 30_000L, "gps")
        assertTrue(LocationLogic.isUsableFix(slightlyFuture, now))
        assertTrue(LocationLogic.isFreshFix(slightlyFuture, now))
    }

    // v2.15.0: future fix timestamps (clock skew / hostile source) are
    // rejected instead of ranking as "fresher than fresh".
    @Test
    fun chooseBest_and_isFreshFix_rejectFutureTimestamps() {
        val now = 10_000_000L
        val past = LocationLogic.FixSnapshot(36.8, 7.6, 10f, now - 5_000, "gps")
        val future = LocationLogic.FixSnapshot(36.8, 7.7, 5f, now + 5 * 60_000L, "gps")

        org.junit.Assert.assertSame(past, LocationLogic.chooseBest(listOf(past, future), now))
        org.junit.Assert.assertNull(LocationLogic.chooseBest(listOf(future), now))
        org.junit.Assert.assertFalse(LocationLogic.isFreshFix(future, now))
        org.junit.Assert.assertTrue(LocationLogic.isFreshFix(past, now))
        // The 60s skew allowance still tolerates a tiny drift backwards.
        val slightlyFuture = LocationLogic.FixSnapshot(36.8, 7.6, 10f, now + 30_000L, "gps")
        org.junit.Assert.assertSame(slightlyFuture, LocationLogic.chooseBest(listOf(slightlyFuture), now))
    }

    // Fix 53 (NMAP-5): the map arrow shows GPS course only while moving.
    @Test
    fun `moving fresh fix shows GPS bearing over compass`() {
        val moving = fix(ageMs = 10_000L).copy(bearingDeg = 90.0, speedMps = 1.2f)
        assertEquals(90.0, LocationLogic.displayBearing(moving, 180.0, now))
        // Boundary: just above the 0.5 m/s moving threshold still counts.
        assertEquals(90.0, LocationLogic.displayBearing(moving.copy(speedMps = 0.6f), 180.0, now))
    }

    @Test
    fun `standing fresh fix falls back to compass`() {
        val standing = fix(ageMs = 10_000L).copy(bearingDeg = 90.0, speedMps = 0.4f)
        assertEquals(180.0, LocationLogic.displayBearing(standing, 180.0, now))
        // Boundary: exactly at the 0.5 m/s threshold is still standing.
        assertEquals(180.0, LocationLogic.displayBearing(standing.copy(speedMps = 0.5f), 180.0, now))
    }

    @Test
    fun `stale moving fix falls back to compass`() {
        val stale = fix(ageMs = LocationLogic.FIX_FRESH_MS + 1).copy(bearingDeg = 90.0, speedMps = 1.2f)
        assertEquals(180.0, LocationLogic.displayBearing(stale, 180.0, now))
    }

    @Test
    fun `no bearing falls back to compass`() {
        val noBearing = fix(ageMs = 10_000L).copy(speedMps = 1.2f)
        assertEquals(180.0, LocationLogic.displayBearing(noBearing, 180.0, now))
    }

    @Test
    fun `no bearing and no compass has no heading`() {
        val noBearing = fix(ageMs = 10_000L).copy(speedMps = 1.2f)
        assertNull(LocationLogic.displayBearing(noBearing, null, now))
    }
}
