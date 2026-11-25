package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ProximityLogicTest {

    private val now = 1_000_000_000_000L

    private fun pin(distKmFromUser: Double, ageMin: Long, bearing: Double = 0.0): ProximityLogic.ThreatPin {
        val (lat, lng) = GeoMath.destinationPoint(36.75, 3.05, bearing, distKmFromUser * 1000)
        return ProximityLogic.ThreatPin(lat, lng, now - ageMin * 60_000)
    }

    @Test
    fun `fresh critical under 2km`() {
        val lvl = ProximityLogic.evaluate(36.75, 3.05, listOf(pin(1.5, 5)), now)
        assertEquals(ProximityLogic.Level.CRITICAL, lvl)
    }

    @Test
    fun `ladder warning and watch bands`() {
        assertEquals(ProximityLogic.Level.WARNING, ProximityLogic.evaluate(36.75, 3.05, listOf(pin(4.0, 5)), now))
        assertEquals(ProximityLogic.Level.WATCH, ProximityLogic.evaluate(36.75, 3.05, listOf(pin(8.0, 5)), now))
        assertNull(ProximityLogic.evaluate(36.75, 3.05, listOf(pin(11.0, 5)), now))
    }

    @Test
    fun `stale threats never alert — FIRMS overpass semantics`() {
        // 40 minutes old: beyond the 30-min freshness window even at 1km.
        assertNull(ProximityLogic.evaluate(36.75, 3.05, listOf(pin(1.0, 40)), now))
    }

    @Test
    fun `future timestamps beyond skew are hostile not fresh`() {
        val pin = ProximityLogic.ThreatPin(36.75, 3.05, now + 10 * 60_000)
        val lvl = ProximityLogic.evaluate(36.75, 3.05, listOf(pin), now)
        assertNull(lvl)
    }

    @Test
    fun `highest level wins across threats`() {
        val lvl = ProximityLogic.evaluate(36.75, 3.05, listOf(pin(8.0, 5), pin(1.0, 25)), now)
        assertEquals(ProximityLogic.Level.CRITICAL, lvl)
    }

    @Test
    fun `nearest fresh ignores stale`() {
        val km = ProximityLogic.nearestFreshKm(36.75, 3.05, listOf(pin(1.0, 60), pin(9.0, 2)), now)
        assertEquals(9.0, km ?: -1.0, 0.3)
        assertNull(ProximityLogic.nearestFreshKm(36.75, 3.05, listOf(pin(1.0, 60)), now))
    }

    @Test
    fun `empty threat list is safe`() {
        assertNull(ProximityLogic.evaluate(36.75, 3.05, emptyList(), now))
    }

    // v2.15.0: a NaN-coordinate pin must not poison nearestFreshKm — the old
    // code let NaN become the best and stuck forever ("NaN" banner).
    @Test
    fun nearestFreshKm_skipsPoisonedCoordinates() {
        val now = 10_000_000L
        // freshValid sits ~7 km away (NOT on the user position — a pin at
        // the user's own coordinates is 0 km and nothing can be closer).
        val freshValid = ProximityLogic.ThreatPin(36.85, 7.65, now - 1_000)
        val poisonedNaN = ProximityLogic.ThreatPin(Double.NaN, 7.7, now - 1_000)
        val poisonedRange = ProximityLogic.ThreatPin(200.0, 7.7, now - 1_000)
        val freshCloser = ProximityLogic.ThreatPin(36.79, 7.61, now - 2_000)

        val km = ProximityLogic.nearestFreshKm(36.8, 7.6, listOf(poisonedNaN, poisonedRange, freshValid, freshCloser), now)
        org.junit.Assert.assertNotNull(km)
        assertEquals(
            TeamLocationLogic.haversineMeters(36.8, 7.6, 36.79, 7.61) / 1000.0,
            km!!, 0.05
        ) // ~1.425 km to freshCloser; 0.0 or the 7.122 km freshValid distance both fail
    }

    @Test
    fun nearestFreshKm_returnsNullWhenOnlyPoisonedPinsRemain() {
        val now = 10_000_000L
        val km = ProximityLogic.nearestFreshKm(36.8, 7.6, listOf(ProximityLogic.ThreatPin(Double.NaN, Double.NaN, now - 1_000)), now)
        org.junit.Assert.assertNull(km)
    }

    // Fix 54 (NPROX-1): out-of-range coordinates wrap through the pure-trig
    // haversine to ~0 km — a lat-360 pin must be rejected, not CRITICAL.
    // Each variant below wraps to the user's own position on old code
    // (dLat or dLng of exactly ±360°), so the test fails without the fix.
    @Test
    fun evaluate_rejectsOutOfRangeCoordinates() {
        val fresh = now - 1_000
        assertNull(ProximityLogic.evaluate(0.0, 0.0, listOf(ProximityLogic.ThreatPin(360.0, 0.0, fresh)), now))
        assertNull(ProximityLogic.evaluate(0.0, 0.0, listOf(ProximityLogic.ThreatPin(-360.0, 0.0, fresh)), now))
        assertNull(ProximityLogic.evaluate(0.0, 0.0, listOf(ProximityLogic.ThreatPin(0.0, 360.0, fresh)), now))
        assertNull(ProximityLogic.evaluate(36.8, 7.6, listOf(ProximityLogic.ThreatPin(396.8, 7.6, fresh)), now))
        assertNull(ProximityLogic.evaluate(36.8, 7.6, listOf(ProximityLogic.ThreatPin(36.8, 367.6, fresh)), now))
        // Mixed list: the wrapped pin must not mask the real 8 km WATCH pin.
        val (lat8, lng8) = GeoMath.destinationPoint(0.0, 0.0, 0.0, 8000.0)
        val mixed = ProximityLogic.evaluate(
            0.0, 0.0,
            listOf(
                ProximityLogic.ThreatPin(360.0, 0.0, fresh),
                ProximityLogic.ThreatPin(lat8, lng8, fresh)
            ),
            now
        )
        assertEquals(ProximityLogic.Level.WATCH, mixed)
    }

    @Test
    fun evaluateAndNearestFreshKm_agreeOnOutOfRangePins() {
        val pins = listOf(ProximityLogic.ThreatPin(360.0, 0.0, now - 1_000))
        assertNull(ProximityLogic.evaluate(0.0, 0.0, pins, now))
        assertNull(ProximityLogic.nearestFreshKm(0.0, 0.0, pins, now))
    }

    @Test
    fun evaluate_rejectsNonFiniteCoordinates() {
        val fresh = now - 1_000
        assertNull(ProximityLogic.evaluate(0.0, 0.0, listOf(ProximityLogic.ThreatPin(Double.NaN, 0.0, fresh)), now))
        assertNull(ProximityLogic.evaluate(0.0, 0.0, listOf(ProximityLogic.ThreatPin(Double.POSITIVE_INFINITY, 0.0, fresh)), now))
        assertNull(ProximityLogic.evaluate(0.0, 0.0, listOf(ProximityLogic.ThreatPin(0.0, Double.NaN, fresh)), now))
    }

    // Fix 54 (follow-up (6)): the future-skew allowance is 2 minutes, same
    // as the web (isFreshThreatTimestamp) and TelemetryCamera.
    @Test
    fun isFresh_allowsUpToTwoMinuteFutureSkew() {
        assertEquals(true, ProximityLogic.isFresh(now + 61_000, now))
        assertEquals(true, ProximityLogic.isFresh(now + 119_000, now))
    }

    @Test
    fun isFresh_rejectsBeyondTwoMinuteFutureSkew() {
        assertEquals(false, ProximityLogic.isFresh(now + 121_000, now))
    }
}
