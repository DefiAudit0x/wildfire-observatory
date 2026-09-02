package com.observatory.wildfire

/**
 * v2.0.0 (native UI) — request payload + URL builders, Android-free.
 *
 * Every builder mirrors the SERVER's zod gate EXACTLY (the schema files in
 * the server routes package):
 * a payload this object refuses to build would be a guaranteed 400, and a
 * payload it does build must be accepted. JSON is assembled with manual
 * StringBuilder escaping (same house pattern as TeamLocationLogic) so the
 * functions stay JVM-testable without org.json.
 *
 * User-origin text (names, descriptions, place labels) crosses these builders
 * — the JSON string escape is load-bearing, not cosmetic.
 */
object ApiPayloads {

    val SEVERITIES = setOf("low", "medium", "high", "critical")
    private val REPORTER_TYPES = setOf("citizen", "volunteer", "official")
    private const val MAX_IMAGE_DATAURI_CHARS = 500_000   // server: image ≤500KB
    private const val MAX_AUDIO_DATAURI_CHARS = 700_000   // server: audioUrl ≤700KB

    fun newClientGeneratedId(): String =
        java.util.UUID.randomUUID().toString().replace("-", "") // 32 chars, within 8..64

    /** JSON string escape: control chars, quotes and backslashes. */
    fun jsonEscape(s: String): String {
        val sb = StringBuilder(s.length + 8)
        for (c in s) {
            when {
                c == '\\' -> sb.append("\\\\")
                c == '"' -> sb.append("\\\"")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c.code < 0x20 -> sb.append("\\u").append(String.format("%04x", c.code))
                else -> sb.append(c)
            }
        }
        return sb.toString()
    }

    private fun jsonNum(d: Double): String = if (d.isFinite()) d.toString() else "null"

    /**
     * POST /api/reports body. Returns null + reason when the input violates
     * the server zod schema — the UI shows the reason instead of burning a
     * rate-limited request on a guaranteed 400.
     */
    fun buildReportJson(
        lat: Double,
        lng: Double,
        locationName: String,
        wilaya: String,
        description: String,
        severity: String,
        reporterType: String = "citizen",
        deviceId: String,
        clientGeneratedId: String,
        imageDataUri: String? = null
    ): Pair<String?, String?>? { // (body, error) — exactly one side is null
        if (!lat.isFinite() || lat < -90.0 || lat > 90.0) return null to "إحداثيات غير صالحة"
        if (!lng.isFinite() || lng < -180.0 || lng > 180.0) return null to "إحداثيات غير صالحة"
        val name = locationName.trim()
        if (name.length < 3 || name.length > 200) return null to "اسم الموقع يجب أن يكون بين 3 و200 حرف"
        val wil = wilaya.trim()
        if (wil.length < 3 || wil.length > 200) return null to "الولاية مطلوبة (3 أحرف على الأقل)"
        val desc = description.trim()
        if (desc.length < 10 || desc.length > 2000) return null to "الوصف يجب أن يكون بين 10 و2000 حرف"
        if (severity !in SEVERITIES) return null to "درجة الخطأ غير معروفة"
        if (reporterType !in REPORTER_TYPES) return null to "نوع المُبلّغ غير معروف"
        if (deviceId.isBlank() || deviceId.length > 128) return null to "معرّف الجهاز غير صالح"
        if (clientGeneratedId.length !in 8..64) return null to "مفتاح الإرسال غير صالح"
        imageDataUri?.let {
            if (it.length > MAX_IMAGE_DATAURI_CHARS) return null to "الصورة أكبر من الحد المسموح (500KB)"
            if (!it.startsWith("data:image/")) return null to "صيغة الصورة غير مدعومة"
        }
        val sb = StringBuilder(256)
        sb.append("{\"lat\":").append(jsonNum(lat))
        sb.append(",\"lng\":").append(jsonNum(lng))
        sb.append(",\"locationName\":\"").append(jsonEscape(name)).append('"')
        sb.append(",\"wilaya\":\"").append(jsonEscape(wil)).append('"')
        sb.append(",\"description\":\"").append(jsonEscape(desc)).append('"')
        sb.append(",\"severity\":\"").append(severity).append('"')
        sb.append(",\"reporterType\":\"").append(reporterType).append('"')
        sb.append(",\"deviceId\":\"").append(jsonEscape(deviceId)).append('"')
        sb.append(",\"clientGeneratedId\":\"").append(jsonEscape(clientGeneratedId)).append('"')
        if (imageDataUri != null) {
            sb.append(",\"image\":\"").append(jsonEscape(imageDataUri)).append('"')
        }
        sb.append('}')
        return sb.toString() to null
    }

    /**
     * POST /api/sos body. audioDuration clamps 1..20 (server zod ≤20s);
     * textMessage truncates to 500; oversized audio data-URI is refused
     * BEFORE the recorder bytes are wasted on a 400.
     */
    fun buildSosJson(
        deviceId: String,
        lat: Double,
        lng: Double,
        name: String?,
        phone: String?,
        textMessage: String?,
        audioDataUri: String?,
        audioDurationSec: Int?
    ): Pair<String?, String?>? {
        if (deviceId.isBlank() || deviceId.length > 128) return null to "معرّف الجهاز غير صالح"
        if (!lat.isFinite() || lat < -90.0 || lat > 90.0) return null to "إحداثيات غير صالحة"
        if (!lng.isFinite() || lng < -180.0 || lng > 180.0) return null to "إحداثيات غير صالحة"
        if (audioDataUri != null && audioDataUri.length > MAX_AUDIO_DATAURI_CHARS) {
            return null to "التسجيل الصوتي أكبر من الحد المسموح"
        }
        val sb = StringBuilder(160)
        sb.append("{\"deviceId\":\"").append(jsonEscape(deviceId)).append('"')
        sb.append(",\"lat\":").append(jsonNum(lat))
        sb.append(",\"lng\":").append(jsonNum(lng))
        name?.trim()?.takeIf { it.isNotEmpty() }?.let {
            sb.append(",\"name\":\"").append(jsonEscape(it.take(120))).append('"')
        }
        phone?.trim()?.takeIf { it.isNotEmpty() }?.let {
            sb.append(",\"phone\":\"").append(jsonEscape(it.take(30))).append('"')
        }
        textMessage?.trim()?.takeIf { it.isNotEmpty() }?.let {
            sb.append(",\"textMessage\":\"").append(jsonEscape(it.take(500))).append('"')
        }
        audioDataUri?.let {
            sb.append(",\"audioUrl\":\"").append(jsonEscape(it)).append('"')
        }
        audioDurationSec?.let {
            sb.append(",\"audioDuration\":").append(it.coerceIn(1, 20))
        }
        sb.append('}')
        return sb.toString() to null
    }

    /** POST /api/teams/join body — code 4..24, name 2..40 after trim. */
    fun buildJoinJson(code: String, name: String): Pair<String?, String?>? {
        val c = code.trim()
        if (c.length !in 4..24) return null to "رمز الانضمام غير صالح"
        val n = name.trim()
        if (n.length !in 2..40) return null to "الاسم يجب أن يكون بين 2 و40 حرفًا"
        return "{\"code\":\"${jsonEscape(c)}\",\"name\":\"${jsonEscape(n)}\"}" to null
    }

    // ========================
    // URL builders (pure — each pinned by tests)
    // ========================

    /** OSRM driving route with full geometry (same endpoint the web uses). */
    fun buildOsrmUrl(userLat: Double, userLng: Double, targetLat: Double, targetLng: Double): String {
        // OSRM wants lon,lat order.
        val coord1 = "${fmtLng(userLng)},${fmt(userLat)}"
        val coord2 = "${fmtLng(targetLng)},${fmt(targetLat)}"
        return "https://router.project-osrm.org/route/v1/driving/$coord1;$coord2?overview=full&geometries=geojson"
    }

    /** Nominatim reverse geocode for the report form's place-name autofill. */
    fun buildNominatimReverseUrl(lat: Double, lng: Double, lang: String = "ar"): String =
        "https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14" +
            "&lat=${fmt(lat)}&lon=${fmtLng(lng)}&accept-language=$lang"

    /** Open-Meteo current weather for the observatory + radar wind vector. */
    fun buildOpenMeteoUrl(lat: Double, lng: Double): String =
        "https://api.open-meteo.com/v1/forecast?latitude=${fmt(lat)}&longitude=${fmtLng(lng)}" +
            "&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m"

    private fun fmt(d: Double): String = String.format("%.6f", d)
    private fun fmtLng(d: Double): String = String.format("%.6f", d)

    /**
     * Mesh plaintext envelope for offline field intel. Native-to-native the
     * receiver parses this with Parsers.parseMeshIntel; old web peers that
     * still listen via the bridge see a readable JSON object either way.
     */
    fun buildMeshIntelJson(kind: String, text: String, lat: Double, lng: Double, tsMs: Long): String {
        require(kind == "report" || kind == "sos") { "mesh intel kind must be report|sos" }
        return "{\"app\":\"wlfire\",\"kind\":\"$kind\",\"text\":\"${jsonEscape(text.take(300))}\"," +
            "\"lat\":${jsonNum(lat)},\"lng\":${jsonNum(lng)},\"t\":$tsMs}"
    }
}
