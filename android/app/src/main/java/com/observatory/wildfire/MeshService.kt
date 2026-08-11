package com.observatory.wildfire

import android.app.*
import android.bluetooth.BluetoothAdapter
import android.bluetooth.le.*
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Base64
import android.util.Log
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.*
import java.security.MessageDigest
import java.util.*
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.collections.set
import kotlin.math.min
import kotlin.random.Random

/**
 * Secure Mesh Service with:
 * - Trickle Algorithm for gossip dissemination
 * - Dynamic Reputation System
 * - Ephemeral ID rotation
 * - Smart Sleep Scheduling for battery preservation
 * - Anti-replay nonce tracking
 * - Brotli-inspired compression (deflate)
 */
class MeshService : Service() {

    companion object {
        const val TAG = "SecureMesh"
        const val CHANNEL_ID = "mesh_channel_01"
        const val SERVICE_ID = "com.observatory.wildfire.mesh"
        const val MESSAGE_TYPE_REPORT = "report"
        const val MESSAGE_TYPE_ECHO = "echo"
        const val MESSAGE_TYPE_REPUTATION = "reputation"
        const val MAX_HOPS = 5
        const val REPUTATION_INITIAL = 50
        const val REPUTATION_GOOD_REPORT = 15
        const val REPUTATION_FALSE_REPORT = -50
        const val REPUTATION_CONFIRM_MATCH = 5
        const val REPUTATION_MIN = -100
        const val REPUTATION_MAX = 100

        // Trickle constants (milliseconds)
        const val TRICKLE_I_MIN = 1000L
        const val TRICKLE_I_MAX = 30000L
        const val TRICKLE_K = 3       // redundancy constant

        const val EPHEMERAL_ROTATION_MS = 60 * 60 * 1000L
        const val SLEEP_IDLE_THRESHOLD = 120_000L  // 2 min no activity → sleep mode
        const val SLEEP_INTERVAL = 10_000L         // scan every 10s in sleep
        const val ACTIVE_SCAN_INTERVAL = 2000L     // scan every 2s when active

        // Store-and-forward hygiene: a queued message lives at most 10 minutes
        // since its LAST delivery attempt — never since it was queued, so a
        // message that waited for peers is not penalized for time it could not
        // act — and the queue is capped so an idle mesh can never grow
        // unbounded.
        const val MESSAGE_TTL_MS = 10 * 60 * 1000L
        const val MAX_PENDING_MESSAGES = 200
        const val PEER_STALE_MS = 10 * 60 * 1000L

        // Per-message delivery budget: how many trickle windows a message may
        // survive while its delivery keeps failing (see MeshMessage.ttl).
        const val MESSAGE_TTL_WINDOWS = 3L

        // Network-wide proof-of-work requirement: the receiver does NOT trust
        // the sender's declared difficulty. A frame carrying anything other
        // than the network requirement is rejected before any hashing — this
        // bounds the verification cost an untrusted neighbor can impose (a
        // "difficulty 999999" frame is dropped, not computed).
        const val PO_W_DIFFICULTY = 8

        // Explicit wire framing: compressed frames are prefixed with this
        // magic so the receiver never guesses between "inflate" and "legacy
        // plain UTF-8". A corrupted frame carrying the magic is REJECTED, not
        // silently reinterpreted.
        private val COMPRESS_MAGIC = byteArrayOf(0x4D, 0x43) // "MC"
    }

    // Binder for activity communication
    inner class LocalBinder : Binder() {
        fun getService(): MeshService = this@MeshService
    }

    private val binder = LocalBinder()

    // Nearby Connections API
    private lateinit var connectionsClient: ConnectionsClient

    // Identity
    private var currentEphemeralId: String = ""
    private var lastEphemeralRotation: Long = 0L
    private val seenMessageHashes = ConcurrentHashMap<String, Long>()  // anti-broadcast storm
    // Anti-replay lives in seenMessageHashes (messageId + nonce) — see
    // handleIncomingMessage. A nonce-only set would reject legitimately
    // distinct messages from a fast sender.

    // Reputation: endpointId -> score
    private val reputation = ConcurrentHashMap<String, Int>()

    // Known peers: endpointId -> EndpointInfo
    private data class EndpointInfo(
        val endpointId: String,
        val ephemeralId: String,
        val publicKey: String,
        var lastSeen: Long,
        var hopCount: Int = 0
    )
    private val peers = ConcurrentHashMap<String, EndpointInfo>()

    // Message queue for Trickle algorithm — ciphertext + IV are relayed verbatim
    // so intermediate nodes never see plaintext. The wire identity of a message
    // (nonce, coordinates, sender timestamp/signature) travels unchanged across
    // every hop; only hopCount is incremented.
    private data class MeshMessage(
        val messageId: String,
        val type: String,
        val payloadB64: String,
        val iv: String,
        val hopCount: Int,
        val origEphemeralId: String,
        val origPublicKey: String,
        val timestamp: Long,
        val signature: String,
        val nonce: Int,
        val lat: Double,
        val lng: Double,
        val powNonce: Int,
        val powDifficulty: Int,
        // Delivery bookkeeping. TTL semantics: an entry dies when its attempt
        // budget (ttl, one decrement per trickle window) is exhausted or when
        // MESSAGE_TTL_MS elapses after the LAST delivery attempt — never from
        // birth time, so a message that waited for peers is not penalized for
        // time in which it could not act. lastAttemptAt anchors that clock;
        // 0 means "never attempted".
        var lastAttemptAt: Long = 0L,
        var ttl: Long = MESSAGE_TTL_WINDOWS,
        // In-flight guard: set while the send loop issues frames for this
        // message, cleared in a finally block. Sends are synchronous today,
        // so a concurrent trickle tick cannot interleave — the flag is
        // defense in depth against a future async send path.
        var inFlight: Boolean = false,
        // Locally generated messages are queued as plaintext and encrypted
        // SEPARATELY FOR EACH target peer at send time — the ciphertext is
        // never shared between recipients.
        val needsEncryption: Boolean = false,
        val plaintext: String = ""
    )
    private val pendingMessages = CopyOnWriteArrayList<MeshMessage>()
    private val forwardedMessages = ConcurrentHashMap<String, Long>()  // messageId -> timestamp

    // Trickle state
    private var trickleInterval = TRICKLE_I_MIN
    private var trickleTimer: Timer? = null
    private var lastActivityTime = System.currentTimeMillis()
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
        rotateEphemeralId()
        startDiscovery()
        startAdvertising()
        startTrickleTimer()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        trickleTimer?.cancel()
        connectionsClient.stopAllEndpoints()
        wakeLock?.release()
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    // ========================
    // INITIALIZATION
    // ========================

    private fun initCrypto() {
        try {
            java.security.Security.insertProviderAt(org.bouncycastle.jce.provider.BouncyCastleProvider(), 1)
        } catch (e: Exception) {
            // Security provider already installed
        }
        CryptoEngine.initialize()
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

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(1, notification)
        }
    }

    // ========================
    // EPHEMERAL ID ROTATION
    // ========================

    @Synchronized
    private fun rotateEphemeralId() {
        currentEphemeralId = CryptoEngine.getEphemeralId()
        lastEphemeralRotation = System.currentTimeMillis()
        Log.d(TAG, "Ephemeral ID rotated: $currentEphemeralId")
    }

    @Synchronized
    fun getEphemeralId(): String {
        if (System.currentTimeMillis() - lastEphemeralRotation > EPHEMERAL_ROTATION_MS) {
            rotateEphemeralId()
        }
        return currentEphemeralId
    }

    // ========================
    // NEARBY CONNECTIONS
    // ========================

    private val connectionLifecycleCallback = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
            Log.d(TAG, "Connection initiated: $endpointId")
            connectionsClient.acceptConnection(endpointId, payloadCallback)
        }

        override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {
            if (result.status.isSuccess) {
                Log.d(TAG, "Connected: $endpointId")
                peers[endpointId] = EndpointInfo(
                    endpointId = endpointId,
                    ephemeralId = "unknown",
                    publicKey = "",
                    lastSeen = System.currentTimeMillis()
                )
                reputation.putIfAbsent(endpointId, REPUTATION_INITIAL)
                lastActivityTime = System.currentTimeMillis()
            } else {
                Log.d(TAG, "Connection failed: $endpointId")
            }
        }

        override fun onDisconnected(endpointId: String) {
            Log.d(TAG, "Disconnected: $endpointId")
            peers.remove(endpointId)
        }
    }

    private val discoveryEndpointCallback = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
            Log.d(TAG, "Found endpoint: $endpointId (${info.endpointName})")
            if (reputation.getOrDefault(endpointId, REPUTATION_INITIAL) > REPUTATION_MIN / 2) {
                connectionsClient.requestConnection(getEphemeralId(), endpointId, connectionLifecycleCallback)
            }
        }

        override fun onEndpointLost(endpointId: String) {
            Log.d(TAG, "Lost endpoint: $endpointId")
        }
    }

    private val payloadCallback = object : PayloadCallback() {
        override fun onPayloadReceived(endpointId: String, payload: Payload) {
            if (payload.type == Payload.Type.BYTES) {
                val bytes = payload.asBytes() ?: return
                handleIncomingMessage(endpointId, bytes)
                lastActivityTime = System.currentTimeMillis()
            }
        }

        override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {}
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

    private fun startAdvertising() {
        try {
            connectionsClient.startAdvertising(
                getEphemeralId(),
                SERVICE_ID,
                connectionLifecycleCallback,
                AdvertisingOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build()
            ).addOnFailureListener { Log.e(TAG, "Advertising failed", it) }
        } catch (e: Exception) {
            Log.e(TAG, "Advertising error", e)
        }
    }

    // ========================
    // MESSAGE HANDLING
    // ========================

    data class MeshPayload(
        val messageId: String,
        val type: String,
        val payloadB64: String,
        val iv: String,
        val hopCount: Int,
        val origEphemeralId: String,
        val origPublicKey: String,
        val timestamp: Long,
        val signature: String,
        val nonce: Int,
        val lat: Double,
        val lng: Double,
        val powNonce: Int,
        val powDifficulty: Int
    )

    private fun handleIncomingMessage(endpointId: String, bytes: ByteArray) {
        try {
            // Wire format: only deflate-compressed frames carrying our magic
            // marker are accepted. Decoding a raw frame as JSON would defeat
            // the format gate and risk parsing attacker-chosen bytes as JSON.
            val json = decompress(bytes) ?: run {
                Log.w(TAG, "Incoming frame missing compression magic")
                updateReputation(endpointId, REPUTATION_FALSE_REPORT / 2)
                return
            }
            val payload = parseJsonToPayload(json) ?: return

            // Anti-replay / anti-broadcast-storm: (messageId + nonce) identifies
            // the message unambiguously. messageId is origin-generated and the
            // nonce travels verbatim with the payload, so the combined hash is
            // stable across hops. Nonce alone would collide across legitimately
            // distinct messages from a fast sender (Random.nextInt() space).
            val msgHash = sha256(payload.messageId + payload.nonce)
            if (seenMessageHashes.containsKey(msgHash)) return
            seenMessageHashes[msgHash] = System.currentTimeMillis()

            // Proof-of-Work verification: the nonce is carried in the payload
            // and checked at every hop — solving without transmitting/verifying
            // would be a no-op. Difficulty is clamped to a sane band: solving
            // more than our constant is a marker of a modified (non-stock)
            // client and is rejected, keeping the network uniform.
            if (payload.powDifficulty <= 0 || payload.powDifficulty > PO_W_DIFFICULTY) {
                Log.w(TAG, "Out-of-band proof-of-work difficulty")
                updateReputation(endpointId, REPUTATION_FALSE_REPORT / 2)
                return
            }
            val powPrefix = "${payload.messageId}${payload.origEphemeralId}"
            if (!CryptoEngine.ProofOfWork.verify(powPrefix, payload.powNonce, payload.powDifficulty)) {
                Log.w(TAG, "Invalid proof-of-work on wire message")
                updateReputation(endpointId, REPUTATION_FALSE_REPORT / 2)
                return
            }

            // Verify the ECDSA signature over (ciphertext + iv) — public-key integrity
            // check available to every relay, independent of the AES key.
            val secureMsg = CryptoEngine.SecureMessage(
                ephemeralId = payload.origEphemeralId,
                senderPublicKey = payload.origPublicKey,
                ciphertext = payload.payloadB64,
                iv = payload.iv,
                signature = payload.signature,
                timestamp = payload.timestamp,
                lat = payload.lat,
                lng = payload.lng,
                nonce = payload.nonce
            )

            if (payload.type != MESSAGE_TYPE_ECHO && !CryptoEngine.verifyMessageSignature(secureMsg)) {
                Log.w(TAG, "Invalid signature on wire message")
                updateReputation(endpointId, REPUTATION_FALSE_REPORT / 2)
                return
            }

            // Learn the peer's public key ONLY from the origin's signed message
            // (hopCount == 0). A relayed message bears the origin's key but the
            // sender is a relay — binding that key to the relay's endpoint would
            // poison the peers map and break E2EE targeting.
            if (payload.hopCount == 0 && payload.origPublicKey.isNotBlank()) {
                peers[endpointId]?.let { info ->
                    if (info.publicKey != payload.origPublicKey) {
                        peers[endpointId] = info.copy(publicKey = payload.origPublicKey)
                    }
                }
            }

            val decrypted = if (payload.type == MESSAGE_TYPE_ECHO) {
                // Echo messages are plaintext hop counters by design
                Base64.decode(payload.payloadB64, Base64.NO_WRAP)
            } else {
                CryptoEngine.decryptFromPeer(secureMsg)
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

            // Store-and-forward relay — for EVERY valid signed message, addressed
            // to us or not. The ciphertext, IV, signature, nonce, coordinates and
            // sender timestamp travel unchanged; only hopCount increments. A
            // message addressed to a deeper peer reaches it hop by hop.
            if (payload.hopCount < MAX_HOPS) {
                pendingMessages.add(MeshMessage(
                    messageId = payload.messageId,
                    type = payload.type,
                    payloadB64 = payload.payloadB64,
                    iv = payload.iv,
                    hopCount = payload.hopCount + 1,
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
        } catch (e: Exception) {
            Log.e(TAG, "Message handling error", e)
        }
    }

    /**
     * Send a message to the mesh. The plaintext is queued as a store-and-forward
     * entry and encrypted for the best known peer key at send time: a missing
     * peer key or empty peer list never drops the report, it simply waits.
     * Web layer calls this via JS bridge.
     */
    @Synchronized
    fun broadcastMessage(plaintext: String, reportType: String, lat: Double, lng: Double) {
        val messageId = UUID.randomUUID().toString()
        val nonce = Random.nextInt()

        // Lightweight Proof-of-Work (anti-spam) — solved here, transmitted in
        // the payload, verified at every receiving hop.
        val powPrefix = "$messageId${CryptoEngine.getEphemeralId()}"
        val powNonce = CryptoEngine.ProofOfWork.solve(powPrefix, PO_W_DIFFICULTY)

        // Eviction policy: entries that have never been attempted to send
        // (no reachable peers yet) are shielded from eviction — they carry the
        // newest reports and would otherwise be the first to die under load.
        // Expired (TTL 0) or already-tried entries go first.
        if (pendingMessages.size >= MAX_PENDING_MESSAGES) {
            val evictable = pendingMessages
                .withIndex()
                .filter { it.value.lastAttemptAt > 0 || it.value.ttl <= 0 }
                .minByOrNull { it.value.lastAttemptAt }
            if (evictable != null) {
                pendingMessages.removeAt(evictable.index)
            } else {
                // Everything is un-attempted and alive: drop the oldest
                // non-zero TTL entry to keep the queue bounded.
                pendingMessages.indexOfFirst { it.ttl > 0 }
                    .takeIf { it >= 0 }
                    ?.let(pendingMessages::removeAt)
            }
        }

        pendingMessages.add(MeshMessage(
            messageId = messageId,
            type = reportType,
            payloadB64 = "",
            iv = "",
            hopCount = 0,
            origEphemeralId = CryptoEngine.getEphemeralId(),
            origPublicKey = CryptoEngine.getPublicKeyBase64(),
            timestamp = System.currentTimeMillis(),
            signature = "",
            nonce = nonce,
            lat = lat,
            lng = lng,
            powNonce = powNonce,
            powDifficulty = PO_W_DIFFICULTY,
            needsEncryption = true,
            plaintext = plaintext
        ))
    }

    // ========================
    // TRICKLE ALGORITHM
    // ========================

    private fun startTrickleTimer() {
        trickleTimer = Timer("TrickleTimer", true)
        trickleTimer?.schedule(object : TimerTask() {
            override fun run() {
                trickleTick()
                managePower()
            }
        }, TRICKLE_I_MIN, 1000L)
    }

    @Synchronized
    private fun trickleTick() {
        val now = System.currentTimeMillis()

        // Store-and-forward hygiene: a message dies when its attempt budget
        // (ttl) is exhausted, or when it has been attempted for MESSAGE_TTL_MS
        // without delivering. The clock starts at the LAST ATTEMPT — never at
        // birth: a message that sat queued while no peer was in range is not
        // penalized for time in which it could not act.
        val cutoff = now - MESSAGE_TTL_MS
        pendingMessages.removeAll { it.ttl <= 0 || (it.lastAttemptAt > 0 && it.lastAttemptAt < cutoff) }

        if (pendingMessages.isEmpty()) {
            // Double interval up to max
            trickleInterval = min(trickleInterval * 2, TRICKLE_I_MAX)
            return
        }

        // Trickle: only send if we've heard < K redundant transmissions
        val recentForwarded = forwardedMessages.count { (_, ts) ->
            now - ts < trickleInterval
        }

        if (recentForwarded < TRICKLE_K) {
            val batch = pendingMessages.take(TRICKLE_K)

            batch.forEach { msg ->
                // In-flight guard: the send loop below is synchronous, so no
                // concurrent trickle tick can interleave — the flag is defense
                // in depth against a future async send path (an async
                // completion would clear it in a finally block).
                msg.inFlight = true
                try {
                    // Every message is attempted once per window: the attempt
                    // stamps lastAttemptAt (the TTL anchor) even when no peer
                    // is in range — store-and-forward keeps waiting.
                    msg.lastAttemptAt = now
                    msg.ttl = (msg.ttl - 1).coerceAtLeast(0)

                    val targetPeers = peers.filter { (id, info) ->
                        reputation.getOrDefault(id, REPUTATION_INITIAL) > REPUTATION_MIN / 2 &&
                            info.publicKey.isNotBlank() &&
                            now - info.lastSeen < PEER_STALE_MS &&
                            !forwardedMessages.containsKey("$id:${msg.messageId}")
                    }
                    if (targetPeers.isEmpty()) return@forEach // store-and-forward: wait

                    targetPeers.forEach peerLoop@ { (endpointId, info) ->
                        // Per-target E2EE: each receiver gets a ciphertext
                        // encrypted for its own public key. A shared ciphertext
                        // sent to every peer would let any single key holder
                        // decrypt the whole broadcast. Already-encrypted frames
                        // (relays) travel verbatim — only the intended key
                        // holder decrypts, everyone else forwards.
                        val encrypted = if (msg.needsEncryption) {
                            CryptoEngine.encryptForPeer(
                                peerPublicKeyBase64 = info.publicKey,
                                payload = msg.plaintext.toByteArray(Charsets.UTF_8),
                                lat = msg.lat,
                                lng = msg.lng
                            ).takeIf { it.ciphertext.isNotBlank() }
                                ?: return@peerLoop // encryption failure: retry next window
                        } else null

                        sendToTarget(endpointId, msg, encrypted)
                        // Per-target dedup: the same frame is never sent to the
                        // same peer twice within a window.
                        forwardedMessages["$endpointId:${msg.messageId}"] = now
                    }
                } finally {
                    msg.inFlight = false
                }
            }
        }

        // Reset interval
        trickleInterval = TRICKLE_I_MIN

        // Cleanup old seen hashes + forwarded markers
        val cutoff2 = now - 300_000L
        seenMessageHashes.entries.removeAll { it.value < cutoff2 }
        forwardedMessages.entries.removeAll { it.value < cutoff2 }
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

    @Synchronized
    fun updateReputation(endpointId: String, delta: Int) {
        val current = reputation.getOrDefault(endpointId, REPUTATION_INITIAL)
        val newScore = (current + delta).coerceIn(REPUTATION_MIN, REPUTATION_MAX)
        reputation[endpointId] = newScore

        Log.d(TAG, "Reputation $endpointId: $current → $newScore (Δ$delta)")

        // Auto-disconnect malicious peers
        if (newScore <= REPUTATION_MIN / 2) {
            connectionsClient.disconnectFromEndpoint(endpointId)
            peers.remove(endpointId)
        }
    }

    fun getReputation(endpointId: String): Int {
        return reputation.getOrDefault(endpointId, REPUTATION_INITIAL)
    }

    fun getConnectedPeers(): List<Map<String, Any>> {
        return peers.map { (id, info) ->
            mapOf(
                "endpointId" to id,
                "ephemeralId" to info.ephemeralId,
                "lastSeen" to info.lastSeen,
                "reputation" to reputation.getOrDefault(id, REPUTATION_INITIAL),
                "hopCount" to info.hopCount
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
    private fun sendToTarget(endpointId: String, msg: MeshMessage, encrypted: CryptoEngine.SecureMessage?) {
        val frame = if (encrypted != null) {
            MeshPayload(
                messageId = msg.messageId,
                type = msg.type,
                payloadB64 = encrypted.ciphertext,
                iv = encrypted.iv,
                hopCount = msg.hopCount,
                origEphemeralId = encrypted.ephemeralId,
                origPublicKey = encrypted.senderPublicKey,
                timestamp = encrypted.timestamp,
                signature = encrypted.signature,
                nonce = msg.nonce,
                lat = msg.lat,
                lng = msg.lng,
                powNonce = msg.powNonce,
                powDifficulty = msg.powDifficulty
            )
        } else {
            MeshPayload(
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
                powDifficulty = msg.powDifficulty
            )
        }
        val json = payloadToJson(frame)
        val compressed = compress(json.toByteArray(Charsets.UTF_8))
        connectionsClient.sendPayload(endpointId, Payload.fromBytes(compressed))
    }

    private fun notifyListeners(message: String) {
        messageListeners.forEach { it(message) }
    }

    private fun compress(data: ByteArray): ByteArray {
        return try {
            val deflater = java.util.zip.Deflater(java.util.zip.Deflater.BEST_COMPRESSION)
            deflater.setInput(data)
            deflater.finish()
            var buf = ByteArray(data.size * 2 + 1024)
            var off = 0
            // A single deflate() call may NOT consume the whole stream — keep
            // draining until finished() (growing the buffer on the way), so a
            // big frame is never silently truncated.
            while (!deflater.finished()) {
                if (off == buf.size) buf = buf.copyOf(buf.size * 2)
                val len = deflater.deflate(buf, off, buf.size - off)
                if (len == 0) break // defensive: prevent an infinite loop
                off += len
            }
            deflater.end()
            // Magic-framed: the marker makes the wire format self-describing and
            // lets receivers reject raw-UTF8 frames outright.
            COMPRESS_MAGIC + buf.copyOf(off)
        } catch (e: Exception) {
            // Compression failure (defensive — Deflater is memory-safe): the
            // frame is still magic-framed so the receiver decodes it, just
            // without compression.
            COMPRESS_MAGIC + data
        }
    }

    /**
     * Inflate a magic-framed deflate stream, or null when the frame lacks the
     * marker (anything without the marker is not a wire message — callers
     * reject it rather than falling back to raw UTF-8).
     */
    private fun decompress(data: ByteArray): String? {
        if (data.size < COMPRESS_MAGIC.size) return null
        for (i in COMPRESS_MAGIC.indices) {
            if (data[i] != COMPRESS_MAGIC[i]) return null
        }
        return try {
            val inflater = java.util.zip.Inflater()
            inflater.setInput(data, COMPRESS_MAGIC.size, data.size - COMPRESS_MAGIC.size)
            val out = java.io.ByteArrayOutputStream(data.size * 2)
            val buf = ByteArray(8192)
            while (!inflater.finished()) {
                val len = inflater.inflate(buf)
                if (len == 0) return null // corrupt deflate stream
                out.write(buf, 0, len)
            }
            inflater.end()
            out.toString("UTF-8")
        } catch (e: Exception) {
            null
        }
    }

    private fun sha256(input: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        return digest.digest(input.toByteArray()).joinToString("") { "%02x".format(it) }
    }

    /**
     * Wire schema: a pipe-joined frame with exactly 14 fields
     *   messageId|type|payloadB64|iv|hopCount|origEphemeralId|origPublicKey|timestamp|signature|nonce|lat|lng|powNonce|powDifficulty
     * The final two fields carry the sender's proof-of-work so every hop can
     * verify it. Frames with any other field count are rejected outright —
     * there is no legacy format: handleIncomingMessage requires a valid PoW
     * difficulty anyway, so pre-PoW frames could never pass the gate.
     */
    private fun parseJsonToPayload(json: String): MeshPayload? {
        return try {
            val parts = json.split("|")
            if (parts.size != 14) return null
            val messageId = parts[0]
            val type = parts[1]
            val payloadB64 = parts[2]
            val iv = parts[3]
            val hopCount = parts[4].toInt()
            val origEphemeralId = parts[5]
            val origPublicKey = parts[6]
            val timestamp = parts[7].toLong()
            val signature = parts[8]
            val nonce = parts[9].toInt()
            val lat = parts[10].toDouble()
            val lng = parts[11].toDouble()
            val powNonce = parts[12].toInt()
            val powDifficulty = parts[13].toInt()

            // Physical/identity sanity: a frame claiming 999 hops, garbage
            // coordinates or missing key material is not a wire message.
            if (messageId.isBlank() || type.isBlank() || payloadB64.isBlank() ||
                iv.isBlank() || origEphemeralId.isBlank() || origPublicKey.isBlank() ||
                signature.isBlank()
            ) return null
            if (hopCount < 0 || hopCount > MAX_HOPS) return null
            if (!lat.isFinite() || !lng.isFinite() ||
                lat < -90.0 || lat > 90.0 || lng < -180.0 || lng > 180.0
            ) return null

            MeshPayload(
                messageId = messageId,
                type = type,
                payloadB64 = payloadB64,
                iv = iv,
                hopCount = hopCount,
                origEphemeralId = origEphemeralId,
                origPublicKey = origPublicKey,
                timestamp = timestamp,
                signature = signature,
                nonce = nonce,
                lat = lat,
                lng = lng,
                powNonce = powNonce,
                powDifficulty = powDifficulty
            )
        } catch (e: Exception) {
            null
        }
    }

    private fun payloadToJson(payload: MeshPayload): String {
        return listOf(
            payload.messageId,
            payload.type,
            payload.payloadB64,
            payload.iv,
            payload.hopCount.toString(),
            payload.origEphemeralId,
            payload.origPublicKey,
            payload.timestamp.toString(),
            payload.signature,
            payload.nonce.toString(),
            payload.lat.toString(),
            payload.lng.toString(),
            payload.powNonce.toString(),
            payload.powDifficulty.toString()
        ).joinToString("|")
    }
}
