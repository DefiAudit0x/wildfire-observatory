package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LocationLogicTest {

    private val now = 5_000_000_000L

    private fun fix(ageMs: Long, accuracyM: Float = 10f) = LocationLogic.FixSnapshot(
        36.75, 3.05, accuracyM, now - ageMs, "gps"
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
        // Negative age = hostile clock — not a fix.
        assertEquals(
            LocationLogic.Status.SEARCHING,
            LocationLogic.computeStatus(true, true, true, lastFixAgeMs = -5_000L)
        )
    }

    @Test
    fun `choose best prefers fresher fix even with worse accuracy`() {
        val network = fix(ageMs = 5_000, accuracyM = 80f)   // fresh + coarse
        val gps = fix(ageMs = 200_000, accuracyM = 5f)      // stale + fine
        val best = LocationLogic.chooseBest(listOf(gps, network), now)
        assertEquals("network", best?.provider)
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
}
