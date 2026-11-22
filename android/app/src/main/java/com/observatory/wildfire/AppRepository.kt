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

    // Fix 18 (NREP-4): one lock per queue kind. Snapshot + write happen
    // inside the same lock, so two writers for one kind are totally
    // ordered — the later snapshot is always the later install. The
    // persist lock is the OUTER lock; the queue monitor is taken only
    // inside it via snapshot(). No code path may call persistQueues()
    // while holding a queue monitor (today: enqueue/commit/reserveDue
    // never call persist; the drain loop commits — releasing the monitor —
    // before persisting).
    private val reportQueuePersistLock = Any()
    private val sosQueuePersistLock = Any()

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
    fun broadcastMeshIntel(kind: String, text: String, lat: Double?, lng: Double?): Boolean {
        val svc = meshService ?: return false
        // v2.15.0 honesty gate: the mesh wire format signs lat/lng as
        // physical coordinates and parseFrame rejects non-finite frames
        // (MeshWireTest pin). A no-fix broadcast would have to fabricate
        // coordinates — the exact Algiers-fallback sin v2.15.0 removes.
        // So: no fix => no mesh broadcast; the message stays local (coords-less
        // chat entry) and the internet path (hasLocation:false) is the
        // honest channel for coordinate-less SOS.
        if (lat == null || lng == null) return false
        val json = ApiPayloads.buildMeshIntelJson(kind, text, lat, lng, System.currentTimeMillis())
        // Fix 16 (NSVC-5): SOS must NOT ride as wire type "echo". Echo
        // frames are plaintext-by-design on the wire (MeshInbound
        // base64-decodes them without decrypting), but MeshService
        // encrypts EVERY locally queued type with AES-GCM — so an SOS sent
        // as echo arrived at peers as raw ciphertext decoded as UTF-8
        // ("encrypted garbage") and its coordinates were never admitted.
        // SOS is JSON intel like any report: send it as "report" so
        // receivers decrypt it through the normal path and parse its
        // coordinates. No legitimate caller emits echo anymore; the wire
        // type stays accepted for backward compatibility with older builds.
        val ok = svc.broadcastMessage(json, "report", lat, lng)
        if (ok) {
            val entry = MeshChatEntry(
                id = "me_${System.currentTimeMillis()}",
                text = text.take(300),
                kind = kind,
                fromMe = true,
                tsMs = System.currentTimeMillis(),
                hasCoords = lat != null && lng != null
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
                    // Fix 18 (NREP-5): confirm durability BEFORE promising
                    // storage. The entry stays in memory (the drain loop
                    // can still send it while the app lives), but onDone
                    // (false) when it is not on disk — process death would
                    // lose it, so claiming storage would be dishonest.
                    val (reportsResult, _) = persistQueues()
                    // Fix 18 (NREP-5 follow-up, CodeRabbit Major
                    // 4660332342): `durable` alone is vacuous for an
                    // empty snapshot — the drain may have reserved this
                    // entry between the enqueue and the persist. Report
                    // queuing only when THIS submission's key is in the
                    // file that was actually written.
                    if (reportsResult.durable && key in reportsResult.persistedKeys) {
                        onDone(true, OFFLINE_QUEUED_MSG)
                    } else {
                        onDone(false, QUEUE_PERSIST_FAILED_MSG)
                    }
                }
            }
            bumpQueueSize()
        }
    }

    fun sendSos(
        deviceId: String, lat: Double?, lng: Double?,
        name: String?, phone: String?, textMessage: String?,
        audioDataUri: String?, audioDurationSec: Int?,
        onDone: (ok: Boolean, outcome: SosOutcome?, userError: String?) -> Unit
    ) {
        // F1+F4: the idempotency key is minted ONCE per logical SOS, embedded
        // in the body AND used as the queue key — a replay (offline queue or
        // retry) can never become a second emergency call.
        // Fix 18 (NREP-5 follow-up, CodeRabbit Major 4660269795): one
        // pending SOS per device. A re-press while an SOS is already
        // queued must NOT mint a second key — the server's 5-minute
        // per-device window 409s the second key, and dropping it on 409
        // (the first 18b attempt) loses a distinct emergency. Reuse the
        // queued entry's key: the re-press is the same logical SOS, and
        // the server's replay returns the stored SOS for a repeated key
        // instead of a duplicate. A cold start can still restore several
        // pre-fix entries; the first (oldest) key is reused and the rest
        // keep the old retry behaviour — no loss, just no new key.
        val key = sosQueue.snapshot().firstOrNull()?.key
            ?: ApiPayloads.newClientGeneratedId()
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
        // v2.15.0: no-fix SOS gossips WITHOUT coordinates — peers must not
        // receive a fabricated position (the old Algiers fallback put every
        // no-fix caller in the same square kilometer of Algiers).
        if (lat != null && lng != null) broadcastMeshIntel("sos", textMessage ?: "نداء استغاثة!", lat, lng)
        else broadcastMeshIntel("sos", "⚠ بدون تحديد GPS — " + (textMessage ?: "نداء استغاثة!"), null, null)
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
                // Fix 18 (NREP-5 follow-up, CodeRabbit Major 4660269795):
                // the re-press refreshes the WAITING entry's payload
                // under the same key (fresher location/audio, same
                // logical SOS). An in-flight entry is owned by the drain
                // and is never touched — the emergency itself is already
                // being sent; a fresh key is only minted when nothing is
                // queued at all (see above).
                val admitted = sosQueue.replacePayload(key, body) || sosQueue.enqueue(key, body)
                persistSnapshot()
                // Fix 18 (NREP-5): confirm durability BEFORE promising
                // storage; do NOT set queuedWhileOffline when the entry
                // is memory-only — that flag is cleared by the drain loop
                // only when the queue empties, and it would keep promising
                // a send that process death will cancel. The entry stays
                // in memory (the drain loop can still send it while the
                // app lives), but onDone(false) when it is not on disk.
                val (_, sosResult) = persistQueues()
                // Fix 18 (NREP-5 follow-up, CodeRabbit Major 4660332342):
                // `durable` alone is vacuous for an empty snapshot. When
                // admission was rejected (key in flight — `admitted` is
                // false), the drain owns the entry's fate: it may deliver
                // it, or poison-drop it after 8 failed attempts, while
                // the persist still reports durable on an empty snapshot
                // — so never report queuing then. Report queuing only
                // when this submission was admitted AND its key is in the
                // file that was actually written AND still in the queue.
                // Known residual: an admitted entry at 7 failed attempts
                // can still be poison-dropped by the drain after a
                // truthful report — the pre-existing MAX_ATTEMPTS
                // doctrine, out of scope for this part (changing it is a
                // separate product decision, not a queue bug).
                val keyStored = sosResult.durable &&
                    key in sosResult.persistedKeys &&
                    sosQueue.snapshot().any { it.key == key }
                if (admitted && keyStored) {
                    _state.value = _state.value.copy(
                        sos = SosUiState(sending = false, queuedWhileOffline = true)
                    )
                    onDone(true, null, OFFLINE_QUEUED_MSG)
                } else {
                    _state.value = _state.value.copy(
                        sos = SosUiState(sending = false, queuedWhileOffline = false)
                    )
                    onDone(false, null, QUEUE_PERSIST_FAILED_MSG)
                }
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
            // Phase C (principal-cookie ghosts): send the persisted principal
            // so the server recognizes the device and renews the SAME
            // identity — without it (bare HttpURLConnection has no cookie
            // jar) every rejoin minted a fresh principal = ghost member.
            val cookie = readSavedPrincipalCookie()?.let { "${ObservatoryApi.PRINCIPAL_COOKIE_NAME}=$it" }
            val result = io { api.post("/api/teams/join", joinBody, cookie) }
            if (!result.is2xx) {
                val msg = (result as? ObservatoryApi.Result.HttpError)
                    ?.let { extractServerError(it.body) } ?: "تعذر الاتصال بالخادم"
                onDone(false, null, msg)
                return@launch
            }
            val ok2xx = result as ObservatoryApi.Result.Ok
            // Server-driven identity continuity: persist the principal cookie
            // the server just sent (first issuance or sliding renewal).
            ok2xx.setCookies?.let { headers ->
                api.extractPrincipalCookie(headers)?.let { persistPrincipalCookie(it) }
            }
            val join = Parsers.parseTeamJoin(ok2xx.body)
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
        // The principal cookie (persisted separately below) is NOT a bearer
        // credential — it is a device pseudonym that keeps the rejoin
        // anchored to the SAME member identity; a browser would keep it in
        // its cookie jar on disk all the same.
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

    /** Phase C: the persisted public_principal pseudonym (identity only, no authority). */
    private fun readSavedPrincipalCookie(): String? {
        return try {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString("principal_cookie", null)
        } catch (e: Exception) {
            null
        }
    }

    private fun persistPrincipalCookie(value: String) {
        try {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString("principal_cookie", value).apply()
        } catch (e: Exception) {
            // Storage refusal must never break a join — the device just
            // falls back to today's (pre-Phase-C) fresh-principal behavior.
        }
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

    /**
     * One full refresh pass; each endpoint fails independently.
     * v2.15.0 audit fix (last-good semantics): a failed endpoint used to
     * return an EMPTY list and the failure was copied into state AND the
     * on-disk snapshot — one bad poll could wipe evacuation targets from
     * the UI and cold-start restore alike. A failed endpoint now keeps the
     * LAST GOOD data (stale but real beats empty-but-fresh), and only a
     * fully-successful pass updates lastSyncMs/persist.
     */
    suspend fun refreshAll() = withContext(Dispatchers.IO) {
        val prev = _state.value
        // Fix 17 (NREP-1): keep the nullable fetch results separate from
        // the last-good fallback, so success is decided by nullability
        // (all four endpoints returned a list), not by the old OR over
        // reference identity — one success used to stamp a mixed old/new
        // snapshot as a fully-successful pass.
        val reportsR = fetchList("/api/reports") { Parsers.parseReports(it) }
        val hotspotsR = fetchList("/api/satellite-data") { Parsers.parseHotspots(it) }
        val safezonesR = fetchList("/api/safezones") { Parsers.parseSafezones(it) }
        val wilayasR = fetchList("/api/wilayas") { Parsers.parseWilayas(it) }
        val allSucceeded = RefreshPolicy.refreshSucceeded(reportsR, hotspotsR, safezonesR, wilayasR)
        val reports = reportsR ?: prev.reports
        val hotspots = hotspotsR ?: prev.hotspots
        val safezones = safezonesR ?: prev.safezones
        val wilayas = wilayasR ?: prev.wilayas
        _state.value = _state.value.copy(
            reports = reports,
            hotspots = hotspots,
            safezones = safezones,
            wilayas = wilayas,
            weather = prev.weather,
            lastSyncMs = if (allSucceeded) System.currentTimeMillis() else prev.lastSyncMs
        )
        if (allSucceeded) persistSnapshot()
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

    private fun <T> fetchList(path: String, parse: (String) -> List<T>): List<T>? {
        // Called from refreshAll's caller context (see startPolling → refreshAll
        // is only invoked inside the io-wrapped poll path below).
        // v2.15.0: returns NULL on failure (caller keeps last-good data) —
        // a failed endpoint is no longer indistinguishable from an empty one.
        return when (val r = api.get(path)) {
            is ObservatoryApi.Result.Ok -> {
                val parsed = parse(r.body)
                // Fix 17 (NREP-2): the parsers collapse "malformed body"
                // and "genuinely empty array" into the same emptyList(),
                // so an empty parse is only a success when the body really
                // was an empty array. Anything else that parses to nothing
                // is a failure — the caller keeps last-good data instead
                // of wiping it. A valid array whose every item is
                // malformed is also treated as a failure (zero usable
                // items must not wipe last-good data).
                if (parsed.isEmpty() && !RefreshPolicy.isGenuineEmptyBody(r.body)) {
                    Log.w(TAG, "GET $path returned a malformed body; keeping last-good data")
                    null
                } else parsed
            }
            else -> {
                Log.w(TAG, "GET $path failed: $r")
                null
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
                    // v2.16.0 (audit — I/O under lock): two-phase drain. The
                    // queue hands DUE entries over atomically, the blocking
                    // POSTs run OUTSIDE every queue monitor, and one atomic
                    // commit() records the outcome. enqueue/snapshot/size
                    // callers are never stalled behind a 10s-timeout send,
                    // and per-entry exponential backoff keeps a dead
                    // endpoint from burning a send every 20s tick.
                    val now = System.currentTimeMillis()
                    val reservedR = io { reportQueue.reserveDue(3, now) }
                    val reservedS = io { sosQueue.reserveDue(3, now) }
                    if (reservedR.isNotEmpty() || reservedS.isNotEmpty()) {
                        val deliveredR = HashSet<String>()
                        val deliveredS = HashSet<String>()
                        for (e in reservedR) {
                            if (io { api.post("/api/reports", e.payload).is2xx }) deliveredR.add(e.key)
                        }
                        for (e in reservedS) {
                            // Fix 18 (NREP-5 follow-up, CodeRabbit Major
                            // 4660269795): the first 18b attempt dropped a
                            // queued SOS on the 409 "already received
                            // recently" — withdrawn, it was over-broad:
                            // the server's window is per device, so a
                            // DISTINCT queued emergency inside the window
                            // got the same 409 and was lost without ever
                            // being stored. The duplicate is now prevented
                            // at the source (sendSos reuses the queued
                            // key — one pending SOS per device), so the
                            // drain keeps the old retry-forever behaviour:
                            // a 409 retries with backoff and is admitted
                            // once the window passes. Nothing queued is
                            // ever dropped on a 409.
                            if (io { api.post("/api/sos", e.payload).is2xx }) deliveredS.add(e.key)
                        }
                        io {
                            reportQueue.commit(now, deliveredR)
                            sosQueue.commit(now, deliveredS)
                        }
                        Log.i(
                            TAG,
                            "Offline queue round: delivered=${deliveredR.size + deliveredS.size} " +
                                "reserved=${reservedR.size + reservedS.size}"
                        )
                        // Delivered/poisoned/backoff-timed entries all changed
                        // on disk's behalf — sync so a process death cannot
                        // resurrect delivered items or lose attempt history.
                        // Fix 18 (NREP-5): surface an incomplete persist in
                        // the log (a failed sync means a process death could
                        // resurrect delivered items); the loop itself keeps
                        // running — a persist failure must never kill it.
                        val (drainReports, drainSos) = persistQueues()
                        if (!drainReports.durable || !drainSos.durable) {
                            Log.w(
                                TAG,
                                "Offline queue persist incomplete after drain: " +
                                    "reports omitted=${drainReports.omitted} failed=${drainReports.failed}, " +
                                    "sos omitted=${drainSos.omitted} failed=${drainSos.failed}"
                            )
                        }
                        bumpQueueSize()
                        if (deliveredR.isNotEmpty() || deliveredS.isNotEmpty()) {
                            persistSnapshot()
                        }
                        if (deliveredS.isNotEmpty() && sosQueue.size() == 0) {
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
                    lastError = o.optString("lastError", "").takeIf { it.isNotEmpty() },
                    nextAttemptMs = o.optLong("nextAttemptMs", 0L)
                )
            )
        }
        out
    }.getOrElse { e ->
        Log.w(TAG, "queue restore($kind) failed — starting empty", e)
        emptyList()
    }

    /**
     * Fix 18 (NREP-5): outcome of one queue-file persist. `durable` is
     * true only when every entry in the passed snapshot is on disk — a
     * per-entry skip, a budget break, a failed rename, or any exception
     * all mean the kind is NOT durable. `persisted` counts entries
     * selected for writing (0 when the write failed — nothing new is
     * on disk then); `omitted` counts entries kept memory-only.
     * `persistedKeys` is the set of keys actually written (empty when
     * the write failed). `durable` is VACUOUS for an empty snapshot —
     * an empty queue persists as an empty array — so a caller reporting
     * about ONE submission must also check that submission's key is in
     * `persistedKeys` (Fix 18 follow-up, CodeRabbit Major 4660332342:
     * an in-flight re-pressed SOS whose admission was rejected got
     * reported as queued on the strength of a vacuously durable empty
     * snapshot, while the drain's commit was about to poison-drop it).
     */
    data class QueuePersistResult(
        val persisted: Int,
        val omitted: Int,
        val failed: Boolean,
        val persistedKeys: Set<String> = emptySet()
    ) {
        val durable: Boolean get() = !failed && omitted == 0
    }

    private fun persistQueues(): Pair<QueuePersistResult, QueuePersistResult> {
        val reports = persistQueueFileLocked("reports", reportQueuePersistLock) { reportQueue.snapshot() }
        val sos = persistQueueFileLocked("sos", sosQueuePersistLock) { sosQueue.snapshot() }
        return reports to sos
    }

    /**
     * Fix 18 (NREP-4): the snapshot is taken AND the file is written
     * while holding the per-kind lock — taking the snapshot outside the
     * lock and only locking the write would NOT fix the finding, because
     * the race is precisely snapshot-taken-then-overtaken. Per-kind
     * locking is sufficient (separate files, separate tmp files) and
     * avoids blocking a reports persist on a slow SOS persist.
     */
    private fun persistQueueFileLocked(
        kind: String,
        lock: Any,
        snapshot: () -> List<OfflineQueue.Entry<String>>
    ): QueuePersistResult {
        synchronized(lock) {
            return persistQueueFile(kind, snapshot())
        }
    }

    private fun persistQueueFile(kind: String, entries: List<OfflineQueue.Entry<String>>): QueuePersistResult {
        val (persisted, omitted) = OfflineQueue.selectPersistable(
            entries, MAX_PERSIST_ENTRY_CHARS, MAX_PERSIST_TOTAL_CHARS
        )
        if (omitted > 0) {
            Log.w(TAG, "queue($kind) persist: $omitted of ${entries.size} entries kept memory-only (oversized or over budget)")
            // Review nit: keep the dropped entries identifiable — for an
            // emergency app, knowing WHICH SOS went memory-only matters.
            val oversizedKeys = entries.filter { it.payload.length > MAX_PERSIST_ENTRY_CHARS }.map { it.key }
            if (oversizedKeys.isNotEmpty()) {
                Log.w(TAG, "queue($kind) persist: oversized entries kept memory-only: $oversizedKeys")
            }
        }
        return runCatching {
            val arr = JSONArray()
            for (e in persisted) {
                arr.put(
                    JSONObject().apply {
                        put("key", e.key)
                        put("payload", e.payload)
                        put("attempts", e.attempts)
                        put("lastAttemptMs", e.lastAttemptMs)
                        put("lastError", e.lastError ?: JSONObject.NULL)
                        put("nextAttemptMs", e.nextAttemptMs)
                    }
                )
            }
            val f = queueFile(kind)
            val tmp = java.io.File(context.filesDir, "queue_$kind.json.tmp")
            // Fix 18 (NREP-5 follow-up, CodeRabbit Major 4660191946):
            // the write is durable, not just atomic — the temp file is
            // synced before the rename and the directory after it, so
            // durable==true means the queue survives battery loss. A
            // failed write keeps the previous file intact (the helper
            // never writes directly to the live file).
            val ok = writeFileDurably(tmp, f, arr.toString().toByteArray())
            if (!ok) {
                // Fix 18 (NREP-5 follow-up, CodeRabbit Minor 4660269800):
                // do NOT claim the previous file was kept — a failure
                // after the rename leaves the NEW contents in place with
                // unknown durability. The only honest statement is that
                // durability is not confirmed.
                Log.w(TAG, "queue persist($kind) failed — durability not confirmed")
            }
            QueuePersistResult(
                if (ok) persisted.size else 0,
                omitted,
                failed = !ok,
                persistedKeys = if (ok) persisted.map { it.key }.toSet() else emptySet()
            )
        }.getOrElse { e ->
            Log.w(TAG, "queue persist($kind) failed", e)
            QueuePersistResult(0, omitted, failed = true)
        }
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
        // Fix 17 (NREP-3): no early return when reports and hotspots are
        // both empty. After a fully-successful refresh an empty list is
        // real information (the threats are gone), and the snapshot must
        // replace the stale record — otherwise the next cold start
        // resurrects removed/resolved threats (and stale safezones).
        // Persisting the empty snapshot also keeps lastSyncMs and the
        // safezones, and keeps one code path for all five callers.
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
        /**
         * Fix 18 (NREP-5): total per-file budget — 60 entries × ~700,000
         * chars (a full queue of legal max-size SOS audio payloads) ≈
         * 42 M chars, rounded up to 48 M with headroom for JSON escaping.
         * Worst case two files × ~48 MB (+ one tmp each during write) is
         * the honest price of the "durable queue" promise. The old 12 M
         * budget silently dropped the newest emergencies after ~17
         * max-size SOS payloads, below the queue capacity of 60.
         */
        private const val MAX_PERSIST_TOTAL_CHARS = 48_000_000
        const val OFFLINE_QUEUED_MSG = "لا يوجد اتصال — حُفظ الطلب وسيرسل تلقائيًا عند عودة الشبكة"
        /** Fix 18 (NREP-5): the entry is queued in memory only — it is NOT on disk, so process death would lose it. */
        const val QUEUE_PERSIST_FAILED_MSG = "تعذر حفظ الطلب على الجهاز — سيُحاول إرساله طالما التطبيق مفتوح"

        /**
         * Fix 18 (NREP-5 follow-up, CodeRabbit Major 4660269789): sync a
         * directory to storage via the raw syscall wrapper — opening a
         * directory as a stream is rejected on Android (IoBridge) and on
         * the JVM (OpenJDK's FileInputStream check), which is exactly why
         * the first 18c attempt failed its own unit tests on CI (both
         * success tests, `writeFileDurably` returning false). Android-
         * only by construction: android.system.Os is a stub in JVM unit
         * tests, so this function is never called there — the seam in
         * [writeFileDurably] lets tests pass a fake instead. Proven by
         * compilation (CI build) and device behaviour, not by a unit test.
         */
        internal fun syncDirectory(dir: java.io.File): Boolean {
            return try {
                val fd = android.system.Os.open(dir.absolutePath, android.system.OsConstants.O_RDONLY, 0)
                try {
                    android.system.Os.fsync(fd)
                    true
                } finally {
                    android.system.Os.close(fd)
                }
            } catch (e: Exception) {
                false
            }
        }

        /**
         * Fix 18 (NREP-5 follow-up, CodeRabbit Major 4660191946): write
         * [bytes] to [tmp], sync the file to storage, rename onto
         * [target] (retry once), then sync the containing directory so
         * the rename itself is durable. Returns false if any step fails.
         * A rename is atomic replacement, not durability — without the
         * syncs, a battery loss before writeback could lose a queue
         * already reported as saved. Failure contract (CodeRabbit Minor
         * 4660269800 — the first 18c text got this wrong): a failure
         * BEFORE the rename leaves the old [target] intact; a failure
         * AFTER the rename (directory sync) leaves the NEW contents in
         * place with unknown durability. Either way the return is false
         * and the caller must not report the queue as durable. Never
         * throws — and it deliberately calls no android.util.Log (which
         * is a stub that throws in JVM unit tests); the caller logs the
         * failure. [syncDir] is a seam for tests: production passes the
         * real [syncDirectory], JVM tests pass a fake (Os is a stub
         * there).
         */
        internal fun writeFileDurably(
            tmp: java.io.File,
            target: java.io.File,
            bytes: ByteArray,
            syncDir: (java.io.File) -> Boolean = { dir -> syncDirectory(dir) }
        ): Boolean {
            val dir = target.parentFile ?: return false
            return try {
                java.io.FileOutputStream(tmp).use { out ->
                    out.write(bytes)
                    out.fd.sync()
                }
                if (!tmp.renameTo(target) && !tmp.renameTo(target)) {
                    tmp.delete()
                    return false
                }
                if (!syncDir(dir)) return false
                true
            } catch (e: Exception) {
                tmp.delete()
                false
            }
        }
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
