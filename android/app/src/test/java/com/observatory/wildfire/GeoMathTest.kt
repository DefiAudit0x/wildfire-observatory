package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/**
 * JVM tests for the native field geometry. The bearing conventions are
 * life-critical (a mirrored radar sends people TOWARD the fire), so every
 * cardinal direction is pinned explicitly.
 */
class GeoMathTest {

    @Test
    fun `driving along returned road stays usable while off road fix does not`() {
        val route = listOf(36.0 to 3.0, 36.01 to 3.0)
        val latestLat = 36.000405 // about 45 m driven since request, >30 m refresh gate
        assertTrue(TeamLocationLogic.haversineMeters(36.0, 3.0, latestLat, 3.0) >= 30.0)
        assertTrue(GeoMath.minDistanceToPolylineM(latestLat, 3.0, route) <= 60.0)
        assertTrue(GeoMath.minDistanceToPolylineM(latestLat, 3.002, route) > 60.0)
        assertTrue(GeoMath.minDistanceToPolylineM(latestLat, 3.0, emptyList()) > 60.0)
    }


    @Test
    fun `bearing north east south west`() {
        // Algiers as the anchor point.
        val lat = 36.7538; val lng = 3.0588
        val dLat = 0.05 // ≈ 5.5 km north
        assertEquals(0.0, GeoMath.bearingDeg(lat, lng, lat + dLat, lng), 0.5)
        assertEquals(90.0, GeoMath.bearingDeg(lat, lng, lat, lng + dLat), 0.5)
        assertEquals(180.0, GeoMath.bearingDeg(lat, lng, lat - dLat, lng), 0.5)
        assertEquals(270.0, GeoMath.bearingDeg(lat, lng, lat, lng - dLat), 0.5)
    }

    @Test
    fun `haversine known pair matches TeamLocationLogic twin`() {
        // Algiers → Blida ≈ 41 km (sanity order of magnitude, server twin same R).
        val d = TeamLocationLogic.haversineMeters(36.7538, 3.0588, 36.4703, 2.8277)
        assertTrue("expected ~41km, got ${d / 1000}", d in 35_000.0..47_000.0)
    }

    @Test
    fun `destination round-trips bearing and distance`() {
        val lat = 36.7538; val lng = 3.0588
        val (destLat, destLng) = GeoMath.destinationPoint(lat, lng, 90.0, 10_000.0)
        assertEquals(lat, destLat, 0.01) // due east keeps latitude
        val back = TeamLocationLogic.haversineMeters(lat, lng, destLat, destLng)
        assertEquals(10_000.0, back, 50.0)
    }

    @Test
    fun `point segment distance zero on the segment`() {
        val a = 36.70 to 3.00
        val b = 36.80 to 3.10
        val mid = ((a.first + b.first) / 2) to ((a.second + b.second) / 2)
        val d = GeoMath.pointSegmentDistanceM(mid.first, mid.second, a.first, a.second, b.first, b.second)
        assertTrue("on-segment should be ~0, got $d", d < 50.0)
    }

    @Test
    fun `point segment distance beyond ends clamps to endpoint`() {
        val a = 36.70 to 3.00
        val b = 36.70 to 3.10
        val p = 36.70 to 3.20 // straight past b
        val d = GeoMath.pointSegmentDistanceM(p.first, p.second, a.first, a.second, b.first, b.second)
        val direct = TeamLocationLogic.haversineMeters(p.first, p.second, b.first, b.second)
        assertEquals(direct, d, 200.0)
    }

    @Test
    fun `min distance to polyline ignores empty route`() {
        assertEquals(Double.MAX_VALUE, GeoMath.minDistanceToPolylineM(36.0, 3.0, emptyList()), 0.0)
    }

    @Test
    fun `min distance to polyline finds nearest leg`() {
        val route = listOf(36.70 to 3.00, 36.70 to 3.10, 36.72 to 3.20)
        val nearMiddleLeg = 36.71 to 3.05
        val d = GeoMath.minDistanceToPolylineM(nearMiddleLeg.first, nearMiddleLeg.second, route)
        assertEquals(
            GeoMath.pointSegmentDistanceM(36.71, 3.05, 36.70, 3.00, 36.70, 3.10),
            d, 50.0
        ) // ~1105 m to the near leg; the far leg is ~4597 m, so a wrong-leg pick fails
    }

    @Test
    fun `min distance to polyline finds nearest leg when it is last`() {
        val route = listOf(36.70 to 3.00, 36.70 to 3.10, 36.72 to 3.20)
        val nearLastLeg = 36.715 to 3.15 // ~537 m from leg 2, ~4761 m from leg 1
        val d = GeoMath.minDistanceToPolylineM(nearLastLeg.first, nearLastLeg.second, route)
        assertEquals(
            GeoMath.pointSegmentDistanceM(36.715, 3.15, 36.70, 3.10, 36.72, 3.20),
            d, 50.0
        )
    }

    // Fix 22 (NMAP-1): the clearance is the min distance between the ROAD
    // polyline and the FIRE points. Fail-without-fix: the old call shape
    // (each road vertex measured against the fires-as-polyline) returns
    // ~8,926 m for the missed-fire case ("safe") and 0.0 for the
    // straddling-fires case (false "crosses") — both assertions fail
    // against it.
    @Test
    fun `route clearance finds fire on the road between vertices`() {
        val road = listOf(36.70 to 3.00, 36.70 to 3.20)
        val fireOnRoad = listOf(36.70 to 3.10)
        val d = GeoMath.minDistanceBetweenPolylineAndPointsM(road, fireOnRoad)
        assertTrue("expected < 1m, got $d", d < 1.0)
    }

    @Test
    fun `route clearance does not invent fire to fire segments`() {
        val road = listOf(36.70 to 3.00, 36.70 to 3.10, 36.70 to 3.20)
        val fires = listOf(36.80 to 3.05, 36.60 to 3.15)
        val d = GeoMath.minDistanceBetweenPolylineAndPointsM(road, fires)
        assertTrue("expected > 10km, got $d", d > 10_000.0)
    }

    @Test
    fun `route clearance edge cases`() {
        assertTrue(GeoMath.minDistanceBetweenPolylineAndPointsM(emptyList(), listOf(36.70 to 3.10)).isNaN())
        assertEquals(
            Double.MAX_VALUE,
            GeoMath.minDistanceBetweenPolylineAndPointsM(listOf(36.70 to 3.00, 36.70 to 3.20), emptyList()),
            0.0
        )
        // Single-point road → haversine to that point; single fire → its distance to the road.
        val singlePoint = GeoMath.minDistanceBetweenPolylineAndPointsM(listOf(36.70 to 3.00), listOf(36.70 to 3.10))
        assertEquals(TeamLocationLogic.haversineMeters(36.70, 3.00, 36.70, 3.10), singlePoint, 1.0)
        val singleFire = GeoMath.minDistanceBetweenPolylineAndPointsM(listOf(36.70 to 3.00, 36.70 to 3.20), listOf(36.71 to 3.10))
        assertTrue("expected < 10km, got $singleFire", singleFire < 10_000.0)
    }
}
