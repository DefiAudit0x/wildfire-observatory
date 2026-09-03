package com.observatory.wildfire

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.*
import java.util.*
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.math.min
import java.security.SecureRandom

/**
 * Secure Mesh Service with:
 * - Trickle Algorithm for gossip dissemination
 * - Dynamic Reputation System
 * - Ephemeral ID rotation
 * - Smart Sleep Scheduling for battery preservation
 * - Anti-replay nonce tracking
 * - Brotli-inspired compression (deflate)
 *
 * ARC-H16: this class is now the ANDROID SHELL + ORCHESTRATOR. All pure,
 * clock-driven state lives in four JVM-tested modules and moved VERBATIM:
 * - [MeshQueue]      — store-and-forward queue + delivery bookkeeping
 * - [MeshReputation] — TOFU device records + scoring + bounded cap
 * - [MeshPeerRegistry] — transport handles + connection dedupe state
 * - [MeshInbound]    — the inbound gate chain + anti-replay seen-cache
 * The service wires the Nearby transport, the notification/foreground
 * lifecycle, power management, the single ephemeral-rotation clock and the
 * trickle timer — and composes the modules in exactly the original order.
 * The public surface (binder, listeners, broadcastMessage, reputation/
 * peers getters, every companion constant) is unchanged.
 */
class MeshService : Service() {

    companion object {
        const val TAG = "SecureMesh"
        const val CHANNEL_ID = "mesh_channel_01"
        const val SERVICE_ID = "com.observatory.wildfire.mesh"
        // Wire constants live in MeshWire / the ARC-H16 modules (pure JVM,
        // unit-tested); these companion aliases keep call sites readable.
        const val MESSAGE_TYPE_REPORT = MeshInbound.TYPE_REPORT
        const val MESSAGE_TYPE_ECHO = MeshInbound.TYPE_ECHO
        const val MAX_HOPS = MeshWire.MAX_HOPS
        const val PROTOCOL_VERSION = MeshWire.PROTOCOL_VERSION
        const val REPUTATION_INITIAL = MeshReputation.REPUTATION_INITIAL
        // ARC-L24: REPUTATION_GOOD_REPORT (15) and REPUTATION_FALSE_REPORT
        // (-50) were deleted — reputation is scored from AUTHENTICATED
        // traffic quality elsewhere; these two were never referenced and
        // implied a report-quality link that does not exist.
        const val REPUTATION_CONFIRM_MATCH = MeshReputation.REPUTATION_CONFIRM_MATCH
        // Audit B2: penalties are differentiated by offense severity — garbage
        // bytes are often environmental noise, a failed PoW is cheap to fake,
        // a wrong difficulty signals a modified client, and a bad signature is
        // active tampering. A single flat penalty made every offense worth the
        // same (de)credit.
        const val REPUTATION_MALFORMED_FRAME = MeshReputation.REPUTATION_MALFORMED_FRAME
        const val REPUTATION_BAD_POW = MeshReputation.REPUTATION_BAD_POW
        const val REPUTATION_BAD_DIFFICULTY = MeshReputation.REPUTATION_BAD_DIFFICULTY
        const val REPUTATION_BAD_SIGNATURE = MeshReputation.REPUTATION_BAD_SIGNATURE
        const val REPUTATION_MIN = MeshReputation.REPUTATION_MIN
        const val REPUTATION_MAX = MeshReputation.REPUTATION_MAX

        // Trickle constants (milliseconds)
        const val TRICKLE_I_MIN = 1000L
        const val TRICKLE_I_MAX = 30000L
        const val TRICKLE_K = 3       // redundancy constant

        const val EPHEMERAL_ROTATION_MS = 60 * 60 * 1000L
        const val SLEEP_IDLE_THRESHOLD = 120_000L  // 2 min no activity → sleep mode
        const val SLEEP_INTERVAL = 10_000L         // scan every 10s in sleep
        // ARC-L24: ACTIVE_SCAN_INTERVAL (2s) was deleted — it was dead since
        // the trickle rework (ARC-H14): the active rate is TRICKLE_I_MIN,
        // not a fixed scan period.

        // Store-and-forward hygiene constants live in MeshQueue (unit-tested);
        // MESSAGE_TTL_MS is shared with the inbound freshness gate below.
        const val MESSAGE_TTL_MS = MeshQueue.MESSAGE_TTL_MS
        // Admission freshness policy: the signed origin timestamp must be
        // within the message lifetime, with a small allowance for clock skew.
        const val MESSAGE_CLOCK_SKEW_MS = 2 * 60 * 1000L
        const val MAX_PENDING_MESSAGES = MeshQueue.MAX_PENDING_MESSAGES
        const val PEER_STALE_MS = MeshPeerRegistry.PEER_STALE_MS
        const val FORWARDED_MARKER_TTL_MS = MeshQueue.FORWARDED_MARKER_TTL_MS
        // Maximum plaintext size before queueing (audit: prevent OOM via oversized payloads).
        const val MAX_PLAINTEXT_BYTES = 256 * 1024 // 256 KB
        const val MAX_BRIDGE_JSON_BYTES = 512 * 1024 // JSON envelope before parsing

        // Network-wide proof-of-work requirement: the receiver does NOT trust
        // the sender's declared difficulty. A frame carrying anything other
        // than the network requirement is rejected before any hashing — this
        // bounds the verification cost an untrusted neighbor can impose (a
        // "difficulty 999999" frame is dropped, not computed).
        const val PO_W_DIFFICULTY = MeshWire.NETWORK_POW_DIFFICULTY

        // Seen-hash cache bound lives in MeshInbound (unit-tested).
        const val MAX_SEEN_HASHES = MeshInbound.MAX_SEEN_HASHES
        // Secure randomness for protocol nonces and identifiers.
        private val protocolRandom = SecureRandom()
        // Device records cap lives in MeshReputation (unit-tested).
        const val MAX_DEVICE_RECORDS = MeshReputation.MAX_DEVICE_RECORDS
    }

    // Binder for activity communication
    inner class LocalBinder : Binder() {
        fun getService(): MeshService = this@MeshService
    }

    private val binder = LocalBinder()

    // Nearby Connections API
    private lateinit var connectionsClient: ConnectionsClient

    // ARC-H16 pure modules (per-service-instance state, cleared in onDestroy
    // exactly like the original in-service maps).
    private val queue = MeshQueue()
    private val registry = MeshPeerRegistry()
    private val reputation = MeshReputation()
    private val meshInbound = MeshInbound(
        verifySignature = { msg -> CryptoEngine.verifyMessageSignature(msg) },
        decrypt = { msg -> CryptoEngine.decryptFromPeer(msg) }
    )

    // Identity
    private var currentEphemeralId: String = ""
    private var lastEphemeralRotation: Long = 0L

    // Trickle state
    private var trickleInterval = TRICKLE_I_MIN
    private var trickleTimer: Timer? = null
    @Volatile private var lastActivityTime = System.currentTimeMillis()
    private var isSleeping = false

    // Power management
    private var wakeLock: PowerManager.WakeLock? = null

    // Listeners
    private val messageListeners = CopyOnWriteArrayList<(String) -> Unit>()

    fun addMessageListener(listener: (String) -> Unit) {
        messageListeners.add(listener)
    }

    fun removeMessageListener(listener: (String) -> Unit) {
        messageListeners.remove(listener)
    }

    override fun onCreate() {
        super.onCreate()
        connectionsClient = Nearby.getConnectionsClient(this)
        createNotificationChannel()
        startForeground()
        initCrypto()
        // Audit round 12: rotateEphemeralId() restarts Nearby presence with
        // the fresh key name (stop + start advertising/discovery). The old
        // sequence then called startDiscovery()/startAdvertising() AGAIN —
        // a double-start path in the lifecycle. Single start here.
        rotateEphemeralId()
        startTrickleTimer()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        // Audit round 12: the old onDestroy only canceled the timer and
        // stopped endpoints — advertising/discovery kept broadcasting the
        // service's key after destruction, and every state map kept its
        // contents. Full teardown:
        trickleTimer?.cancel()
        trickleTimer = null
        try {
            connectionsClient.stopAdvertising()
        } catch (e: Exception) {
            Log.e(TAG, "stopAdvertising error", e)
        }
        try {
            connectionsClient.stopDiscovery()
        } catch (e: Exception) {
            Log.e(TAG, "stopDiscovery error", e)
        }
        try {
            connectionsClient.stopAllEndpoints()
        } catch (e: Exception) {
            Log.e(TAG, "stopAllEndpoints error", e)
        }
        wakeLock?.let {
            if (it.isHeld) it.release()
        }
        wakeLock = null
        registry.peers.clear()
        reputation.deviceRecords.clear()
        queue.pending.clear()
        queue.forwardedMessages.clear()
        queue.payloadToMessage.clear()
        queue.deliveredTargets.clear()
        meshInbound.seenMessageHashes.clear()
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    // ========================
    // INITIALIZATION
    // ========================

    private fun initCrypto() {
        // Provider note (v1.0.3 field crash): the old code tried to insert the
        // bundled full BouncyCastle provider at priority 1 here. On Android
        // that call ALWAYS no-ops — Security.insertProviderAt returns -1
        // WITHOUT throwing when a provider named "BC" already exists, and the
        // OS ships a stripped one under exactly that name — so the catch
        // block below mislabeled the failure "already installed" for two
        // releases while every getInstance(.., "BC") resolved to the OS's
        // stripped provider and MeshService.onCreate died with
        // NoSuchAlgorithmException. CryptoEngine no longer pins any provider
        // (see its class kdoc): Conscrypt resolves the full algorithm set.
        CryptoEngine.initialize(applicationContext)
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID, "Secure Mesh Network",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Background mesh networking for fire reports"
            setSound(null, null)
        }
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }

    private fun startForeground() {
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Secure Mesh Active")
            .setContentText("Broadcasting encrypted fire reports via Bluetooth")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setOngoing(true)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14+: the runtime type must be a SUBSET of the manifest
            // attribute. MeshService declares specialUse (with its
            // PROPERTY_SPECIAL_USE_FGS_SUBTYPE), so the type passed here MUST
            // be FOREGROUND_SERVICE_TYPE_SPECIAL_USE — passing DATA_SYNC
            // crashed at first mesh start on every Android 14+ device
            // ("foregroundServiceType 0x00000001 is not a subset of
            // 0x40000000", caught by the owner's DEVICE_LAB run) and dataSync
            // would carry a 6-hour runtime cap on Android 15+ anyway.
            startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            // API 29–33: the 2-arg overload rides the manifest type. These
            // platforms predate the specialUse bit, so it is never passed
            // explicitly here.
            startForeground(1, notification)
        }
    }

    // ========================
    // EPHEMERAL ID ROTATION
    // ========================

    @Synchronized
    private fun rotateEphemeralId() {
        // Single rotation authority (audit round 12): CryptoEngine no longer
        // rotates on its own (see CryptoEngine.rotateEphemeralKey) — the
        // service drives THE clock, reads the new snapshot, and restarts
        // Nearby presence with the new key name in one place. There is
        // exactly one path that changes the ephemeral key.
        val snapshot = CryptoEngine.rotateEphemeralKey()
        currentEphemeralId = snapshot.ephemeralId
        lastEphemeralRotation = System.currentTimeMillis()
        Log.d(TAG, "Ephemeral key rotated: $currentEphemeralId")
        // The Nearby endpoint NAME carries the public key (key exchange, see
        // discovery) — a rotated key is invisible to peers until advertising
        // restarts with the new name, so restart it here immediately.
        restartNearbyPresence()
    }

    /**
     * M7 fix: pure read. This used to trigger a rotation as a side effect on
     * an hourly clock — a second, independent rotation timer hiding inside a
     * getter. The documented design is single-authority rotation via
     * trickleTick(); any future caller of this getter (UI, debugging, a
     * library) must not be able to resurrect the dual-clock rotation bug.
     */
    @Synchronized
    fun getEphemeralId(): String = currentEphemeralId

    // ========================
    // NEARBY CONNECTIONS
    // ========================

    private val connectionLifecycleCallback = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
            Log.d(TAG, "Connection initiated: $endpointId")
            // Key exchange at the transport level (audit round 11): the
            // Nearby "endpoint name" carries the initiator's EPHEMERAL
            // PUBLIC KEY (base64, see startAdvertising/requestConnection), so
            // every peer learns the other's key the moment a connection is
            // initiated — no wire message needed, and no deadlock where both
            // sides wait for the other's key.
            //
            // Connection ADMISSION (audit round 12): a connection whose
            // endpoint name does not carry a fully VALID public key — shape
            // gate AND cryptographic SPKI decode — is rejected outright at
            // the handshake. The old code accepted every connection and only
            // failed later at encryption time; that puts every nearby device
            // through connection establishment (and its cost) before being
            // dropped, and lets a malformed advertised key probe the crypto
            // path. Rejection here is cheap and final.
            val initiatorKey = info.endpointName.takeIf { isLikelyPublicKey(it) && CryptoEngine.isValidPublicKey(it) }
            if (initiatorKey == null) {
                Log.w(TAG, "Admission denied: initiator without a valid public key")
                connectionsClient.rejectConnection(endpointId)
                return
            }
            // Upsert (audit round 12): the old code only updated the peer's
            // key when an entry already existed — a peer re-announcing after
            // its own rotation with a NEW key (putIfAbsent semantics in
            // onEndpointFound) kept the STALE key in the registry, and
            // encryption to it either failed or went to a dead key. Every
            // sighting refreshes the CURRENT key.
            registerPeer(endpointId, initiatorKey)
            connectionsClient.acceptConnection(endpointId, payloadCallback)
        }

        override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {
            if (result.status.isSuccess) {
                Log.d(TAG, "Connected: $endpointId")
                registry.connectingPeers.remove(endpointId)
                registry.connectedPeers.add(endpointId)
                // Preserve any key already learned from discovery/initiation
                // instead of wiping it (audit round 11).
                val known = registry.peers[endpointId]
                if (known != null && known.publicKey.isNotBlank()) {
                    registerPeer(endpointId, known.publicKey)
                }
                // Audit round 12: NO lastActivityTime refresh here. The old
                // code treated connection ESTABLISHMENT itself as activity —
                // an attacker could connect/disconnect on a loop to keep the
                // device out of sleep mode forever with zero authenticated
                // traffic. Activity advances only on authenticated frames
                // (handleIncomingMessage).
            } else {
                Log.d(TAG, "Connection failed: $endpointId")
                registry.connectingPeers.remove(endpointId)
                peerCleanup(endpointId)
            }
        }

        override fun onDisconnected(endpointId: String) {
            Log.d(TAG, "Disconnected: $endpointId")
            registry.connectingPeers.remove(endpointId)
            registry.connectedPeers.remove(endpointId)
            peerCleanup(endpointId)
        }
    }

    private val discoveryEndpointCallback = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
            // The advertiser's Nearby name is its ephemeral public key
            // (audit round 11): learn the peer's key NOW, at discovery —
            // before any message exchange — breaking the old bootstrap
            // deadlock where peers only learned keys from received frames.
            val advertisedKey = info.endpointName
                .takeIf { isLikelyPublicKey(it) && CryptoEngine.isValidPublicKey(it) }
                ?: run {
                    Log.w(TAG, "Ignoring endpoint without a valid advertised public key: $endpointId")
                    return
                }
            // TOFU device record (audit round 12): reputation is anchored on
            // the KEY (stable identity), so a device that re-announces under
            // a new endpointId keeps its history, and a device that vanishes
            // stops accumulating state. Records are evicted only by the
            // bounded cap (MAX_DEVICE_RECORDS, least-recently-seen).
            reputation.sight(advertisedKey, System.currentTimeMillis())
            if (reputation.isAdmitted(advertisedKey)) {
                // Upsert the transport handle: a re-announcement (fresh
                // endpointId or rotated key) updates the CURRENT key instead
                // of being ignored by putIfAbsent (audit round 12).
                registerPeer(endpointId, advertisedKey)
                // Audit A4: dedupe the handshake — onEndpointFound can fire
                // repeatedly for the same endpoint while discovery runs.
                if (!registry.connectingPeers.contains(endpointId) && !registry.connectedPeers.contains(endpointId)) {
                    registry.connectingPeers.add(endpointId)
                    connectionsClient.requestConnection(
                        CryptoEngine.getPublicKeyBase64(),
                        endpointId,
                        connectionLifecycleCallback
                    )
                }
            }
        }

        override fun onEndpointLost(endpointId: String) {
            Log.d(TAG, "Lost endpoint: $endpointId")
            registry.connectingPeers.remove(endpointId)
            registry.connectedPeers.remove(endpointId)
            peerCleanup(endpointId)
        }
    }

    /**
     * Register (or refresh) a transport handle. UPSERT semantics (audit round
     * 12): the old putIfAbsent kept the FIRST key seen for an endpointId —
     * after a peer rotated its ephemeral key and re-announced, the registry
     * kept encrypting to the STALE key. Every sighting (discovery,
     * connection-initiated, connection-result) refreshes the CURRENT key.
     * The identity validation gate runs HERE, at the service boundary
     * (shape + cryptographic SPKI decode); the pure registry stores only
     * validated keys.
     */
    @Synchronized
    private fun registerPeer(endpointId: String, publicKey: String) {
        if (endpointId.isBlank() || !isLikelyPublicKey(publicKey) || !CryptoEngine.isValidPublicKey(publicKey)) {
            Log.w(TAG, "Ignoring peer with invalid identity: $endpointId")
            return
        }
        registry.register(endpointId, publicKey, System.currentTimeMillis())
    }

    /**
     * Unified session-bound teardown (audit round 12): EVERY peer-gone event
     * — endpoint lost, disconnected, connection failed, auto-disconnect —
     * runs the SAME cleanup: the transport handle goes ([MeshPeerRegistry]),
     * as do the forwarded markers (retry gate), the in-flight payload
     * bindings, the per-message attempted-target set and the delivered set
     * for that endpoint ([MeshQueue]). The TOFU device RECORD survives
     * deliberately (reputation is identity history, keyed by the key,
     * bounded by MAX_DEVICE_RECORDS).
     */
    @Synchronized
    private fun peerCleanup(endpointId: String) {
        registry.forget(endpointId)
        queue.onPeerGone(endpointId)
    }

    private val payloadCallback = object : PayloadCallback() {
        override fun onPayloadReceived(endpointId: String, payload: Payload) {
            if (payload.type == Payload.Type.BYTES) {
                val bytes = payload.asBytes() ?: return
                // Audit round 11: lastActivityTime is advanced ONLY for
                // authenticated frames, never for arbitrary inbound bytes —
                // an attacker feeding garbage used to keep the device
                // permanently awake (no sleep mode).
                if (handleIncomingMessage(endpointId, bytes)) {
                    lastActivityTime = System.currentTimeMillis()
                }
            }
        }

        override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {
            // Delivery accounting: SUCCESS is the ONLY signal that the peer's
            // transport accepted the bytes — sendPayload() returning means
            // merely "handed to the transport", not "delivered". FAILURE and
            // CANCELED unmark the send attempt so a later retry can be
            // attributed and sent again (audit round 11: CANCELED used to be
            // lumped into the "keep waiting" branch, leaving the forwarded
            // marker behind and starving that peer of retries).
            val binding = queue.payloadToMessage[update.payloadId] ?: return
            when (update.status) {
                PayloadTransferUpdate.Status.SUCCESS -> {
                    queue.deliveredTargets.getOrPut(binding.messageId) { ConcurrentHashMap.newKeySet() }.add(endpointId)
                    queue.payloadToMessage.remove(update.payloadId)
                }
                PayloadTransferUpdate.Status.FAILURE,
                PayloadTransferUpdate.Status.CANCELED -> {
                    // Unmark the send attempt (audit): the forwarded marker is
                    // the retry gate in trickleTick — leaving it behind after
                    // a FAILED transfer would exclude that peer from retries
                    // until the 5-minute marker cleanup. The next trickle
                    // window retries honestly. attemptedTargets cleanup: a
                    // failed attempt must not count toward the "every target
                    // delivered" eviction condition.
                    queue.forwardedMessages.remove("$endpointId:${binding.messageId}")
                    queue.payloadToMessage.remove(update.payloadId)
                    queue.pending.firstOrNull { it.messageId == binding.messageId }
                        ?.attemptedTargets?.remove(endpointId)
                }
                else -> { /* IN_PROGRESS — keep waiting */ }
            }
        }
    }

    private fun startDiscovery() {
        try {
            connectionsClient.startDiscovery(
                SERVICE_ID,
                discoveryEndpointCallback,
                DiscoveryOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build()
            ).addOnFailureListener { Log.e(TAG, "Discovery failed", it) }
        } catch (e: Exception) {
            Log.e(TAG, "Discovery error", e)
        }
    }

    // Audit round 11: advertising carries our PUBLIC KEY as the Nearby
    // endpoint name — that IS the key-exchange channel (see
    // onEndpointFound / onConnectionInitiated). A base64 P-256 key fits the
    // Nearby name length limit (512 bytes). Restarting re-announces the
    // current key after rotation and on demand.
    private fun startAdvertising() {
        try {
            connectionsClient.startAdvertising(
                CryptoEngine.getPublicKeyBase64(),
                SERVICE_ID,
                connectionLifecycleCallback,
                AdvertisingOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build()
            ).addOnFailureListener { Log.e(TAG, "Advertising failed", it) }
        } catch (e: Exception) {
            Log.e(TAG, "Advertising error", e)
        }
    }

    /** Restart advertising/discovery after ephemeral rotation (new key name). */
    private fun restartNearbyPresence() {
        try {
            connectionsClient.stopAdvertising()
        } catch (e: Exception) {
            Log.e(TAG, "stopAdvertising error", e)
        }
        try {
            connectionsClient.stopDiscovery()
        } catch (e: Exception) {
            Log.e(TAG, "stopDiscovery error", e)
        }
        startAdvertising()
        startDiscovery()
    }

    /**
     * Cheap shape gate for keys received as Nearby endpoint names (audit
     * round 11): accept base64 strings of plausible EC public-key length
     * (~91 chars for a P-256 SPKI). Full cryptographic validation happens at
     * first use (decodePublicKey inside encryptForPeer). Rejects names that
     * are clearly NOT keys — legacy builds advertised their 16-char
     * ephemeralId as the name.
     */
    private fun isLikelyPublicKey(name: String): Boolean {
        return name.length in 60..128 && name.all { it.isLetterOrDigit() || it == '+' || it == '/' || it == '=' }
    }

    // ========================
    // MESSAGE HANDLING
    // ========================

    /**
     * Verify + store + relay one incoming frame. Returns true only for
     * AUTHENTICATED frames (PoW + signature + anti-replay all passed) — the
     * caller uses that to advance lastActivityTime so garbage bytes cannot
     * keep the device awake (audit round 11).
     *
     * ARC-H16: the gate CHAIN lives in [MeshInbound] (unit-tested); this
     * orchestration applies its verdict with the original log strings,
     * penalties and side-effect order. One documented reordering: the
     * peer lastSeen touch now runs after the (pure) decrypt step inside
     * evaluate instead of between admission and decryption — both steps
     * are state-independent of each other, so the observable transition
     * sequence is identical.
     */
    private fun handleIncomingMessage(endpointId: String, bytes: ByteArray): Boolean {
        try {
            val verdict = meshInbound.evaluate(
                bytes,
                now = System.currentTimeMillis(),
                messageTtlMs = MESSAGE_TTL_MS,
                clockSkewMs = MESSAGE_CLOCK_SKEW_MS,
                networkPowDifficulty = PO_W_DIFFICULTY
            )
            if (verdict is MeshInbound.Verdict.Rejected) {
                when (verdict.reason) {
                    MeshInbound.RejectReason.MAGIC ->
                        Log.w(TAG, "Incoming frame missing compression magic")
                    // Parse failures were never logged nor penalized in the
                    // original (frame dropped silently).
                    MeshInbound.RejectReason.PARSE -> {}
                    MeshInbound.RejectReason.STALE ->
                        Log.w(TAG, "Rejecting stale or future-dated mesh frame")
                    MeshInbound.RejectReason.DIFFICULTY ->
                        Log.w(TAG, "Out-of-band proof-of-work difficulty")
                    MeshInbound.RejectReason.POW ->
                        Log.w(TAG, "Invalid proof-of-work on wire message")
                    MeshInbound.RejectReason.SIGNATURE ->
                        Log.w(TAG, "Invalid signature on wire message")
                    // Replay: silent reject, no penalty (the frame is
                    // authenticated — the sender did nothing new).
                    MeshInbound.RejectReason.REPLAY -> {}
                }
                verdict.penalty?.let { updateReputation(endpointId, it) }
                return false
            }
            verdict as MeshInbound.Verdict.Accepted
            val payload = verdict.frame

            // Audit round 11: the peer's OWN key now comes from the Nearby
            // name exchange (onEndpointFound / onConnectionInitiated) — never
            // from a received frame's ORIGIN key. The old block here wrote
            // payload.origPublicKey into peers[endpointId], so a relayed
            // frame (common — every node relays store-and-forward traffic)
            // replaced the neighboring device's key with some third device's
            // key, and per-target E2EE then encrypted responses to a key the
            // neighbor doesn't hold. Removed entirely: keys learned from
            // frames are origin keys, not peer keys, and conflating them
            // broke addressing.

            // Keep the sender fresh: a peer that receives from us but is quiet
            // (relay-only) must not go stale (audit round 11: lastSeen was
            // only advanced on connection, so 10 minutes of one-way traffic
            // made us stop sending to an active neighbor).
            registry.touch(endpointId, System.currentTimeMillis())

            val decrypted = verdict.decrypted

            // Store-and-forward relay FIRST (audit B1): enqueue relay BEFORE
            // notifying local listeners so a listener exception cannot stop propagation.
            if (payload.hopsLeft > 0) {
                // H1 fix: the relay path must respect the same queue bound as
                // broadcastMessage — otherwise a peer flooding unique valid
                // frames grows pendingMessages without limit (OOM on a device
                // that must stay alive for an emergency).
                queue.evictIfFull()
                queue.pending.add(MeshQueue.MeshMessage(
                    messageId = payload.messageId,
                    type = payload.type,
                    payloadB64 = payload.payloadB64,
                    iv = payload.iv,
                    hopCount = payload.hopCount,
                    hopsLeft = payload.hopsLeft - 1,
                    origEphemeralId = payload.origEphemeralId,
                    origPublicKey = payload.origPublicKey,
                    timestamp = payload.timestamp,
                    signature = payload.signature,
                    nonce = payload.nonce,
                    lat = payload.lat,
                    lng = payload.lng,
                    powNonce = payload.powNonce,
                    powDifficulty = payload.powDifficulty
                ))
            }

            if (decrypted != null && decrypted.size > MAX_PLAINTEXT_BYTES) {
                Log.w(TAG, "Rejecting oversized decrypted plaintext: ${decrypted.size} bytes")
                return false
            }

            if (decrypted != null) {
                // Notify web layer
                val plaintext = String(decrypted, Charsets.UTF_8)
                notifyListeners(plaintext)

                // Update reputation
                updateReputation(endpointId, REPUTATION_CONFIRM_MATCH)
            } else {
                // E2EE: the message is targeted at another peer. Not decryptable
                // ≠ malicious — never punish relays for not holding the key.
                Log.d(TAG, "Message not addressed to this device (E2EE)")
            }
            return true
        } catch (e: Exception) {
            Log.e(TAG, "Message handling error", e)
            return false
        }
    }

    /**
     * Send a message to the mesh. The plaintext is queued as a store-and-forward
     * entry and encrypted for the best known peer key at send time: a missing
     * peer key or empty peer list never drops the report, it simply waits.
     * Web layer calls this via JS bridge.
     */
    @Synchronized
    fun broadcastMessage(plaintext: String, reportType: String, lat: Double, lng: Double): Boolean {
        if (reportType !in setOf(MESSAGE_TYPE_REPORT, MESSAGE_TYPE_ECHO)) return false
        if (!lat.isFinite() || !lng.isFinite() || lat < -90.0 || lat > 90.0 || lng < -180.0 || lng > 180.0) {
            Log.w(TAG, "Rejecting broadcast with invalid coordinates")
            return false
        }
        // Audit: reject oversized plaintext before queueing to prevent OOM.
        val plaintextBytes = plaintext.toByteArray(Charsets.UTF_8)
        if (plaintextBytes.size > MAX_PLAINTEXT_BYTES) {
            Log.w(TAG, "Rejecting oversized plaintext: ${plaintextBytes.size} bytes > $MAX_PLAINTEXT_BYTES bytes")
            return false
        }
        val messageId = UUID.randomUUID().toString()
        val nonce = protocolRandom.nextInt()

        // ONE snapshot for everything (audit round 11): the PoW challenge,
        // the queued origEphemeralId/origPublicKey and the eventual E2EE
        // signature must derive from the same key material or rotation
        // between reads yields a frame peers reject. The single
        // getEphemeralSnapshot() call makes that impossible to get wrong.
        val snapshot = CryptoEngine.getEphemeralSnapshot()

        // Lightweight Proof-of-Work (anti-spam) — solved here, transmitted in
        // the payload, verified at every receiving hop. Never enqueue a frame
        // that peers are guaranteed to reject if the local solve budget fails.
        val powPrefix = MeshWire.ProofOfWork.wirePrefix(messageId, snapshot.ephemeralId)
        val powNonce = MeshWire.ProofOfWork.solve(powPrefix, PO_W_DIFFICULTY) ?: run {
            Log.w(TAG, "Proof-of-work budget exhausted; dropping frame locally")
            return false
        }

        // Eviction policy: entries that have never been sent to anyone
        // (no reachable peers yet) are shielded from eviction — they carry
        // the newest reports and would otherwise be the first to die under
        // load. Already-attempted entries go first (their 10-minute clock is
        // ordered by lastSendAttemptAt).
        queue.evictIfFull()

        queue.pending.add(MeshQueue.MeshMessage(
            messageId = messageId,
            type = reportType,
            payloadB64 = "",
            iv = "",
            hopCount = 0,
            hopsLeft = MAX_HOPS,
            origEphemeralId = snapshot.ephemeralId,
            origPublicKey = snapshot.publicKeyB64,
            timestamp = System.currentTimeMillis(),
            signature = "",
            nonce = nonce,
            lat = lat,
            lng = lng,
            powNonce = powNonce,
            powDifficulty = PO_W_DIFFICULTY,
            snapshot = snapshot,
            needsEncryption = true,
            plaintext = plaintext
        ))
        return true
    }

    // ========================
    // TRICKLE ALGORITHM
    // ========================

    private fun startTrickleTimer() {
        trickleTimer = Timer("TrickleTimer", true)
        scheduleNextTrickle()
    }

    /**
     * ARC-H14 fix: the timer used to be scheduled with a FIXED 1000ms period,
     * so the sleep-mode interval (SLEEP_INTERVAL = 10s) was computed in
     * managePower() but NEVER applied — the service kept pulsing at 1Hz
     * forever, burning battery while claiming a sleep mode. Self-rescheduling
     * with the live interval makes sleep mode actually slow the loop down and
     * wake it back up at 1Hz on activity.
     *
     * ARC-H15 fix: an unexpected exception inside a fixed-rate TimerTask used
     * to kill the TrickleTimer thread SILENTLY — the foreground service stayed
     * alive with a dead mesh. The tick body is now contained; a failed tick
     * logs and the loop reschedules.
     */
    private fun scheduleNextTrickle() {
        val timer = trickleTimer ?: return
        val delay = if (isSleeping) SLEEP_INTERVAL else TRICKLE_I_MIN
        val task = object : TimerTask() {
            override fun run() {
                try {
                    trickleTick()
                    managePower()
                } catch (t: Throwable) {
                    Log.w(TAG, "Trickle tick failed — contained so the mesh loop survives", t)
                }
                scheduleNextTrickle()
            }
        }
        try {
            timer.schedule(task, delay)
        } catch (e: IllegalStateException) {
            // Timer was cancelled during shutdown — stop the chain.
        }
    }

    @Synchronized
    private fun trickleTick() {
        val now = System.currentTimeMillis()

        // Single rotation clock (audit round 12): THE place where ephemeral
        // rotation is decided. CryptoEngine never rotates on its own (the
        // getters are read-only), so the advertised key, the signing key and
        // the Nearby restart always move together. The other getter path on
        // this service (getEphemeralId) is kept for API stability but is
        // never called by the mesh itself.
        if (now - lastEphemeralRotation > EPHEMERAL_ROTATION_MS) {
            rotateEphemeralId()
            return
        }

        // Store-and-forward hygiene FIRST (audit round 12): the old code ran
        // this AFTER the batch-empty early return, so an idle queue (empty
        // batch) skipped the whole cleanup — stale sees, forwarded markers,
        // delivered sets and payload bindings lived far past their TTL.
        // Expiry is TIME-BASED since the LAST SEND (audit round 12): the old
        // per-window attempt budget died in seconds; a message now burns its
        // 10-minute clock only when delivery was actually attempted, and a
        // message whose every attempted target delivered is evicted early.
        // Never-attempted messages (no peer in range) wait indefinitely —
        // bounded by the queue cap — because they could not act.
        queue.sweepExpiredMessages(now)
        val replayCutoff = now - (MESSAGE_TTL_MS + MESSAGE_CLOCK_SKEW_MS)
        meshInbound.sweepReplayWindow(replayCutoff)
        // Bound enforcement as a safety net (audit): the cap is primarily
        // enforced at insert time (handleIncomingMessage); this catches any
        // growth from the window between inserts.
        meshInbound.enforceSeenCap()
        // ARC-L24: forwarded markers expire 5 minutes after their last
        // delivery attempt so a peer that dropped can accept a re-send.
        queue.sweepMarkers(now)

        // Trickle-K with O(F) counting (audit round 12): the old batch filter
        // ran a full forwardedMessages scan PER queued message — O(M×F) per
        // tick, quadratic in the mesh size. Count forwards ONCE into a small
        // map (O(F)), then filter in O(M).
        val forwardsPerMessage = queue.forwardsInWindow(now, trickleInterval)
        val batch = queue.pending.filter { msg ->
            !msg.inFlight && (forwardsPerMessage[msg.messageId] ?: 0) < TRICKLE_K
        }

        if (batch.isEmpty()) {
            // Double interval up to max (nothing to send right now)
            trickleInterval = min(trickleInterval * 2, TRICKLE_I_MAX)
            return
        }

        batch.forEach { msg ->
            // In-flight guard: set while the send loop below runs, cleared in
            // a finally block (audit round 11). Synchronous sends mean no
            // interleaving today, but the guard is real — a concurrent tick
            // cannot pick up a message the send loop is processing.
            msg.inFlight = true
            try {
                val targetPeers = registry.connectedFreshCandidates(now).filter { (id, info) ->
                    (reputation.score(info.publicKey)) > REPUTATION_MIN / 2 &&
                        !queue.isForwarded(id, msg.messageId)
                }
                if (targetPeers.isEmpty()) {
                    // Store-and-forward: no candidate peer this window. The
                    // message keeps waiting WITHOUT burning its TTL clock —
                    // nothing could be sent.
                    return@forEach
                }

                // Delivery-attempt semantics (audit round 12): the TTL clock
                // (lastSendAttemptAt) advances only when at least one frame
                // was actually handed to the transport — never for scans,
                // missing keys or per-target encryption failures.
                var anySent = false
                targetPeers.forEach peerLoop@ { (endpointId, info) ->
                    try {
                        // Per-target E2EE: each receiver gets a ciphertext
                        // encrypted for its own public key. A shared
                        // ciphertext sent to every peer would let any single
                        // key holder decrypt the whole broadcast.
                        // Already-encrypted frames (relays) travel verbatim —
                        // only the intended key holder decrypts, everyone
                        // else forwards.
                        val encrypted = if (msg.needsEncryption) {
                            val snapshot = msg.snapshot ?: run {
                                Log.w(TAG, "Encryption-required message lost its snapshot; skipping")
                                return@peerLoop
                            }
                            CryptoEngine.encryptForPeerWithSnapshot(
                                snapshot = snapshot,
                                peerPublicKeyBase64 = info.publicKey,
                                payload = msg.plaintext.toByteArray(Charsets.UTF_8),
                                lat = msg.lat,
                                lng = msg.lng,
                                // Audit round 11 (P0, frames never verified):
                                // the old call omitted messageId/type/hopCount
                                // so every locally generated frame failed
                                // signature verification at every peer. The
                                // signed fields must be exactly the fields the
                                // frame transmits: passed in here and read
                                // back from the returned SecureMessage below.
                                messageId = msg.messageId,
                                type = msg.type,
                                hopCount = msg.hopCount
                            ).takeIf { it.ciphertext.isNotBlank() }
                                ?: return@peerLoop // encryption failure: retry next window
                        } else null

                        if (sendToTarget(endpointId, msg, encrypted)) {
                            anySent = true
                            // Per-target dedup: the same frame is never handed
                            // to the same peer twice within a window. A SEND
                            // attempt marker, not a delivery ack (outcome lives
                            // in deliveredTargets).
                            queue.markForwarded(endpointId, msg.messageId, now)
                        }
                    } catch (e: Exception) {
                        // EXCEPTION CONTAINMENT (audit round 12): the tick
                        // runs inside a TimerTask — one uncaught exception
                        // kills the Timer thread and the entire mesh schedule
                        // silently. A malformed-but-admitted peer key (any
                        // slip past the admission gates) must never do that:
                        // quarantine the peer and continue with the rest.
                        Log.e(TAG, "Peer processing failure for $endpointId (${e.javaClass.simpleName}); quarantining", e)
                        quarantinePeer(endpointId)
                    }
                }
                if (anySent) {
                    msg.lastSendAttemptAt = now
                }
            } finally {
                msg.inFlight = false
            }
        }

        // Reset interval
        trickleInterval = TRICKLE_I_MIN
    }

    /**
     * Quarantine a peer that failed mid-processing (audit round 12): drop
     * the transport handle and drop the TOFU record's reputation below the
     * admission threshold so the device is not re-admitted until scoring
     * recovers it. The record itself stays (identity history is bounded and
     * scored), but the quarantine bit is the reputation floor.
     */
    @Synchronized
    private fun quarantinePeer(endpointId: String) {
        registry.peers[endpointId]?.publicKey?.takeIf { it.isNotBlank() }?.let { key ->
            reputation.quarantine(key, System.currentTimeMillis())
        }
        peerCleanup(endpointId)
    }

    // ========================
    // POWER MANAGEMENT
    // ========================

    @Synchronized
    private fun managePower() {
        val idleTime = System.currentTimeMillis() - lastActivityTime

        if (idleTime > SLEEP_IDLE_THRESHOLD && !isSleeping) {
            // Enter sleep mode
            isSleeping = true
            trickleInterval = SLEEP_INTERVAL
            releaseWakeLock()
            Log.d(TAG, "Entering sleep mode (idle ${idleTime}ms)")
        } else if (idleTime < SLEEP_IDLE_THRESHOLD && isSleeping) {
            // Exit sleep mode
            isSleeping = false
            trickleInterval = TRICKLE_I_MIN
            acquireWakeLock()
            Log.d(TAG, "Exiting sleep mode")
        }
    }

    private fun acquireWakeLock() {
        if (wakeLock == null || !wakeLock!!.isHeld) {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "MeshService:SecureMeshWakeLock"
            )
            wakeLock?.acquire(10 * 60 * 1000L)  // max 10 min
        }
    }

    private fun releaseWakeLock() {
        wakeLock?.let {
            if (it.isHeld) it.release()
        }
    }

    // ========================
    // REPUTATION SYSTEM
    // ========================

    /**
     * Reputation is anchored on the peer's TOFU device record (public-key
     * identity — audit round 12): a peer re-announcing under a new Nearby
     * endpointId KEEPS its history, and a vanished peer stops accumulating
     * state (its record is evicted only by the bounded cap). A reputation
     * update for an unregistered endpoint is a no-op — anonymous
     * connections were already gated out at admission, so there is no
     * keyless reputation path to abuse. Scoring/clamping live in
     * [MeshReputation] (unit-tested); this composition adds the endpointId
     * lookup and the transport-level auto-disconnect.
     */
    @Synchronized
    fun updateReputation(endpointId: String, delta: Int) {
        val info = registry.peers[endpointId] ?: run {
            Log.d(TAG, "Reputation update for unknown endpoint $endpointId: ignored")
            return
        }
        if (info.publicKey.isBlank()) return
        val now = System.currentTimeMillis()
        val newScore = reputation.update(info.publicKey, delta, now)

        Log.d(TAG, "Reputation $endpointId (${info.publicKey.take(8)}…): ${newScore - delta} → $newScore (Δ$delta)")

        // Auto-disconnect malicious peers
        if (newScore <= REPUTATION_MIN / 2) {
            connectionsClient.disconnectFromEndpoint(endpointId)
            peerCleanup(endpointId)
        }
    }

    fun getReputation(endpointId: String): Int {
        return registry.peers[endpointId]?.publicKey
            ?.takeIf { it.isNotBlank() }
            ?.let { reputation.score(it) }
            ?: REPUTATION_INITIAL
    }

    fun getConnectedPeers(): List<Map<String, Any>> {
        // ARC-L24: `peers` is populated at DISCOVERY time (registerPeer runs
        // from onEndpointFound, before requestConnection completes), so
        // mapping it whole reported still-CONNECTING endpoints as connected
        // to the WebView UI. Filter to the ACTUALLY-connected set.
        return registry.connectedSnapshot().map { (id, info) ->
            mapOf(
                "endpointId" to id,
                // The public key is the peer's mesh identity (audit round
                // 12: the old ephemeralId field was always "unknown" and
                // hopCount was unused — removed as misleading state).
                "publicKey" to info.publicKey,
                "lastSeen" to info.lastSeen,
                "reputation" to reputation.score(info.publicKey)
            )
        }
    }

    // ========================
    // UTILITY
    // ========================

    /**
     * Serialize, compress and send one frame to one endpoint. A null encrypted
     * block relays the stored ciphertext verbatim (store-and-forward); a
     * non-null one carries a fresh per-target E2EE encryption.
     */
    private fun sendToTarget(endpointId: String, msg: MeshQueue.MeshMessage, encrypted: CryptoEngine.SecureMessage?): Boolean {
        val frame = if (encrypted != null) {
            MeshWire.Frame(
                protocolVersion = PROTOCOL_VERSION,
                // Audit round 11 (P0): the frame now transmits EXACTLY the
                // values the ECDSA signature covers. The old code put
                // msg.messageId / msg.nonce (queue-time values) in the frame
                // while encryptForPeer signed DIFFERENT values (default
                // messageId="" and its internal random nonce) — every
                // locally generated frame failed verification at receivers.
                // With the snapshot-pinned encryption these are identical.
                messageId = encrypted.messageId,
                type = encrypted.type,
                payloadB64 = encrypted.ciphertext,
                iv = encrypted.iv,
                hopCount = encrypted.hopCount,
                origEphemeralId = encrypted.ephemeralId,
                origPublicKey = encrypted.senderPublicKey,
                timestamp = encrypted.timestamp,
                signature = encrypted.signature,
                nonce = encrypted.nonce,
                lat = encrypted.lat,
                lng = encrypted.lng,
                powNonce = msg.powNonce,
                powDifficulty = msg.powDifficulty,
                hopsLeft = msg.hopsLeft
            )
        } else {
            MeshWire.Frame(
                protocolVersion = PROTOCOL_VERSION,
                messageId = msg.messageId,
                type = msg.type,
                payloadB64 = msg.payloadB64,
                iv = msg.iv,
                hopCount = msg.hopCount,
                origEphemeralId = msg.origEphemeralId,
                origPublicKey = msg.origPublicKey,
                timestamp = msg.timestamp,
                signature = msg.signature,
                nonce = msg.nonce,
                lat = msg.lat,
                lng = msg.lng,
                powNonce = msg.powNonce,
                powDifficulty = msg.powDifficulty,
                hopsLeft = msg.hopsLeft
            )
        }
        val json = try {
            MeshWire.frameToJson(frame)
        } catch (e: IllegalArgumentException) {
            // A field carrying '|' would corrupt the pipe-joined frame —
            // never emit it (audit round 11). Only buggy generators reach
            // this; dropping the frame beats corrupting the wire.
            Log.w(TAG, "Frame rejected before send (pipe in field): ${e.message}")
            return false
        }
        val compressed = MeshWire.compress(json.toByteArray(Charsets.UTF_8))
        val payload = Payload.fromBytes(compressed)
        // Attribute the outgoing transfer outcome to this message + endpoint
        // (audit round 12: the binding now carries the endpointId so a peer
        // that vanishes without a final transfer callback can be cleaned up
        // by peerCleanup instead of leaking). The binding is removed on
        // SUCCESS/FAILURE/CANCELED, so a retry attributes cleanly.
        queue.bindOutgoing(payload.id, endpointId, msg.messageId)
        msg.attemptedTargets.add(endpointId)
        // Audit round 11 (B11): the sendPayload Task used to be fire-and-
        // forget — a client-side failure (buffer full, endpoint just died)
        // never unmarked the forwarded marker, silently starving that peer
        // of retries past the 5-minute cleanup. Handle the failure inline.
        connectionsClient.sendPayload(endpointId, payload)
            .addOnFailureListener { e ->
                Log.w(TAG, "sendPayload failed for $endpointId", e)
                MeshDeliveryRetry.onTransportFailure(
                    endpointId,
                    msg.messageId,
                    queue.forwardedMessages,
                    msg.attemptedTargets
                )
                queue.payloadToMessage.remove(payload.id)
            }
        // Update lastSeen for this peer since we successfully handed off a frame to the transport.
        registry.touch(endpointId, System.currentTimeMillis())
        return true
    }

    private fun notifyListeners(message: String) {
        messageListeners.forEach { listener ->
            try {
                listener(message)
            } catch (e: Exception) {
                Log.e(TAG, "Listener exception during mesh message delivery", e)
            }
        }
    }
}
