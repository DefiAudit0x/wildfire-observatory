package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the client-side mirror of the server zod gates (reports/sos/teams-join)
 * and every external URL builder the native app talks to.
 */
class ApiPayloadsTest {

    @Test
    fun `report body happy path shape`() {
        val pair = ApiPayloads.buildReportJson(
            lat = 36.75, lng = 3.05,
            locationName = "غابة بابازور", wilaya = "الجزائر",
            description = "دخان كثيف يتصاعد من التل", severity = "high",
            deviceId = "dev-1", clientGeneratedId = "abcd1234abcd1234abcd1234abcd1234"
        )
        assertNull(pair?.second)
        val body = pair?.first
        assertNotNull(body)
        body!!
        assertTrue(body.contains("\"lat\":36.75"))
        assertTrue(body.contains("\"severity\":\"high\""))
        assertTrue(body.contains("\"reporterType\":\"citizen\""))
        assertTrue(!body.contains("\"image\"")) // omitted when no photo
    }

    @Test
    fun `report lat out of range returns error`() {
        val r = ApiPayloads.buildReportJson(95.0, 3.0, "موقع صالح", "الجزائر", "وصف كافٍ للوصف الميداني", "low", deviceId = "d", clientGeneratedId = "12345678")
        assertNull(r?.first)
        assertNotNull(r?.second)
    }

    @Test
    fun `report short description rejected`() {
        val r = ApiPayloads.buildReportJson(36.0, 3.0, "موقع صالح", "الجزائر", "قصير", "low", deviceId = "d", clientGeneratedId = "12345678")
        assertNull(r?.first)
    }

    @Test
    fun `report unknown severity rejected`() {
        val r = ApiPayloads.buildReportJson(36.0, 3.0, "موقع صالح", "الجزائر", "وصف كافٍ للوصف الميداني", "extreme", deviceId = "d", clientGeneratedId = "12345678")
        assertNull(r?.first)
    }

    @Test
    fun `report oversized image refused before the request`() {
        val big = "data:image/jpeg;base64," + "A".repeat(600_000)
        val r = ApiPayloads.buildReportJson(36.0, 3.0, "موقع صالح", "الجزائر", "وصف كافٍ للوصف الميداني", "low", deviceId = "d", clientGeneratedId = "12345678", imageDataUri = big)
        assertNull(r?.first)
    }

    @Test
    fun `sos body clamps duration truncates text omits empties`() {
        val pair = ApiPayloads.buildSosJson(
            deviceId = "dev-1", lat = 36.75, lng = 3.05,
            name = "  أحمد  ", phone = "", textMessage = "x".repeat(900),
            audioDataUri = "data:audio/mp4;base64,AAAA", audioDurationSec = 99
        )
        assertNull(pair?.second)
        val body = pair?.first
        assertNotNull(body)
        body!!
        assertTrue(body.contains("\"audioDuration\":20"))
        assertTrue(body.contains("\"name\":\"أحمد\""))
        assertTrue(!body.contains("\"phone\""))
        assertTrue(body.contains("\"textMessage\""))
        val textLen = Regex("\"textMessage\":\"([^\"]*)\"").find(body)!!.groupValues[1].length
        assertEquals(500, textLen)
    }

    @Test
    fun `sos oversized audio refused`() {
        val big = "data:audio/mp4;base64," + "A".repeat(800_000)
        val r = ApiPayloads.buildSosJson("d", 36.0, 3.0, null, null, null, big, 5)
        assertNull(r?.first)
    }

    @Test
    fun `sos body embeds clientGeneratedId when provided (F1+F4 contract)`() {
        val pair = ApiPayloads.buildSosJson(
            deviceId = "dev-1", lat = 36.75, lng = 3.05,
            name = null, phone = null, textMessage = null,
            audioDataUri = null, audioDurationSec = null,
            clientGeneratedId = "abcd1234abcd1234abcd1234abcd1234"
        )
        assertNull(pair?.second)
        val body = pair?.first!!
        assertTrue(body.contains("\"clientGeneratedId\":\"abcd1234abcd1234abcd1234abcd1234\""))
        // Right after deviceId — the server reads it before admission.
        assertTrue(body.indexOf("\"clientGeneratedId\"") < body.indexOf("\"lat\""))
    }

    @Test
    fun `sos body omits clientGeneratedId when absent`() {
        val body = ApiPayloads.buildSosJson("d", 36.0, 3.0, null, null, null, null, null)?.first!!
        assertTrue(!body.contains("clientGeneratedId"))
    }

    @Test
    fun `join body validates code and name`() {
        val ok = ApiPayloads.buildJoinJson("  AB12CD34  ", " عضو الفريق ")
        assertEquals("{\"code\":\"AB12CD34\",\"name\":\"عضو الفريق\"}", ok?.first)
        assertNull(ApiPayloads.buildJoinJson("ab", "اسم صحيح")?.first)
        assertNull(ApiPayloads.buildJoinJson("AB12CD34", "أ")?.first)
    }

    @Test
    fun `json escape survives quotes newlines and control chars`() {
        assertEquals("a\\\"b", ApiPayloads.jsonEscape("a\"b"))
        assertEquals("a\\nb", ApiPayloads.jsonEscape("a\nb"))
        assertEquals("a\\\\b", ApiPayloads.jsonEscape("a\\b"))
        assertEquals("a\\u0001b", ApiPayloads.jsonEscape("a\u0001b"))
        // Round trip through org.json is impossible on the JVM test host —
        // the escaped shape itself is the contract.
    }

    @Test
    fun `client generated id is 32 hex chars`() {
        val id = ApiPayloads.newClientGeneratedId()
        assertEquals(32, id.length)
        assertTrue(id.all { it in '0'..'9' || it in 'a'..'f' })
        assertTrue(ApiPayloads.newClientGeneratedId() != id)
    }

    @Test
    fun `osrm url uses lon lat order and full geometry`() {
        val url = ApiPayloads.buildOsrmUrl(36.7538, 3.0588, 36.47, 2.82)
        assertTrue(url.startsWith("https://router.project-osrm.org/route/v1/driving/"))
        assertTrue(url.contains("3.058800,36.753800"))
        assertTrue(url.contains("overview=full"))
        assertTrue(url.contains("geometries=geojson"))
    }

    @Test
    fun `geo reverse rides the server proxy path, not nominatim directly`() {
        // F6/W-H6: the app never speaks to nominatim.openstreetmap.org —
        // exact field coordinates travel only to our own origin, which owns
        // the third-party egress (UA policy, cache, coverage gate).
        val path = ApiPayloads.buildGeoReversePath(36.7538, 3.0588)
        assertTrue(path.startsWith("/api/geo/reverse"))
        assertTrue(path.contains("lang=ar"))
        assertTrue(path.contains("36.753800"))
        assertTrue(path.contains("3.058800"))
    }

    @Test
    fun `open meteo url requests the four current fields`() {
        val url = ApiPayloads.buildOpenMeteoUrl(36.0, 3.0)
        assertTrue(url.contains("current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m"))
    }

    @Test
    fun `mesh intel envelope is report or sos only`() {
        val json = ApiPayloads.buildMeshIntelJson("sos", "أحتاج مساعدة \"الآن\"", 36.0, 3.0, 123L)
        assertTrue(json.contains("\"kind\":\"sos\""))
        assertTrue(json.contains("أحتاج مساعدة \\\"الآن\\\""))
        try {
            ApiPayloads.buildMeshIntelJson("chat", "hi", 36.0, 3.0, 1L)
            throw AssertionError("kind must be whitelisted")
        } catch (e: IllegalArgumentException) {
            // expected
        }
    }

    // v2.15.0: coordinates must format identically under ANY default locale —
    // an ar-DZ device used to emit Arabic-Indic digits/comma decimals into
    // OSRM/Nominatim/Open-Meteo URLs and the AI guidance JSON body.
    @Test
    fun urlBuilders_areLocaleInvariant() {
        val original = java.util.Locale.getDefault()
        try {
            java.util.Locale.setDefault(java.util.Locale("ar", "DZ"))
            val url = ApiPayloads.buildOpenMeteoUrl(36.7538, 3.0588)
            org.junit.Assert.assertTrue(url, url.contains("latitude=36.753800"))
            org.junit.Assert.assertTrue(url, url.contains("longitude=3.058800"))
            org.junit.Assert.assertFalse(url, url.contains(","))
            val osrm = ApiPayloads.buildOsrmUrl(36.7538, 3.0588, 36.9, 7.6)
            org.junit.Assert.assertFalse(osrm, osrm.contains(",3.") && osrm.contains("36,"))
        } finally {
            java.util.Locale.setDefault(original)
        }
    }

    // v2.15.0: a no-fix SOS ships null coordinates + hasLocation:false —
    // the fabricated Algiers fallback is gone end-to-end.
    @Test
    fun buildSosJson_emitsHonestNullCoordsWhenNoFix() {
        val pair = ApiPayloads.buildSosJson(
            "device-ok", null, null,
            name = null, phone = null,
            textMessage = "بدون GPS", audioDataUri = null, audioDurationSec = null,
        )
        val body = pair?.first!!
        org.junit.Assert.assertTrue(body, body.contains("\"lat\":null"))
        org.junit.Assert.assertTrue(body, body.contains("\"lng\":null"))
        org.junit.Assert.assertTrue(body, body.contains("\"hasLocation\":false"))
    }

    @Test
    fun buildSosJson_stillValidatesPresentCoordinates() {
        val bad = ApiPayloads.buildSosJson(
            "device-ok", 95.0, 3.0,
            name = null, phone = null,
            textMessage = null, audioDataUri = null, audioDurationSec = null,
        )
        org.junit.Assert.assertNull(bad?.first)
    }
}
