package com.observatory.wildfire

import org.json.JSONArray
import org.json.JSONObject

/**
 * v2.0.0 (native UI) — server response models + defensive parsers.
 *
 * PARSING NOTE (house rule): these parsers use org.json, which is unavailable
 * on the plain JVM test host, so they are NOT unit-tested (the pure decision
 * logic they feed — ProximityLogic/RiskScore/RadarModel — is). Every parse is
 * per-item try/catch: one malformed record skips itself, never the payload.
 * A missing field means "drop the item", never "invent a default coordinate".
 */

data class ThreatReport(
    val id: String,
    val lat: Double,
    val lng: Double,
    val locationName: String,
    val wilaya: String,
    val description: String,
    val severity: String,
    val status: String,
    val timestampMs: Long,
    val consensusCount: Int
)

data class Hotspot(
    val id: String,
    val lat: Double,
    val lng: Double,
    val confidence: Int,
    val scanTimeMs: Long,
    val satellite: String,
    val brightness: Double
)

data class Safezone(
    val id: String,
    val nameAr: String,
    val lat: Double,
    val lng: Double,
    val capacity: Int,
    val hasMedical: Boolean
)

data class WilayaStatus(
    val nameAr: String,
    val activeFires: Int,
    val hotspots: Int,
    val severity: String,
    val evacuationRecommended: Boolean,
    val emergencyPhone: String
)

data class WeatherNow(
    val tempC: Double,
    val humidityPct: Int,
    val windKph: Double,
    /** Meteorological convention: the direction the wind COMES FROM (0=N). */
    val windFromDeg: Double
)

data class SosOutcome(
    val id: String,
    val priority: String,
    val nearestFireDistanceKm: Double?,
    val nearbyFireCorroborated: Boolean
)

object Parsers {

    private fun safeDouble(o: JSONObject, key: String): Double? =
        if (o.has(key) && !o.isNull(key)) runCatching { o.getDouble(key) }.getOrNull() else null

    /**
     * v2.1.1 — /api/config → {"cartoKey":"…"|null}. Hand-rolled scan (house
     * pattern: no org.json here so the function stays JVM-testable) — the
     * payload is a flat one-key object. Defensive: strict quote shape,
     * empty string is no key, values over 128 chars are refused.
     */
    fun parseCartoKey(body: String): String? {
        val keyIdx = body.indexOf("\"cartoKey\"")
        if (keyIdx < 0) return null
        val colon = body.indexOf(':', keyIdx + 10)
        if (colon < 0) return null
        var i = colon + 1
        while (i < body.length && body[i].isWhitespace()) i++
        if (i >= body.length || body[i] != '"') return null
        i++
        val sb = StringBuilder()
        while (i < body.length && sb.length <= 128) {
            val c = body[i]
            if (c == '"') return sb.toString().takeIf { it.isNotEmpty() }
            if (c == '\\') {
                i += 2
                continue
            }
            sb.append(c)
            i++
        }
        return null
    }

    fun parseReports(body: String): List<ThreatReport> {
        val arr = runCatching { JSONArray(body) }.getOrNull() ?: return emptyList()
        val out = ArrayList<ThreatReport>(arr.length())
        for (i in 0 until arr.length()) {
            runCatching {
                val o = arr.getJSONObject(i)
                val lat = safeDouble(o, "lat") ?: return@runCatching
                val lng = safeDouble(o, "lng") ?: return@runCatching
                val ts = if (o.has("timestamp") && !o.isNull("timestamp")) {
                    runCatching { java.time.Instant.parse(o.getString("timestamp")).toEpochMilli() }.getOrDefault(0L)
                } else 0L
                out.add(
                    ThreatReport(
                        id = o.optString("id", ""),
                        lat = lat, lng = lng,
                        locationName = o.optString("locationName", ""),
                        wilaya = o.optString("wilaya", ""),
                        description = o.optString("description", ""),
                        severity = o.optString("severity", "medium"),
                        status = o.optString("status", "pending"),
                        timestampMs = ts,
                        consensusCount = o.optInt("consensusCount", 0)
                    )
                )
            }
        }
        return out
    }

    fun parseHotspots(body: String): List<Hotspot> {
        val arr = runCatching { JSONArray(body) }.getOrNull() ?: return emptyList()
        val out = ArrayList<Hotspot>(arr.length())
        for (i in 0 until arr.length()) {
            runCatching {
                val o = arr.getJSONObject(i)
                val lat = safeDouble(o, "lat") ?: return@runCatching
                val lng = safeDouble(o, "lng") ?: return@runCatching
                val scan = if (o.has("scanTime") && !o.isNull("scanTime")) {
                    runCatching { java.time.Instant.parse(o.getString("scanTime")).toEpochMilli() }.getOrDefault(0L)
                } else 0L
                out.add(
                    Hotspot(
                        id = o.optString("id", ""),
                        lat = lat, lng = lng,
                        confidence = o.optInt("confidence", 0),
                        scanTimeMs = scan,
                        satellite = o.optString("satellite", ""),
                        brightness = safeDouble(o, "brightness") ?: 0.0
                    )
                )
            }
        }
        return out
    }

    fun parseSafezones(body: String): List<Safezone> {
        val arr = runCatching { JSONArray(body) }.getOrNull() ?: return emptyList()
        val out = ArrayList<Safezone>(arr.length())
        for (i in 0 until arr.length()) {
            runCatching {
                val o = arr.getJSONObject(i)
                if (o.optBoolean("isActive", true)) {
                    val lat = safeDouble(o, "lat") ?: return@runCatching
                    val lng = safeDouble(o, "lng") ?: return@runCatching
                    out.add(
                        Safezone(
                            id = o.optString("id", ""),
                            nameAr = o.optString("nameAr", o.optString("nameFr", "ملاذ آمن")),
                            lat = lat, lng = lng,
                            capacity = o.optInt("capacity", 0),
                            hasMedical = o.optBoolean("hasMedical", false)
                        )
                    )
                }
            }
        }
        return out
    }

    fun parseWilayas(body: String): List<WilayaStatus> {
        val arr = runCatching { JSONArray(body) }.getOrNull() ?: return emptyList()
        val out = ArrayList<WilayaStatus>(arr.length())
        for (i in 0 until arr.length()) {
            runCatching {
                val o = arr.getJSONObject(i)
                val nameAr = o.optString("nameAr", "")
                if (nameAr.isNotEmpty()) {
                    out.add(
                        WilayaStatus(
                            nameAr = nameAr,
                            activeFires = o.optInt("activeFires", 0),
                            hotspots = o.optInt("satelliteHotspots", 0),
                            severity = o.optString("severity", "safe"),
                            evacuationRecommended = o.optBoolean("evacuationRecommended", false),
                            emergencyPhone = o.optString("emergencyPhone", "")
                        )
                    )
                }
            }
        }
        return out
    }

    fun parseWeather(body: String): WeatherNow? = runCatching {
        val current = JSONObject(body).getJSONObject("current")
        WeatherNow(
            tempC = current.getDouble("temperature_2m"),
            humidityPct = current.optInt("relative_humidity_2m", 0),
            windKph = current.optDouble("wind_speed_10m", 0.0),
            windFromDeg = current.optDouble("wind_direction_10m", 0.0)
        )
    }.getOrNull()

    fun parseSosOutcome(body: String): SosOutcome? = runCatching {
        val o = JSONObject(body)
        SosOutcome(
            id = o.optString("id", ""),
            priority = o.optString("priority", "unknown"),
            nearestFireDistanceKm = safeDouble(o, "nearestFireDistanceKm"),
            nearbyFireCorroborated = o.optBoolean("nearbyFireCorroborated", false)
        )
    }.getOrNull()

    /** OSRM route: geometry coordinates → lat/lng pairs, plus distance/duration. */
    fun parseOsrmRoute(body: String): Pair<List<Pair<Double, Double>>, Pair<Double, Double>>? = runCatching {
        val route = JSONObject(body).getJSONArray("routes").getJSONObject(0)
        val coords = route.getJSONObject("geometry").getJSONArray("coordinates")
        val pts = ArrayList<Pair<Double, Double>>(coords.length())
        for (i in 0 until coords.length()) {
            val c = coords.getJSONArray(i)
            pts.add(c.getDouble(1) to c.getDouble(0)) // geojson = lng,lat → lat,lng
        }
        if (pts.isEmpty()) return@runCatching null
        pts to (route.getDouble("distance") to route.getDouble("duration"))
    }.getOrNull()

    /** Nominatim reverse: display_name + state/province for the wilaya field. */
    fun parseNominatimReverse(body: String): Pair<String, String>? = runCatching {
        val o = JSONObject(body)
        val display = o.optString("display_name", "")
        if (display.isBlank()) return@runCatching null
        val address = o.optJSONObject("address")
        val state = address?.optString("state", null as String?)?.takeIf { !it.isNullOrBlank() }
            ?: address?.optString("province", null as String?)?.takeIf { !it.isNullOrBlank() }
            ?: address?.optString("county", "") ?: ""
        display to state
    }.getOrNull()

    /** POST /api/teams/join success → the fields the app persists (token stays in memory). */
    data class TeamJoin(val memberId: String, val teamId: String, val teamNameAr: String, val token: String)

    fun parseTeamJoin(body: String): TeamJoin? = runCatching {
        val o = JSONObject(body)
        val token = o.optString("token", "")
        val memberId = o.optString("memberId", "")
        if (token.isBlank() || memberId.isBlank()) return@runCatching null
        TeamJoin(
            memberId = memberId,
            teamId = o.optString("teamId", ""),
            teamNameAr = o.optString("teamNameAr", o.optString("teamName", "الفريق")),
            token = token
        )
    }.getOrNull()

    /** Incoming mesh intel envelope (see ApiPayloads.buildMeshIntelJson). */
    data class MeshIntel(val kind: String, val text: String, val lat: Double?, val lng: Double?, val tsMs: Long)

    fun parseMeshIntel(plaintext: String): MeshIntel? = runCatching {
        val o = JSONObject(plaintext)
        val app = o.optString("app", "")
        val kind = o.optString("kind", "")
        if (app != "wlfire" || (kind != "report" && kind != "sos")) return@runCatching null
        MeshIntel(
            kind = kind,
            text = o.optString("text", ""),
            lat = safeDouble(o, "lat"),
            lng = safeDouble(o, "lng"),
            tsMs = if (o.has("t")) o.optLong("t", 0L) else 0L
        )
    }.getOrNull()
}
