package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/**
 * v2.10.0 (S4 Radar v2) — pure decision layer tests. The life-safety pins:
 * a mirrored drift cone would point people INTO the fire (driftHeading);
 * a route with unknown clearance must never masquerade as safe (crossesFire
 * fails CLOSED to "crosses"); a stale AI briefing must never present itself
 * as fresh (cache discipline).
 */
class RadarV2Test {

    // ---------- drift heading (mirror = life-threatening bug) ----------

    @Test
    fun drift_flips_north_to_south() {
        assertEquals(180, RadarV2.driftHeading(0))
        assertEquals(180, RadarV2.driftHeading(360))
    }

    @Test
    fun drift_wraps_across_north() {
        assertEquals(40, RadarV2.driftHeading(220))
        assertEquals(179, RadarV2.driftHeading(359))
        assertEquals(0, RadarV2.driftHeading(180))
        assertEquals(359, RadarV2.driftHeading(179))
    }

    @Test
    fun drift_is_exactly_opposite_of_web_formula() {
        // Web EvacuationRadar: (wind.direction + 180) % 360 — spot-check a
        // real bisection: wind FROM the west (270) drifts TOWARD the east.
        assertEquals(90, RadarV2.driftHeading(270))
    }

    // ---------- wind brief + chip numerals ----------

    @Test
    fun windBrief_calm_to_calmest() {
        assertEquals("رياح هادئة", RadarV2.windBrief(1.5))
        assertEquals("رياح خفيفة", RadarV2.windBrief(10.0))
        assertEquals("رياح معتدلة", RadarV2.windBrief(25.0))
        assertEquals("رياح قوية — خطر الانتشار مرتفع", RadarV2.windBrief(40.0))
        assertEquals("رياح عاتية — خطر انتشار حرج", RadarV2.windBrief(60.0))
    }

    @Test
    fun speedLabel_is_one_decimal_then_integer() {
        assertEquals("14.3", RadarV2.speedLabel(14.26))
        assertEquals("9.0", RadarV2.speedLabel(9.0))
        assertEquals("120", RadarV2.speedLabel(120.4))
    }

    @Test
    fun tempLabel_is_whole_celsius() {
        assertEquals("31", RadarV2.tempLabel(31.4))
        assertEquals("3", RadarV2.tempLabel(3.0))
    }

    // ---------- destination point / rings / cone geometry ----------

    @Test
    fun destination_due_north_is_one_degree_per_111km() {
        val p = RadarV2.destinationPoint(0.0, 0.0, 0.0, 111.195)
        assertTrue("lat $p", abs(p.first - 1.0) < 0.001)
        assertTrue("lng $p", abs(p.second) < 0.001)
    }

    @Test
    fun destination_due_east_keeps_latitude() {
        val p = RadarV2.destinationPoint(36.7538, 3.0588, 90.0, 10.0)
        assertTrue("lat moved $p", abs(p.first - 36.7538) < 0.01)
        assertTrue("lng must grow eastward", p.second > 3.0588)
        val back = TeamLocationLogic.haversineMeters(36.7538, 3.0588, p.first, p.second)
        assertTrue("haversine roundtrip $back", abs(back - 10_000.0) < 50.0)
    }

    @Test
    fun circle_closes_and_stays_on_radius() {
        val pts = RadarV2.circleGeoPoints(36.75, 3.06, 15.0, steps = 48)
        assertEquals(49, pts.size) // 48 arc + closing repeat of the first
        assertEquals(pts.first(), pts.last())
        for (p in pts.take(48)) {
            val d = TeamLocationLogic.haversineMeters(36.75, 3.06, p.first, p.second)
            assertTrue("radius drift ${d / 1000.0}", abs(d / 1000.0 - 15.0) < 0.1)
        }
    }

    @Test
    fun circle_rejects_degenerate_steps_or_radius() {
        assertTrue(RadarV2.circleGeoPoints(36.0, 3.0, 15.0, steps = 4).isEmpty())
        assertTrue(RadarV2.circleGeoPoints(36.0, 3.0, 0.0).isEmpty())
        assertTrue(RadarV2.circleGeoPoints(36.0, 3.0, -1.0).isEmpty())
    }

    @Test
    fun cone_without_wind_is_empty_honesty_rule() {
        assertTrue(RadarV2.coneGeoPoints(36.75, 3.06, null).isEmpty())
    }

    @Test
    fun cone_opens_toward_drift_heading() {
        val center = 36.75 to 3.06
        val pts = RadarV2.coneGeoPoints(center.first, center.second, 90, steps = 20)
        assertEquals(22, pts.size) // center vertex + 21 arc samples
        assertEquals(center, pts.first())
        // Midpoint of the arc sits ~16.5 km due east of the user.
        val mid = pts[pts.size / 2]
        val d = TeamLocationLogic.haversineMeters(center.first, center.second, mid.first, mid.second)
        assertTrue("cone reach $d", abs(d / 1000.0 - RadarV2.coneRadiusKm()) < 0.2)
        assertTrue("mid arc east", mid.second > center.second)
        // Arc endpoints are 22° off the drift axis both ways.
        val left = TeamLocationLogic.haversineMeters(
            center.first, center.second, pts[1].first, pts[1].second
        )
        val right = TeamLocationLogic.haversineMeters(
            center.first, center.second, pts.last().first, pts.last().second
        )
        assertTrue("arc radius left $left", abs(left / 1000.0 - RadarV2.coneRadiusKm()) < 0.2)
        assertTrue("arc radius right $right", abs(right / 1000.0 - RadarV2.coneRadiusKm()) < 0.2)
    }

    // ---------- route ranking (safety-first) ----------

    private val roadA = listOf(36.70 to 3.05, 36.72 to 3.07, 36.74 to 3.09)
    private val roadB = listOf(36.70 to 3.05, 36.73 to 3.06, 36.74 to 3.09)

    @Test
    fun ranking_prefers_clearance_over_speed() {
        val fastButHot = RadarV2.RouteOption(roadA, 10_000.0, 600.0, 1_800.0)
        val slowButSafe = RadarV2.RouteOption(roadB, 14_000.0, 1_200.0, 9_000.0)
        val ranked = RadarV2.rankRoutes(listOf(fastButHot, slowButSafe))
        assertEquals(slowButSafe, ranked[0])
        assertEquals(slowButSafe, RadarV2.pickSafest(listOf(fastButHot, slowButSafe)))
    }

    @Test
    fun ranking_tiebreaks_on_duration() {
        val a = RadarV2.RouteOption(roadA, 10_000.0, 600.0, 5_000.0)
        val b = RadarV2.RouteOption(roadB, 10_000.0, 900.0, 5_000.0)
        assertEquals(a, RadarV2.pickSafest(listOf(b, a)))
    }

    @Test
    fun route_without_points_never_ranks() {
        val ghost = RadarV2.RouteOption(emptyList(), 1.0, 1.0, Double.MAX_VALUE)
        val real = RadarV2.RouteOption(roadA, 10_000.0, 600.0, 100.0)
        assertEquals(listOf(real), RadarV2.rankRoutes(listOf(ghost, real)))
    }

    @Test
    fun ranking_does_not_mutate_input() {
        val hot = RadarV2.RouteOption(roadA, 10_000.0, 600.0, 1_000.0)
        val safe = RadarV2.RouteOption(roadB, 12_000.0, 900.0, 8_000.0)
        val input = listOf(hot, safe)
        RadarV2.rankRoutes(input)
        assertEquals(hot, input[0])
        assertEquals(safe, input[1])
    }

    @Test
    fun unknown_clearance_fails_closed_to_crosses() {
        assertTrue(RadarV2.RouteOption(roadA, 1.0, 1.0, Double.NaN).crossesFire)
        assertTrue(RadarV2.RouteOption(roadA, 1.0, 1.0, 2_499.0).crossesFire)
        assertFalse(RadarV2.RouteOption(roadA, 1.0, 1.0, 2_500.0).crossesFire)
        assertFalse(RadarV2.RouteOption(roadA, 1.0, 1.0, Double.MAX_VALUE).crossesFire)
    }

    @Test
    fun pickSafest_empty_is_null() {
        assertNull(RadarV2.pickSafest(emptyList()))
    }

    // ---------- AI briefing client discipline (web AICopilot parity) ----------

    @Test
    fun ai_cache_is_fresh_only_within_one_hour() {
        val t = 1_000_000L
        assertTrue(RadarV2.aiCacheFresh(t, t + 59L * 60L * 1000L))
        assertFalse(RadarV2.aiCacheFresh(t, t + RadarV2.AI_CACHE_TTL_MS))
        assertFalse(RadarV2.aiCacheFresh(0L, t))
        assertFalse(RadarV2.aiCacheFresh(t + 1, t)) // future-stamped cache is not fresh
    }

    @Test
    fun ai_requests_wait_at_least_five_seconds() {
        val t = 1_000_000L
        assertTrue(RadarV2.aiRequestAllowed(0L, t))
        assertFalse(RadarV2.aiRequestAllowed(t, t + 4_999))
        assertTrue(RadarV2.aiRequestAllowed(t, t + 5_000))
        assertFalse(RadarV2.aiRequestAllowed(t + 1_000, t)) // clock ran backwards
    }

    @Test
    fun ai_cache_key_mirrors_web_shape() {
        assertEquals(
            "ai_guidance_ar_36.75_3.06_17123",
            RadarV2.aiCacheKey(36.75, 3.06, "ar", 17123)
        )
        assertEquals(
            "ai_guidance_ar_none_none_17123",
            RadarV2.aiCacheKey(null, null, "ar", 17123)
        )
    }

    // v2.15.0: Kotlin Double ordering ranks NaN ABOVE every finite value —
    // an unknown-clearance route used to win the "Safest" slot. It must sink.
    @Test
    fun rankRoutes_unknownClearanceNeverRanksFirst() {
        val known = RadarV2.RouteOption(
            points = listOf(36.8 to 7.6, 36.81 to 7.61),
            distanceM = 1_000.0, durationS = 120.0, minFireDistanceM = 5_000.0,
        )
        val unknown = RadarV2.RouteOption(
            points = listOf(36.8 to 7.6, 36.82 to 7.62),
            distanceM = 1_100.0, durationS = 110.0, minFireDistanceM = Double.NaN,
        )
        val ranked = RadarV2.rankRoutes(listOf(unknown, known))
        org.junit.Assert.assertSame(known, ranked.first())
        org.junit.Assert.assertSame(unknown, ranked.last())
        org.junit.Assert.assertSame(known, RadarV2.pickSafest(listOf(unknown, known)))
    }
}
