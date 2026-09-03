package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S3 (v2.9.0) — the telemetry-camera decision layer, web-ReportForm parity.
 * Every rule mirrored from src/components/ReportForm.tsx is pinned here:
 * freshness window (threats.ts twin), ARC-M20 compass throttle, the
 * 15 km/45° cross-check scoring (40..95 confidence), the fire/smoke color
 * heuristic, and the factual-only stamp line composition ("N/A" honesty —
 * the platform never fabricates a heading/pitch).
 */
class TelemetryCameraTest {

    private fun report(
        id: String = "rep-1",
        lat: Double,
        lng: Double,
        status: String = "pending",
        timestampMs: Long,
        locationName: String = "غابة المزيقة"
    ) = ThreatReport(
        id = id, lat = lat, lng = lng, locationName = locationName,
        wilaya = "تizi", description = "دخان كثيف", severity = "high",
        status = status, timestampMs = timestampMs, consensusCount = 2
    )

    // --- freshness (threats.ts twin: 30-min window, 2-min future skew) ---

    @Test fun `fresh timestamp inside the 30 minute window`() {
        val now = 1_760_000_000_000L
        assertTrue(TelemetryCamera.isFreshThreatTimestamp(now - 29 * 60_000L, now))
    }

    @Test fun `stale timestamp beyond 30 minutes is rejected`() {
        val now = 1_760_000_000_000L
        assertFalse(TelemetryCamera.isFreshThreatTimestamp(now - 31 * 60_000L, now))
    }

    @Test fun `future timestamp within the 2 minute skew is accepted`() {
        val now = 1_760_000_000_000L
        assertTrue(TelemetryCamera.isFreshThreatTimestamp(now + 60_000L, now))
    }

    @Test fun `future timestamp beyond the skew is rejected`() {
        val now = 1_760_000_000_000L
        assertFalse(TelemetryCamera.isFreshThreatTimestamp(now + 3 * 60_000L, now))
    }

    @Test fun `unparsed timestamp (0) is never fresh`() {
        assertFalse(TelemetryCamera.isFreshThreatTimestamp(0L, 1_000_000L))
    }

    // --- ARC-M20 compass throttle (4 Hz + rounded-change skip) ---

    @Test fun `first sample is always accepted`() {
        assertTrue(
            TelemetryCamera.shouldAcceptCompassSample(1000L, 0L, 45, 10, null, null)
        )
    }

    @Test fun `sample inside the 250ms throttle is rejected`() {
        assertFalse(
            TelemetryCamera.shouldAcceptCompassSample(1000L, 900L, 45, 10, null, null)
        )
    }

    @Test fun `unchanged rounded pair does not reset the throttle`() {
        // Steady sensor: even past the window, an identical pair is skipped —
        // and a later real change must still be accepted (no throttle reset).
        assertFalse(
            TelemetryCamera.shouldAcceptCompassSample(2000L, 1000L, 45, 10, 45, 10)
        )
        assertTrue(
            TelemetryCamera.shouldAcceptCompassSample(2100L, 1000L, 46, 10, 45, 10)
        )
    }

    @Test fun `null-null sample equals the null baseline and is skipped`() {
        assertFalse(
            TelemetryCamera.shouldAcceptCompassSample(2000L, 1000L, null, null, null, null)
        )
    }

    // --- cardinal directions (8-wind, Arabic) ---

    @Test fun `cardinals pin the compass convention`() {
        assertEquals("شمال", TelemetryCamera.bearingDirectionAr(0.0))
        assertEquals("شمال شرقي", TelemetryCamera.bearingDirectionAr(45.0))
        assertEquals("شرق", TelemetryCamera.bearingDirectionAr(90.0))
        assertEquals("جنوب شرقي", TelemetryCamera.bearingDirectionAr(135.0))
        assertEquals("جنوب", TelemetryCamera.bearingDirectionAr(180.0))
        assertEquals("جنوب غربي", TelemetryCamera.bearingDirectionAr(225.0))
        assertEquals("غرب", TelemetryCamera.bearingDirectionAr(270.0))
        assertEquals("شمال غربي", TelemetryCamera.bearingDirectionAr(315.0))
    }

    // --- cross-check (15 km radius, 45° FOV, score 60/40, confidence 40..95) ---

    private val userLat = 36.7100
    private val userLng = 3.1800
    private val now = 1_000_000_000L

    @Test fun `report on the heading bearing matches with estimate confidence`() {
        // ~1.1 km due north of the user (0.01° lat ≈ 1.11 km).
        val reports = listOf(report(lat = userLat + 0.01, lng = userLng, timestampMs = now - 60_000L))
        val match = TelemetryCamera.crossCheck(reports, userLat, userLng, headingDeg = 0.0, nowMs = now)
        assertNotNull(match)
        match!!
        assertEquals(0, match.angleDiffDeg.toInt())
        assertTrue(match.distanceKm in 1.0..1.2)
        // Perfect angle (60) + near-perfect distance (~40) → top of the band.
        assertTrue(match.confidencePct in 90..95)
    }

    @Test fun `report outside the 45 degree FOV cone never matches`() {
        val reports = listOf(report(lat = userLat + 0.01, lng = userLng, timestampMs = now - 60_000L))
        assertNull(TelemetryCamera.crossCheck(reports, userLat, userLng, headingDeg = 180.0, nowMs = now))
    }

    @Test fun `report beyond 15 km never matches`() {
        // 0.2° lat ≈ 22 km.
        val reports = listOf(report(lat = userLat + 0.2, lng = userLng, timestampMs = now - 60_000L))
        assertNull(TelemetryCamera.crossCheck(reports, userLat, userLng, headingDeg = 0.0, nowMs = now))
    }

    @Test fun `stale reports are invisible to the cross-check`() {
        val reports = listOf(report(lat = userLat + 0.01, lng = userLng, timestampMs = now - 45 * 60_000L))
        assertNull(TelemetryCamera.crossCheck(reports, userLat, userLng, headingDeg = 0.0, nowMs = now))
    }

    @Test fun `resolved and rejected reports never match`() {
        for (status in listOf("resolved", "rejected", "verified", "pending")) {
            val reports = listOf(report(lat = userLat + 0.01, lng = userLng, status = status, timestampMs = now - 60_000L))
            val match = TelemetryCamera.crossCheck(reports, userLat, userLng, headingDeg = 0.0, nowMs = now)
            if (status == "resolved" || status == "rejected") assertNull(match) else assertNotNull(match)
        }
    }

    @Test fun `best score wins and confidence stays inside 40-95`() {
        val near = report(id = "near", lat = userLat + 0.01, lng = userLng, timestampMs = now - 60_000L)
        // 14.9 km away, roughly on bearing but far — lower distance score.
        val far = report(id = "far", lat = userLat + 0.13, lng = userLng, timestampMs = now - 60_000L)
        val match = TelemetryCamera.crossCheck(listOf(far, near), userLat, userLng, 0.0, now)!!
        assertEquals("near", match.reportId)
        assertTrue(match.confidencePct in 40..95)
    }

    @Test fun `null heading is the caller gate - crossCheck itself still runs on a given heading`() {
        // Web contract: heading === null → no match. Enforced at the call
        // sites (freeze-time gate); here we pin that a fresh on-cone report
        // with a real heading DOES match, so the gate cannot silently rot.
        val reports = listOf(report(lat = userLat + 0.01, lng = userLng, timestampMs = now - 60_000L))
        assertNotNull(TelemetryCamera.crossCheck(reports, userLat, userLng, 2.0, now))
    }

    // --- edge AI pre-scan (fire/smoke color heuristic) ---

    private fun argb(r: Int, g: Int, b: Int) = (0xFF shl 24) or (r shl 16) or (g shl 8) or b

    @Test fun `pure flame pixels read as fire present`() {
        val pixels = IntArray(2500) { argb(200, 80, 40) } // r>130, g>55, r>g*1.3, b<100
        val scan = TelemetryCamera.preScan(pixels)
        assertTrue(scan.present)
        assertTrue(scan.fireRatio > 0.99)
        assertEquals(99, scan.confidence)
    }

    @Test fun `pure gray pixels read as smoke present`() {
        val pixels = IntArray(2500) { argb(150, 150, 150) } // near-equal channels, 90<r<210
        val scan = TelemetryCamera.preScan(pixels)
        assertTrue(scan.present)
        assertTrue(scan.smokeRatio > 0.99)
    }

    @Test fun `black night pixels read as nothing present`() {
        val pixels = IntArray(2500) { argb(10, 10, 10) }
        val scan = TelemetryCamera.preScan(pixels)
        assertFalse(scan.present)
        assertEquals(10, scan.confidence)
    }

    @Test fun `green vegetation is neither fire nor smoke`() {
        val pixels = IntArray(2500) { argb(40, 120, 40) }
        val scan = TelemetryCamera.preScan(pixels)
        assertFalse(scan.present)
    }

    @Test fun `confidence clamps to the 10-99 band`() {
        // One flame pixel in 2500 → ratio 0.0004 → base 0.24 → floor 10.
        val pixels = IntArray(2500) { argb(10, 10, 10) }.also { it[0] = argb(200, 80, 40) }
        assertEquals(10, TelemetryCamera.preScan(pixels).confidence)
    }

    @Test fun `empty pixel array is honestly empty`() {
        val scan = TelemetryCamera.preScan(IntArray(0))
        assertFalse(scan.present)
        assertEquals(10, scan.confidence)
    }

    // --- stamp lines (factual-only evidentiary artifact) ---

    @Test fun `stamp with sensors reads GPS bearing pitch and utc`() {
        val stamp = TelemetryCamera.buildStamp(
            lat = 36.71, lng = 3.18, heading = 45, headingSource = TelemetryCamera.SOURCE_SENSOR,
            pitch = 30, pitchSource = TelemetryCamera.SOURCE_SENSOR, includeTelemetry = true, nowMs = 0L
        )
        assertEquals("36.710000", stamp.latText)
        assertEquals("BEARING: 45° شمال شرقي (SENSOR)", stamp.bearingLine)
        assertEquals("PITCH: 30° (SENSOR)", stamp.pitchLine)
        assertEquals("UTC CAPTURE: 1970-01-01T00:00:00Z", stamp.utcText)
    }

    @Test fun `missing sensors stamp NA and never invent values`() {
        val stamp = TelemetryCamera.buildStamp(
            lat = null, lng = null, heading = null, headingSource = "NONE",
            pitch = null, pitchSource = "NONE", includeTelemetry = true, nowMs = 0L
        )
        assertEquals("N/A", stamp.latText)
        assertEquals("N/A", stamp.lngText)
        // Web parity: the BEARING line keeps the source tag even on N/A,
        // the PITCH line drops it.
        assertEquals("BEARING: N/A (NONE)", stamp.bearingLine)
        assertEquals("PITCH: N/A", stamp.pitchLine)
    }

    @Test fun `telemetry off replaces the sensor lines with the OFF marker`() {
        val stamp = TelemetryCamera.buildStamp(
            lat = 36.71, lng = 3.18, heading = 45, headingSource = TelemetryCamera.SOURCE_SENSOR,
            pitch = 30, pitchSource = TelemetryCamera.SOURCE_SENSOR, includeTelemetry = false, nowMs = 0L
        )
        assertNull(stamp.bearingLine)
        assertNull(stamp.pitchLine)
        assertEquals("36.710000", stamp.latText)
        // GPS + UTC are ALWAYS stamped, telemetry toggle only gates sensors.
        assertEquals("UTC CAPTURE: 1970-01-01T00:00:00Z", stamp.utcText)
    }

    @Test fun `manual source is stamped MANUAL exactly like the web`() {
        val stamp = TelemetryCamera.buildStamp(
            lat = 36.71, lng = 3.18, heading = 123, headingSource = TelemetryCamera.SOURCE_MANUAL,
            pitch = -15, pitchSource = TelemetryCamera.SOURCE_MANUAL, includeTelemetry = true, nowMs = 0L
        )
        assertEquals("BEARING: 123° جنوب شرقي (MANUAL)", stamp.bearingLine)
        assertEquals("PITCH: -15° (MANUAL)", stamp.pitchLine)
    }

    @Test fun `alignment lines distinguish matched from no-match`() {
        val alignment = TelemetryCamera.Alignment(
            reportId = "rep-1", locationName = "غابة تيزي وزو الشرقية",
            distanceKm = 2.0, bearingDeg = 41.0, angleDiffDeg = 4.0,
            score = 88.0, confidencePct = 88
        )
        val matched = TelemetryCamera.alignmentStampLines(alignment)
        assertEquals(2, matched.size)
        assertEquals("ALIGNMENT WITH EXISTING REPORT: 88% (ESTIMATE)", matched[0])
        assertEquals("LOCATION: غابة تيزي وزو الشرقية", matched[1])

        val none = TelemetryCamera.alignmentStampLines(null)
        assertEquals(listOf("NO EXISTING REPORT WITHIN BEARING/RANGE"), none)
    }

    @Test fun `long location names clip to 35 chars on the stamp`() {
        val alignment = TelemetryCamera.Alignment(
            reportId = "rep-1", locationName = "أ ب ت ث ج ح خ د ذ ر ز س ش ص ض ط ظ ع غ ف ق ك ل م ن ه و ي أ ب ت ث ج ح خ",
            distanceKm = 1.0, bearingDeg = 10.0, angleDiffDeg = 2.0, score = 90.0, confidencePct = 90
        )
        val lines = TelemetryCamera.alignmentStampLines(alignment)
        assertEquals(35, lines[1].removePrefix("LOCATION: ").length)
    }
}
