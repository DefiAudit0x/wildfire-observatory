package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RadarModelTest {

    private val cx = 100f
    private val cy = 100f
    private val radius = 80f

    @Test
    fun `north is up east is right`() {
        val n = RadarModel.project(0.0, 15.0, cx, cy, radius)
        assertEquals(cx, n.x, 0.01f)
        assertTrue("north must paint UP", n.y < cy)

        val e = RadarModel.project(90.0, 15.0, cx, cy, radius)
        assertTrue("east must paint RIGHT", e.x > cx)
        assertEquals(cy, e.y, 0.01f)
    }

    @Test
    fun `distance maps linearly and clamps at range`() {
        val half = RadarModel.project(0.0, 15.0, cx, cy, radius)
        assertEquals(radius / 2, cy - half.y, 0.5f)

        val atRange = RadarModel.project(0.0, RadarModel.RANGE_KM, cx, cy, radius)
        assertEquals(radius, cy - atRange.y, 0.01f)
        assertTrue(atRange.insideRange)

        val beyond = RadarModel.project(0.0, RadarModel.RANGE_KM + 40.0, cx, cy, radius)
        assertFalse(beyond.insideRange)
        assertEquals(radius, cy - beyond.y, 0.01f) // clamped to the rim
    }

    @Test
    fun `blip factory derives bearing and distance from coordinates`() {
        // 10 km due north of Algiers.
        val (lat, lng) = GeoMath.destinationPoint(36.7538, 3.0588, 0.0, 10_000.0)
        val blip = RadarModel.blipFrom(36.7538, 3.0588, lat, lng, RadarModel.Kind.HOTSPOT)
        assertEquals(0.0, blip.angleDeg, 0.5)
        assertEquals(10.0, blip.distKm, 0.2)
    }

    @Test
    fun `rings are outermost first with px within radius`() {
        val rings = RadarModel.rings(radius)
        assertEquals(RadarModel.RING_KM.size, rings.size)
        assertTrue(rings.zipWithNext().all { (a, b) -> a.first >= b.first })
        assertTrue(rings.all { it.first <= radius + 0.01f })
        assertEquals(radius, rings.first().first, 0.01f) // outermost = full range
    }
}
