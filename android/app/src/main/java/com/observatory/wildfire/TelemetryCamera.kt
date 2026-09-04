package com.observatory.wildfire

import java.time.Instant
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * S3 (v2.9.0) — telemetry-camera parity with the web ReportForm.
 *
 * Pure decision layer (house rule: zero android.jar — every function here
 * runs on the JVM in TelemetryCameraTest). The device side (sensors, canvas,
 * bitmaps) lives in CameraCaptureFragment + TelemetryOverlay; both consume
 * ONLY this object's contracts.
 *
 * Mirrored from src/components/ReportForm.tsx (capture pipeline):
 *  - compass ingestion throttle (ARC-M20): 4 Hz + rounded-change skip, so a
 *    60 Hz sensor never floods either the HUD or the recompute path;
 *  - cross-check ("alignment estimate"): fresh pending/verified reports
 *    within 15 km and within the 45° camera-FOV cone, scored
 *    angle≤60 + distance≤40, confidence = 40..95 — ALWAYS an estimate,
 *    never proof (the stamp says so on every frame);
 *  - edge AI pre-scan: 50×50 color heuristic (fire/smoke pixel rules),
 *    never verifies anything — final verification is server-side Gemini;
 *  - stamp lines: factual-only English evidentiary artifact, byte-identical
 *    composition to the web watermark ("N/A" when a sensor is absent — the
 *    platform never fabricates a heading/pitch).
 *
 * Report freshness mirrors src/utils/threats.ts isFreshThreatTimestamp
 * (30-min operational window + 2-min future skew) — v2.5.0/W-M8 taught both
 * platforms to share ONE freshness contract; this is the Android twin.
 */
object TelemetryCamera {

    /** Freshness window shared with the web (threats.ts). */
    const val THREAT_MAX_AGE_MS = 30 * 60_000L
    const val THREAT_MAX_FUTURE_SKEW_MS = 2 * 60_000L

    /** ARC-M20 mirror: compass updates throttled to 4 Hz. */
    const val COMPASS_THROTTLE_MS = 250L

    /** Cross-check gates (web: 15 km radius, 45° camera-FOV cone). */
    const val CROSS_CHECK_MAX_KM = 15.0
    const val CROSS_CHECK_FOV_DEG = 45.0

    /** Stamp provenance markers (web: headingSource.toUpperCase()). */
    const val SOURCE_SENSOR = "SENSOR"
    const val SOURCE_MANUAL = "MANUAL"

    /**
     * A threat timestamp must be parseable (>0), recent, and not materially
     * from the future. ThreatReport.timestampMs is 0 when the server time
     * failed to parse — same honesty as Date.parse(NaN).
     */
    fun isFreshThreatTimestamp(timestampMs: Long, nowMs: Long): Boolean {
        if (timestampMs <= 0) return false
        val age = nowMs - timestampMs
        return age >= -THREAT_MAX_FUTURE_SKEW_MS && age <= THREAT_MAX_AGE_MS
    }

    /**
     * ARC-M20 mirror: accept a compass sample only when the 250 ms throttle
     * elapsed AND the rounded pair actually changed. Unchanged readings must
     * NOT reset the throttle (web: lastUpdateAt moves only on change), so a
     * steady sensor never blocks a later real change. A no-data sample
     * (null/null) equals the null baseline and is skipped — no fabricated
     * ticks.
     */
    fun shouldAcceptCompassSample(
        nowMs: Long,
        lastAcceptedMs: Long,
        heading: Int?,
        pitch: Int?,
        lastHeading: Int?,
        lastPitch: Int?
    ): Boolean {
        if (nowMs - lastAcceptedMs < COMPASS_THROTTLE_MS) return false
        return heading != lastHeading || pitch != lastPitch
    }

    /** 8-wind cardinal in Arabic (web getBearingDirection, isArabic branch). */
    fun bearingDirectionAr(angleDeg: Double): String {
        val dirs = arrayOf(
            "شمال", "شمال شرقي", "شرق", "جنوب شرقي",
            "جنوب", "جنوب غربي", "غرب", "شمال غربي"
        )
        // v2.15.0 audit fix (crash): Kotlin's % keeps the sign of the
        // dividend — a negative heading (-30°) produced index -1 and an
        // ArrayIndexOutOfBoundsException on the capture path. Normalize
        // into [0, 360) first; the sweep -360..360 can never throw now.
        val normalized = ((angleDeg % 360.0) + 360.0) % 360.0
        val idx = Math.round((normalized / 45.0)).toInt() % 8
        return dirs[idx]
    }

    /**
     * One correlated report (web: matchedReport + alignmentAccuracy).
     * confidencePct = round(40 + (score/100)*55) → 40..95, estimate only.
     */
    data class Alignment(
        val reportId: String,
        val locationName: String,
        val distanceKm: Double,
        val bearingDeg: Double,
        val angleDiffDeg: Double,
        val score: Double,
        val confidencePct: Int
    )

    /**
     * Cross-check GPS + compass heading against the live report list.
     * Requires a heading (web: heading === null → no match ever) and gates
     * each candidate on status pending/verified, 30-min freshness, 15 km
     * radius, 45° bearing diff. Best score wins; null = nothing in cone.
     */
    fun crossCheck(
        reports: List<ThreatReport>,
        userLat: Double,
        userLng: Double,
        headingDeg: Double,
        nowMs: Long
    ): Alignment? {
        var best: Alignment? = null
        var maxScore = -1.0
        for (rep in reports) {
            if (rep.status != "pending" && rep.status != "verified") continue
            if (!isFreshThreatTimestamp(rep.timestampMs, nowMs)) continue
            val distKm = TeamLocationLogic.haversineMeters(userLat, userLng, rep.lat, rep.lng) / 1000.0
            if (distKm > CROSS_CHECK_MAX_KM) continue
            val bearing = GeoMath.bearingDeg(userLat, userLng, rep.lat, rep.lng)
            var diff = abs(bearing - headingDeg)
            if (diff > 180.0) diff = 360.0 - diff
            if (diff > CROSS_CHECK_FOV_DEG) continue
            val angleScore = ((CROSS_CHECK_FOV_DEG - diff) / CROSS_CHECK_FOV_DEG) * 60.0
            val distScore = ((CROSS_CHECK_MAX_KM - distKm) / CROSS_CHECK_MAX_KM) * 40.0
            val score = angleScore + distScore
            if (score > maxScore) {
                maxScore = score
                best = Alignment(
                    reportId = rep.id,
                    locationName = rep.locationName,
                    distanceKm = distKm,
                    bearingDeg = bearing,
                    angleDiffDeg = diff,
                    score = score,
                    confidencePct = (40.0 + (score / 100.0) * 55.0).roundToInt()
                )
            }
        }
        return best
    }

    /** On-device heuristic result (web edgeAiStatus). */
    data class PreScan(
        val present: Boolean,
        val confidence: Int,
        val fireRatio: Double,
        val smokeRatio: Double
    )

    /**
     * Coarse color-based fire/smoke heuristic on ARGB pixels (any count —
     * ratios are size-independent; callers feed a 50×50 downsample).
     * web parity: fire = r>130 && g>55 && r>g*1.3 && b<100;
     * smoke = |r-g|<20 && |g-b|<20 && 90<r<210;
     * confidence = clamp(fire*600 + smoke*400, 10..99);
     * present = fireRatio>0.008 || smokeRatio>0.02.
     * NEVER verifies a report — final call is server-side Gemini vision.
     */
    fun preScan(argbPixels: IntArray): PreScan {
        if (argbPixels.isEmpty()) return PreScan(false, 10, 0.0, 0.0)
        var fire = 0
        var smoke = 0
        for (px in argbPixels) {
            val r = (px shr 16) and 0xFF
            val g = (px shr 8) and 0xFF
            val b = px and 0xFF
            if (r > 130 && g > 55 && r > g * 1.3 && b < 100) fire++
            if (abs(r - g) < 20 && abs(g - b) < 20 && r > 90 && r < 210) smoke++
        }
        val total = argbPixels.size.toDouble()
        val fireRatio = fire / total
        val smokeRatio = smoke / total
        val base = fireRatio * 600.0 + smokeRatio * 400.0
        val confidence = base.coerceIn(10.0, 99.0).roundToInt()
        return PreScan(
            present = fireRatio > 0.008 || smokeRatio > 0.02,
            confidence = confidence,
            fireRatio = fireRatio,
            smokeRatio = smokeRatio
        )
    }

    /**
     * The stamped facts for one capture (web captureSnapshot HUD block).
     * latText/lngText/utcText are ALWAYS stamped; bearing/pitch honor the
     * user's includeTelemetry choice (web: "SENSOR STAMP: OFF" replaces the
     * bearing line, the pitch line is omitted entirely).
     */
    data class Stamp(
        val latText: String,
        val lngText: String,
        /** null = telemetry disabled (overlay draws the OFF marker instead). */
        val bearingLine: String?,
        /** null = telemetry disabled or pitch absent within the OFF branch. */
        val pitchLine: String?,
        val utcText: String
    )

    fun utcStampText(nowMs: Long): String =
        "UTC CAPTURE: " + Instant.ofEpochMilli(nowMs).toString().take(19) + "Z"

    /**
     * Web-exact line composition:
     *   BEARING: {h}° {dir} ({SRC}) | BEARING: N/A ({SRC}) — source always shown
     *   PITCH:   {p}° ({SRC})           | PITCH: N/A             — source dropped on N/A
     * Sources are upper-cased provenance tags (SENSOR/MANUAL/NONE).
     */
    fun buildStamp(
        lat: Double?,
        lng: Double?,
        heading: Int?,
        headingSource: String?,
        pitch: Int?,
        pitchSource: String?,
        includeTelemetry: Boolean,
        nowMs: Long
    ): Stamp {
        val latText = lat?.let { String.format(Locale.US, "%.6f", it) } ?: "N/A"
        val lngText = lng?.let { String.format(Locale.US, "%.6f", it) } ?: "N/A"
        if (!includeTelemetry) {
            return Stamp(latText, lngText, bearingLine = null, pitchLine = null, utcText = utcStampText(nowMs))
        }
        val hSrc = (headingSource ?: "NONE").uppercase(Locale.US)
        val bearingLine = if (heading != null) {
            "BEARING: ${heading}° ${bearingDirectionAr(heading.toDouble())} ($hSrc)"
        } else {
            "BEARING: N/A ($hSrc)"
        }
        val pSrc = (pitchSource ?: "NONE").uppercase(Locale.US)
        val pitchLine = if (pitch != null) "PITCH: ${pitch}° ($pSrc)" else "PITCH: N/A"
        return Stamp(latText, lngText, bearingLine, pitchLine, utcStampText(nowMs))
    }

    /** The OFF marker drawn in place of the bearing line when telemetry is disabled. */
    const val STAMP_OFF_LINE = "SENSOR STAMP: OFF"

    /**
     * Alignment stamp lines (web: green matched block / red no-match line).
     * Location name clipped to 35 chars exactly like the web substring.
     */
    fun alignmentStampLines(alignment: Alignment?): List<String> {
        if (alignment == null) return listOf("NO EXISTING REPORT WITHIN BEARING/RANGE")
        return listOf(
            "ALIGNMENT WITH EXISTING REPORT: ${alignment.confidencePct}% (ESTIMATE)",
            "LOCATION: " + alignment.locationName.take(35).uppercase(Locale.US)
        )
    }
}
