package com.observatory.wildfire

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/**
 * v2.0.0 (native UI) — the one store every native screen reads.
 *
 * Data sources, in strict priority order:
 *  1. the Render API (fresh threats/reports/safezones/wilayas/weather),
 *  2. the BLE mesh (offline field intel from peers — shown tagged as mesh),
 *  3. the last persisted snapshot (cold start with no connectivity).
 *
 * Submissions (reports/SOS) go out through the API when online, otherwise
 * they queue (OfflineQueue, idempotent by clientGeneratedId) AND always ride
 * the mesh as intel so a neighbor with a live connection can relay them.
 *
 * Threading: all mutations happen on the app-scope coroutine; StateFlow gives
 * every screen the current snapshot on subscribe. Polling pauses while
 * offline and resumes on the connectivity callback.
 */
class AppRepository(
    private val context: Context,
    private val scope: CoroutineScope,
    private val api: ObservatoryApi,
    private val baseUrl: String
) {

    data class MeshChatEntry(
        val id: String,
        val text: String,
        val kind: String,
        val fromMe: Boolean,
        val tsMs: Long,
        val hasCoords: Boolean
    )

    data class TeamUiState(
        val active: Boolean = false,
        val state: String = "idle", // started/stopped/error/revoked/beat
        val teamNameAr: String = "",
        val missionJson: String? = null
    ) {
        val missionPhase: String?
            get() = missionJson?.let { TeamLocationLogic.parseMissionPhase(it) }
        val missionTarget: Pair<Double, Double>?
            get() = missionJson?.let { TeamLocationLogic.parseMissionCoords(it) }
    }

    data class SosUiState(
        val sending: Boolean = false,
        val lastOutcome: SosOutcome? = null,
        val lastError: String? = null,
        val queuedWhileOffline: Boolean = false
    )

    data class Snapshot(
        val reports: List<ThreatReport> = emptyList(),
        val hotspots: List<Hotspot> = emptyList(),
        val safezones: List<Safezone> = emptyList(),
        val wilayas: List<WilayaStatus> = emptyList(),
        val weather: WeatherNow? = null,
        val online: Boolean = false,
        val meshState: String = "unknown",
        val meshPeers: Int = 0,
        val meshChat: List<MeshChatEntry> = emptyList(),
        val meshIntel: List<Parsers.MeshIntel> = emptyList(),
        val team: TeamUiState = TeamUiState(),
        val sos: SosUiState = SosUiState(),
        val queueSize: Int = 0,
        val lastSyncMs: Long = 0
    )

    private val _state = MutableStateFlow(Snapshot())
    val state: StateFlow<Snapshot> = _state

    private val reportQueue = OfflineQueue<String>()
    private val sosQueue = OfflineQueue<String>()

    @Volatile
    var meshService: MeshService? = null

    private val meshListener = { plaintext: String ->
        onMeshPlaintext(plaintext)
    }

    private val teamListener = { state: String, payload: String? ->
        val current = _state.value.team
        _state.value = _state.value.copy(
            team = current.copy(
                active = TeamLocationService.isServiceActive(),
                state = state,
                missionJson = payload ?: current.missionJson.let { old ->
                    // A beat with null payload means "mission cleared".
                    if (state == "beat") null else old
                }
            )
        )
    }

    private val pollStarted = AtomicBoolean(false)
    private var pollJob: Job? = null

    /** Every ObservatoryApi call is BLOCKING HttpURLConnection — it must
     *  never run on the Default dispatcher's compute threads. */
    private suspend fun <T> io(block: () -> T): T = withContext(Dispatchers.IO) { block() }

    fun start() {
        TeamLocationService.addStateListener(teamListener)
        if (pollStarted.compareAndSet(false, true)) {
            restoreSnapshot()
            restoreQueues()
            startPolling()
            startQueueDrainLoop()
        }
    }

    fun stop() {
        TeamLocationService.removeStateListener(teamListener)
    }

    // ========================
    // CONNECTIVITY
    // ========================

    fun onConnectivityChanged(online: Boolean) {
        if (_state.value.online != online) {
            _state.value = _state.value.copy(online = online)
        }
    }

    // ========================
    // MESH
    // ========================

    fun attachMesh(service: MeshService?) {
        meshService?.removeMessageListener(meshListener)
        meshService = service
        service?.addMessageListener(meshListener)
        setMeshState(if (service != null) "connected" else "disconnected")
    }

    fun setMeshState(state: String) {
        val svc = meshService
        _state.value = _state.value.copy(
            meshState = state,
            meshPeers = svc?.getConnectedPeers()?.size ?: 0
        )
    }

    fun refreshMeshPeers() {
        _state.value = _state.value.copy(
            meshPeers = meshService?.getConnectedPeers()?.size ?: 0
        )
    }

    private fun onMeshPlaintext(plaintext: String) {
        val now = System.currentTimeMillis()
        val intel = Parsers.parseMeshIntel(plaintext)
        val entry = MeshChatEntry(
            id = "${now}_${_state.value.meshChat.size}",
            text = intel?.text ?: plaintext.take(300),
            kind = intel?.kind ?: "raw",
            fromMe = false,
            tsMs = intel?.tsMs?.takeIf { it > 0 } ?: now,
            hasCoords = intel?.lat != null && intel?.lng != null
        )
        _state.value = _state.value.copy(
            meshChat = (_state.value.meshChat + entry).takeLast(MESH_CHAT_MAX),
            meshIntel = if (intel != null && entry.hasCoords) {
                (_state.value.meshIntel + intel).takeLast(MESH_INTEL_MAX)
            } else _state.value.meshIntel
        )
    }

    /** Broadcast field intel to nearby peers over BLE (works fully offline). */
    fun broadcastMeshIntel(kind: String, text: String, lat: Double, lng: Double): Boolean {
        val svc = meshService ?: return false
        val json = ApiPayloads.buildMeshIntelJson(kind, text, lat, lng, System.currentTimeMillis())
        val ok = svc.broadcastMessage(json, if (kind == "sos") "echo" else "report", lat, lng)
        if (ok) {
            val entry = MeshChatEntry(
                id = "me_${System.currentTimeMillis()}",
                text = text.take(300),
                kind = kind,
                fromMe = true,
                tsMs = System.currentTimeMillis(),
                hasCoords = true
            )
            _state.value = _state.value.copy(
                meshChat = (_state.value.meshChat + entry).takeLast(MESH_CHAT_MAX)
            )
        }
        return ok
    }

    // ========================
    // SUBMISSIONS
    // ========================

    /**
     * Submit a field report: API when reachable, always meshed, queued when
     * offline. The idempotency key guarantees a queue replay can never
     * duplicate an accepted report (server 200-replays the stored one).
     */
    fun submitReport(
        lat: Double, lng: Double,
        locationName: String, wilaya: String,
        description: String, severity: String,
        deviceId: String,
        imageDataUri: String? = null,
        onDone: (ok: Boolean, userError: String?) -> Unit
    ) {
        val key = ApiPayloads.newClientGeneratedId()
        val built = ApiPayloads.buildReportJson(
            lat, lng, locationName, wilaya, description, severity,
            deviceId = deviceId, clientGeneratedId = key, imageDataUri = imageDataUri
        )
        val body = built?.first
        if (body == null) {
            onDone(false, built?.second ?: "بيانات غير صالحة")
            return
        }
        scope.launch {
            val result = io { api.post("/api/reports", body) }
            when {
                result.is2xx -> {
                    bumpQueueSize(); persistSnapshot()
                    onDone(true, null)
                }
                result is ObservatoryApi.Result.HttpError && result.status in 400..499 -> {
                    // Validation/auth rejection: retrying changes nothing —
                    // surface the reason instead of queueing garbage.
                    onDone(false, extractServerError(result.body) ?: "تم رفض البلاغ (خطأ ${result.status})")
                }
                else -> {
                    reportQueue.enqueue(key, body)
                    broadcastMeshIntel("report", "$locationName — $description", lat, lng)
                    persistSnapshot()
                    persistQueues()
                    onDone(true, OFFLINE_QUEUED_MSG)
                }
            }
            bumpQueueSize()
        }
    }

    fun sendSos(
        deviceId: String, lat: Double, lng: Double,
        name: String?, phone: String?, textMessage: String?,
        audioDataUri: String?, audioDurationSec: Int?,
        onDone: (ok: Boolean, outcome: SosOutcome?, userError: String?) -> Unit
    ) {
        // F1+F4: the idempotency key is minted ONCE per logical SOS, embedded
        // in the body AND used as the queue key — a replay (offline queue or
        // retry) can never become a second emergency call.
        val key = ApiPayloads.newClientGeneratedId()
        val built = ApiPayloads.buildSosJson(
            deviceId, lat, lng, name, phone, textMessage, audioDataUri, audioDurationSec,
            clientGeneratedId = key
        )
        val body = built?.first
        if (body == null) {
            onDone(false, null, built?.second ?: "بيانات غير صالحة")
            return
        }
        _state.value = _state.value.copy(sos = SosUiState(sending = true))
        broadcastMeshIntel("sos", textMessage ?: "نداء استغاثة!", lat, lng)
        scope.launch {
            val result = io { api.post("/api/sos", body) }
            if (result.is2xx) {
                val okBody = (result as ObservatoryApi.Result.Ok).body
                val outcome = Parsers.parseSosOutcome(okBody)
                _state.value = _state.value.copy(
                    sos = SosUiState(sending = false, lastOutcome = outcome)
                )
                onDone(true, outcome, null)
            } else if (result is ObservatoryApi.Result.HttpError && result.status in 400..499) {
                _state.value = _state.value.copy(
                    sos = SosUiState(sending = false, lastError = extractServerError(result.body))
                )
                onDone(false, null, extractServerError(result.body) ?: "تم رفض النداء (خطأ ${result.status})")
            } else {
                sosQueue.enqueue(key, body)
                _state.value = _state.value.copy(
                    sos = SosUiState(sending = false, queuedWhileOffline = true)
                )
                persistSnapshot()
                persistQueues()
                onDone(true, null, OFFLINE_QUEUED_MSG)
            }
            bumpQueueSize()
        }
    }

    /** Join a team; token returned stays in MEMORY only (house doctrine). */
    fun joinTeam(
        code: String, name: String, deviceId: String,
        onDone: (ok: Boolean, teamNameAr: String?, error: String?) -> Unit
    ) {
        val built = ApiPayloads.buildJoinJson(code, name)
        val joinBody = built?.first
        if (joinBody == null) {
            onDone(false, null, built?.second ?: "رمز أو اسم غير صالح")
            return
        }
        scope.launch {
            val result = io { api.post("/api/teams/join", joinBody) }
            if (!result.is2xx) {
                val msg = (result as? ObservatoryApi.Result.HttpError)
                    ?.let { extractServerError(it.body) } ?: "تعذر الاتصال بالخادم"
                onDone(false, null, msg)
                return@launch
            }
            val join = Parsers.parseTeamJoin((result as ObservatoryApi.Result.Ok).body)
            if (join == null) {
                onDone(false, null, "رد غير مفهوم من الخادم")
                return@launch
            }
            persistTeamJoin(code, name, join)
            val cfg = JSONObject().apply {
                put("baseUrl", baseUrl)
                put("token", join.token)
                put("memberId", join.memberId)
                put("teamId", join.teamId)
                put("intervalMs", TeamLocationLogic.DEFAULT_HEARTBEAT_MS)
            }
            val ok = TeamTrackingStarter.start(context, cfg.toString())
            _state.value = _state.value.copy(
                team = TeamUiState(active = ok, state = if (ok) "started" else "error", teamNameAr = join.teamNameAr)
            )
            onDone(ok, join.teamNameAr, if (ok) null else "تعذر بدء خدمة التتبع")
        }
    }

    fun stopTeam() {
        TeamTrackingStarter.stop(context)
    }

    fun rejoinSavedTeam(deviceId: String, onDone: (ok: Boolean, teamNameAr: String?, error: String?) -> Unit) {
        val saved = readSavedTeam() ?: run {
            onDone(false, null, null)
            return
        }
        joinTeam(saved.first, saved.second, deviceId, onDone)
    }

    fun savedTeamInfo(): Pair<String, String>? = readSavedTeam()

    fun clearSavedTeam() {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().remove("team_code").remove("team_name").remove("team_json").apply()
    }

    private fun persistTeamJoin(code: String, name: String, join: Parsers.TeamJoin) {
        // NOTE: only the CODE + display name are persisted. The 12h bearer
        // token NEVER touches disk (TeamLocationService doctrine) — a rejoin
        // after process death mints a fresh token from the saved code.
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("team_code", code)
            .putString("team_name", name)
            .putString("team_json", JSONObject().apply {
                put("memberId", join.memberId)
                put("teamId", join.teamId)
                put("teamNameAr", join.teamNameAr)
            }.toString())
            .apply()
    }

    private fun readSavedTeam(): Pair<String, String>? {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val code = p.getString("team_code", null) ?: return null
        val name = p.getString("team_name", null) ?: return null
        return code to name
    }

    // ========================
    // POLLING
    // ========================

    private fun startPolling() {
        pollJob?.cancel()
        pollJob = scope.launch {
            while (true) {
                if (_state.value.online) {
                    refreshAll()
                }
                delay(POLL_INTERVAL_MS)
            }
        }
    }

    /** One full refresh pass; each endpoint fails independently. */
    suspend fun refreshAll() = withContext(Dispatchers.IO) {
        val reports = fetchList("/api/reports") { Parsers.parseReports(it) }
        val hotspots = fetchList("/api/satellite-data") { Parsers.parseHotspots(it) }
        val safezones = fetchList("/api/safezones") { Parsers.parseSafezones(it) }
        val wilayas = fetchList("/api/wilayas") { Parsers.parseWilayas(it) }
        val weather = _state.value.weather
        _state.value = _state.value.copy(
            reports = reports,
            hotspots = hotspots,
            safezones = safezones,
            wilayas = wilayas,
            weather = weather,
            lastSyncMs = System.currentTimeMillis()
        )
        persistSnapshot()
    }

    fun fetchWeatherAt(lat: Double, lng: Double, onDone: (WeatherNow?) -> Unit) {
        scope.launch {
            val r = io { api.get(ApiPayloads.buildOpenMeteoUrl(lat, lng)) }
            val w = if (r is ObservatoryApi.Result.Ok) Parsers.parseWeather(r.body) else null
            if (w != null) {
                _state.value = _state.value.copy(weather = w)
            }
            onDone(w)
        }
    }

    private fun <T> fetchList(path: String, parse: (String) -> List<T>): List<T> {
        // Called from refreshAll's caller context (see startPolling → refreshAll
        // is only invoked inside the io-wrapped poll path below).
        return when (val r = api.get(path)) {
            is ObservatoryApi.Result.Ok -> parse(r.body)
            else -> {
                Log.w(TAG, "GET $path failed: $r")
                emptyList()
            }
        }
    }

    // ========================
    // QUEUE DRAIN + PERSISTENCE
    // ========================

    private fun startQueueDrainLoop() {
        scope.launch {
            while (true) {
                if (_state.value.online) {
                    val before = reportQueue.size() + sosQueue.size()
                    val n1 = io { reportQueue.drain(3, System.currentTimeMillis()) { api.post("/api/reports", it).is2xx } }
                    val n2 = io { sosQueue.drain(3, System.currentTimeMillis()) { api.post("/api/sos", it).is2xx } }
                    val after = reportQueue.size() + sosQueue.size()
                    if (n1 + n2 > 0) {
                        Log.i(TAG, "Offline queue drained: reports=$n1 sos=$n2")
                    }
                    if (after != before) {
                        // Delivered or poisoned entries were removed — sync disk
                        // so a process death cannot resurrect delivered items.
                        persistQueues()
                        bumpQueueSize()
                        persistSnapshot()
                        if (n2 > 0 && sosQueue.size() == 0) {
                            // The queued SOS went out: clear the "queued" flag
                            // so no screen keeps promising a send that happened.
                            _state.value = _state.value.copy(
                                sos = _state.value.sos.copy(queuedWhileOffline = false)
                            )
                        }
                    }
                }
                delay(QUEUE_DRAIN_MS)
            }
        }
    }

    private fun bumpQueueSize() {
        _state.value = _state.value.copy(queueSize = reportQueue.size() + sosQueue.size())
    }

    // ------------------------
    // F1: durable queue files — the UI promises "سيرسل تلقائيًا عند عودة
    // الشبكة"; only files keep that promise across process death (SharedPreferences
    // is wrong for multi-hundred-KB base64 payloads; filesDir is not).
    // Atomic write (tmp+rename) so a crash mid-write never corrupts the queue.
    // ------------------------

    private fun queueFile(kind: String) = java.io.File(context.filesDir, "queue_$kind.json")

    private fun restoreQueues() {
        val reports = readQueueFile("reports")
        val sos = readQueueFile("sos")
        if (reports.isNotEmpty()) reportQueue.restoreAll(reports)
        if (sos.isNotEmpty()) sosQueue.restoreAll(sos)
        if (reports.isNotEmpty() || sos.isNotEmpty()) {
            Log.i(TAG, "Restored offline queues: reports=${reports.size} sos=${sos.size}")
            bumpQueueSize()
        }
    }

    private fun readQueueFile(kind: String): List<OfflineQueue.Entry<String>> = runCatching {
        val raw = queueFile(kind).readText()
        if (raw.isBlank()) return emptyList()
        val out = ArrayList<OfflineQueue.Entry<String>>()
        val arr = JSONArray(raw)
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            val key = o.optString("key", "")
            val payload = o.optString("payload", "")
            if (key.isBlank() || payload.isEmpty()) continue
            out.add(
                OfflineQueue.Entry<String>(
                    key = key,
                    payload = payload,
                    attempts = o.optInt("attempts", 0),
                    lastAttemptMs = o.optLong("lastAttemptMs", 0L),
                    lastError = o.optString("lastError", "").takeIf { it.isNotEmpty() }
                )
            )
        }
        out
    }.getOrElse { e ->
        Log.w(TAG, "queue restore($kind) failed — starting empty", e)
        emptyList()
    }

    private fun persistQueues() {
        persistQueueFile("reports", reportQueue.snapshot())
        persistQueueFile("sos", sosQueue.snapshot())
    }

    private fun persistQueueFile(kind: String, entries: List<OfflineQueue.Entry<String>>) {
        runCatching {
            val arr = JSONArray()
            var totalChars = 0
            for (e in entries) {
                if (e.payload.length > MAX_PERSIST_ENTRY_CHARS) {
                    Log.w(TAG, "queue($kind) entry ${e.key} too large to persist (${e.payload.length} chars) — memory-only")
                    continue
                }
                if (totalChars + e.payload.length > MAX_PERSIST_TOTAL_CHARS) {
                    Log.w(TAG, "queue($kind) persist budget reached — ${entries.size - arr.length()} newest entries kept memory-only")
                    break
                }
                totalChars += e.payload.length
                arr.put(
                    JSONObject().apply {
                        put("key", e.key)
                        put("payload", e.payload)
                        put("attempts", e.attempts)
                        put("lastAttemptMs", e.lastAttemptMs)
                        put("lastError", e.lastError ?: JSONObject.NULL)
                    }
                )
            }
            val f = queueFile(kind)
            val tmp = java.io.File(context.filesDir, "queue_$kind.json.tmp")
            tmp.writeText(arr.toString())
            if (!tmp.renameTo(f)) {
                f.writeText(arr.toString())
                tmp.delete()
            }
        }.onFailure { Log.w(TAG, "queue persist($kind) failed", it) }
    }

    /** Cold-start fallback: the last good API snapshot survives process death. */
    fun restoreSnapshot() {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString("snapshot_json", null) ?: return
        runCatching {
            val o = JSONObject(raw)
            _state.value = _state.value.copy(
                reports = Parsers.parseReports(o.optJSONArray("reports")?.toString() ?: "[]"),
                hotspots = Parsers.parseHotspots(o.optJSONArray("hotspots")?.toString() ?: "[]"),
                safezones = Parsers.parseSafezones(o.optJSONArray("safezones")?.toString() ?: "[]"),
                lastSyncMs = o.optLong("lastSyncMs", 0L)
            )
        }
    }

    private fun persistSnapshot() {
        if (_state.value.reports.isEmpty() && _state.value.hotspots.isEmpty()) return
        runCatching {
            val o = JSONObject()
            o.put("reports", JSONArray(_state.value.reports.map { r ->
                JSONObject().apply {
                    put("id", r.id); put("lat", r.lat); put("lng", r.lng)
                    put("locationName", r.locationName); put("wilaya", r.wilaya)
                    put("description", r.description); put("severity", r.severity)
                    put("status", r.status)
                    put("timestamp", java.time.Instant.ofEpochMilli(r.timestampMs).toString())
                    put("consensusCount", r.consensusCount)
                }
            }))
            o.put("hotspots", JSONArray(_state.value.hotspots.map { h ->
                JSONObject().apply {
                    put("id", h.id); put("lat", h.lat); put("lng", h.lng)
                    put("confidence", h.confidence)
                    put("scanTime", java.time.Instant.ofEpochMilli(h.scanTimeMs).toString())
                    put("satellite", h.satellite); put("brightness", h.brightness)
                }
            }))
            o.put("safezones", JSONArray(_state.value.safezones.map { s ->
                JSONObject().apply {
                    put("id", s.id); put("nameAr", s.nameAr)
                    put("lat", s.lat); put("lng", s.lng)
                    put("capacity", s.capacity); put("hasMedical", s.hasMedical); put("isActive", true)
                }
            }))
            o.put("lastSyncMs", _state.value.lastSyncMs)
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString("snapshot_json", o.toString()).apply()
        }.onFailure { Log.w(TAG, "snapshot persist failed", it) }
    }

    private fun extractServerError(body: String): String? = runCatching {
        JSONObject(body).optString("error", "").takeIf { it.isNotBlank() }
    }.getOrNull()

    companion object {
        private const val TAG = "AppRepository"
        private const val PREFS = "observatory_repo"
        private const val POLL_INTERVAL_MS = 30_000L
        private const val QUEUE_DRAIN_MS = 20_000L
        private const val MESH_CHAT_MAX = 200
        private const val MESH_INTEL_MAX = 100
        /** Per-entry persistence guard: a maxed legal payload (700k-char SOS audio) fits; runaway garbage does not. */
        private const val MAX_PERSIST_ENTRY_CHARS = 800_000
        /** Total per-file budget — bounds disk even with a full 60-entry queue of big payloads. */
        private const val MAX_PERSIST_TOTAL_CHARS = 12_000_000
        const val OFFLINE_QUEUED_MSG = "لا يوجد اتصال — حُفظ الطلب وسيرسل تلقائيًا عند عودة الشبكة"
    }
}

/**
 * Thin indirection over starting/stopping TeamLocationService so repository
 * tests (if ever needed) and the UI share one door — and so the start intent
 * construction lives in exactly one place.
 */
object TeamTrackingStarter {
    fun start(context: Context, configJson: String): Boolean = try {
        val intent = android.content.Intent(context, TeamLocationService::class.java)
            .setAction(TeamLocationService.ACTION_START)
            .putExtra(TeamLocationService.EXTRA_CONFIG, configJson)
        androidx.core.content.ContextCompat.startForegroundService(context, intent)
        true
    } catch (e: Exception) {
        Log.w("TeamTrackingStarter", "start failed", e)
        false
    }

    fun stop(context: Context) {
        context.startService(
            android.content.Intent(context, TeamLocationService::class.java)
                .setAction(TeamLocationService.ACTION_STOP)
        )
    }
}
