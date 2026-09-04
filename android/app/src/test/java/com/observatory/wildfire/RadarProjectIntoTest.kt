package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * v2.16.0 (audit wave 3) — projectInto must be EXACTLY project() with a
 * reusable target: the radar's zero-allocation hot path is the same math
 * the immutable API pins. Any divergence would put the tested convention
 * and the painted reality out of sync (life-threatening if mirrored —
 * same doctrine as RadarModel's own header).
 */
class RadarProjectIntoTest {

    @Test
    fun `projectInto matches project exactly`() {
        val scratch = RadarModel.MutableScreenPoint()
        for (deg in listOf(0.0, 45.0, 90.0, 180.0, 270.0, 359.9)) {
            for (km in listOf(0.0, 5.0, 15.0, 29.999, 30.0, 42.0)) {
                val immutable = RadarModel.project(deg, km, 300f, 300f, 250f)
                val mutable = RadarModel.projectInto(deg, km, 300f, 300f, 250f, scratch)
                assertEquals(immutable.x, mutable.x, 1e-6f)
                assertEquals(immutable.y, mutable.y, 1e-6f)
                assertEquals(immutable.insideRange, mutable.insideRange)
            }
        }
    }

    @Test
    fun `scratch holder is fully overwritten each call (no stale state)`() {
        val scratch = RadarModel.MutableScreenPoint()
        RadarModel.projectInto(0.0, 30.0, 300f, 300f, 250f, scratch) // north, at rim
        val atRim = Pair(scratch.x, scratch.y)
        RadarModel.projectInto(180.0, 0.0, 300f, 300f, 250f, scratch) // south, at center
        assertEquals(300f, scratch.x, 1e-4f)
        assertEquals(300f, scratch.y, 1e-4f)
        assertFalse(atRim.first == scratch.x && atRim.second == scratch.y)
    }

    @Test
    fun `beyond-range blips clamp to the rim and report insideRange false`() {
        val scratch = RadarModel.projectInto(90.0, 100.0, 0f, 0f, 100f, RadarModel.MutableScreenPoint())
        assertEquals(100f, scratch.x, 1e-4f)
        assertFalse(scratch.insideRange)
        assertTrue(RadarModel.projectInto(0.0, 10.0, 0f, 0f, 100f, scratch).insideRange)
    }
}
