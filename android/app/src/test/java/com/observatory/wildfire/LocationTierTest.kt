package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * v2.16.0 (audit wave 3) — permission-tier contract: a coarse-only grant is
 * a WORKING engine tier (approximate fixes, honestly flagged), not a fake
 * NO_PERMISSION dead-end. Pins the pure verdicts; the device-side provider
 * wiring (GPS vs NETWORK per tier) is exercised by the instrumented tests.
 */
class LocationTierTest {

    private val freshFix = LocationLogic.FixSnapshot(
        lat = 36.75, lng = 3.06, accuracyM = 35f, timeMs = 1_000L, provider = "network"
    )

    @Test
    fun `none tier is still NO_PERMISSION`() {
        assertEquals(
            LocationLogic.Status.NO_PERMISSION,
            LocationLogic.computeStatus(LocationLogic.Tier.NONE, gpsEnabled = true, networkEnabled = true, lastFixAgeMs = 0L)
        )
    }

    @Test
    fun `coarse-only tier behaves like a granted engine`() {
        assertEquals(
            LocationLogic.Status.FIXED,
            LocationLogic.computeStatus(LocationLogic.Tier.COARSE, gpsEnabled = false, networkEnabled = true, lastFixAgeMs = 10_000L)
        )
        assertEquals(
            LocationLogic.Status.SEARCHING,
            LocationLogic.computeStatus(LocationLogic.Tier.COARSE, gpsEnabled = false, networkEnabled = true, lastFixAgeMs = null)
        )
        assertEquals(
            LocationLogic.Status.PROVIDERS_OFF,
            LocationLogic.computeStatus(LocationLogic.Tier.COARSE, gpsEnabled = false, networkEnabled = false, lastFixAgeMs = null)
        )
    }

    @Test
    fun `coarse tier cannot hide a stale fix behind precision`() {
        // Same stale-drop rule as FINE — a coarse fix past 10 min is SEARCHING.
        assertEquals(
            LocationLogic.Status.SEARCHING,
            LocationLogic.computeStatus(LocationLogic.Tier.COARSE, gpsEnabled = true, networkEnabled = true, lastFixAgeMs = 11 * 60_000L)
        )
    }

    @Test
    fun `legacy boolean form maps to FINE or NONE`() {
        assertEquals(
            LocationLogic.computeStatus(true, gpsEnabled = true, networkEnabled = true, lastFixAgeMs = 0L),
            LocationLogic.computeStatus(LocationLogic.Tier.FINE, gpsEnabled = true, networkEnabled = true, lastFixAgeMs = 0L)
        )
        assertEquals(
            LocationLogic.computeStatus(false, gpsEnabled = true, networkEnabled = true, lastFixAgeMs = 0L),
            LocationLogic.computeStatus(LocationLogic.Tier.NONE, gpsEnabled = true, networkEnabled = true, lastFixAgeMs = 0L)
        )
    }

    @Test
    fun `approximate flag defaults false and marks coarse snapshots`() {
        assertFalse(freshFix.approximate)
        assertTrue(freshFix.copy(approximate = true).approximate)
    }

    @Test
    fun `approximate fixes pass chooseBest unchanged (metadata, not quality)`() {
        val coarse = freshFix.copy(approximate = true, timeMs = 5_000L)
        val fine = freshFix.copy(approximate = false, timeMs = 4_000L)
        val best = LocationLogic.chooseBest(listOf(coarse, fine), nowMs = 6_000L)
        // Fresher wins regardless of tier — the flag never distorts selection.
        assertEquals(coarse, best)
    }
}
