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
        // and the queue is capped so an idle mesh can never grow unbounded.
        const val MESSAGE_TTL_MS = 10 * 60 * 1000L
        const val MAX_PENDING_MESSAGES = 200
        const val PEER_STALE_MS = 10 * 60 * 1000L
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
    private val seenNonces = ConcurrentHashMap<Int, Long>()  // anti-replay

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
    // every hop; only hopCount is incremented. Entries that could not be
    // delivered (no peer / no public key) stay queued until MESSAGE_TTL_MS.
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
        val queuedAt: Long = System.currentTimeMillis(),
        // Locally generated messages are queued as plaintext and encrypted for
        // the best peer key at send time — if no peer key exists yet the
        // message waits, it is never dropped.
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
            java.security.Security.insertProviderAt(org.spongycastle.jce.provider.BouncyCastleProvider(), 1)
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
            connectionsClient.acceptConnection(endpointId)
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
            // Both wire formats are accepted: deflate-compressed frames produced
            // by this build, and legacy uncompressed frames from older builds.
            val json = decompress(bytes) ?: String(bytes, Charsets.UTF_8)
            val payload = parseJsonToPayload(json) ?: return

            // Anti-replay: reject duplicate nonces (nonce is a stable part of
            // the message identity — it is relayed verbatim, never re-randomized).
            if (seenNonces.containsKey(payload.nonce)) return
            seenNonces[payload.nonce] = System.currentTimeMillis()

            // Anti-broadcast storm: deduplicate by messageId
            val msgHash = sha256(payload.messageId + payload.nonce)
            if (seenMessageHashes.containsKey(msgHash)) return
            seenMessageHashes[msgHash] = System.currentTimeMillis()

            // Proof-of-Work verification: the nonce is carried in the payload
            // and checked at every hop — solving without transmitting/verifying
            // would be a no-op.
            if (payload.powDifficulty > 0) {
                val powPrefix = "${payload.messageId}${payload.origEphemeralId}"
                if (!CryptoEngine.ProofOfWork.verify(powPrefix, payload.powNonce, payload.powDifficulty)) {
                    Log.w(TAG, "Invalid proof-of-work on wire message")
                    updateReputation(endpointId, REPUTATION_FALSE_REPORT / 2)
                    return
                }
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

            // Learn the peer's public key from a signed message: without this
            // the peers map never holds real keys and broadcast E2EE falls
            // back to self-encryption (getBestPeerPublicKey returns "").
            peers[endpointId]?.let { info ->
                if (info.publicKey.isBlank() && payload.origPublicKey.isNotBlank()) {
                    peers[endpointId] = info.copy(publicKey = payload.origPublicKey)
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
    fun broadcastMessage(plaintext: String, reportType: String, lat: Double, lng: Double) {
        val messageId = UUID.randomUUID().toString()
        val nonce = Random.nextInt()

        // Lightweight Proof-of-Work (anti-spam) — solved here, transmitted in
        // the payload, verified at every receiving hop.
        val powPrefix = "$messageId${CryptoEngine.getEphemeralId()}"
        val powNonce = CryptoEngine.ProofOfWork.solve(powPrefix, 8)

        // Cap the queue: drop the oldest entries, never unbounded growth.
        while (pendingMessages.size >= MAX_PENDING_MESSAGES) {
            pendingMessages.removeAt(0)
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
            powDifficulty = 8,
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

        // Store-and-forward hygiene: drop entries older than the TTL. Nothing is
        // ever dropped for merely having "no peer right now" — those entries
        // stay queued and waiting for the next tick.
        val cutoff = now - MESSAGE_TTL_MS
        pendingMessages.removeAll { it.queuedAt < cutoff }

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
            val delivered = mutableListOf<MeshMessage>()

            batch.forEach { msg ->
                // in-flight messages are excluded; a message stays queued until
                // a send was actually issued for it (delivered list below).
                val trackId = if (msg.needsEncryption) "plain:${msg.messageId}" else msg.messageId
                if (forwardedMessages.containsKey(trackId)) return@forEach

                // Locally generated messages are still plaintext: encrypt for the
                // best peer key NOW. An empty/stale key list keeps the message
                // queued — it is never dropped and never self-encrypted.
                if (msg.needsEncryption) {
                    val bestKey = getBestPeerPublicKey()
                    if (bestKey.isBlank()) return@forEach

                    val encrypted = CryptoEngine.encryptForPeer(
                        peerPublicKeyBase64 = bestKey,
                        payload = msg.plaintext.toByteArray(Charsets.UTF_8),
                        lat = msg.lat,
                        lng = msg.lng
                    )
                    // encryption failure surface: stay queued
                    if (encrypted.ciphertext.isBlank()) return@forEach
                    pendingMessages[pendingMessages.indexOf(msg)] = msg.copy(
                        needsEncryption = false,
                        plaintext = "",
                        payloadB64 = encrypted.ciphertext,
                        iv = encrypted.iv,
                        origEphemeralId = encrypted.ephemeralId,
                        origPublicKey = encrypted.senderPublicKey,
                        timestamp = encrypted.timestamp,
                        signature = encrypted.signature
                    )
                }

                val ready = pendingMessages.firstOrNull { it.messageId == msg.messageId && !it.needsEncryption } ?: return@forEach

                val targetPeers = peers.filter { (id, _) ->
                    reputation.getOrDefault(id, REPUTATION_INITIAL) > REPUTATION_MIN / 2
                }
                if (targetPeers.isEmpty()) return@forEach // store-and-forward: wait

                // Ciphertext + IV + full identity metadata relayed verbatim —
                // nonce, coordinates, sender timestamp and signature never
                // change between hops: anti-replay and storm dedup hold
                // chain-wide, not per-hop.
                val relayPayload = MeshPayload(
                    messageId = ready.messageId,
                    type = ready.type,
                    payloadB64 = ready.payloadB64,
                    iv = ready.iv,
                    hopCount = ready.hopCount,
                    origEphemeralId = ready.origEphemeralId,
                    origPublicKey = ready.origPublicKey,
                    timestamp = ready.timestamp,
                    signature = ready.signature,
                    nonce = ready.nonce,
                    lat = ready.lat,
                    lng = ready.lng,
                    powNonce = ready.powNonce,
                    powDifficulty = ready.powDifficulty
                )

                val json = payloadToJson(relayPayload)
                val compressed = compress(json.toByteArray(Charsets.UTF_8))

                targetPeers.keys.forEach { endpointId ->
                    connectionsClient.sendPayload(endpointId, Payload.fromBytes(compressed))
                }

                // Removed from the queue ONLY after a send was actually issued.
                forwardedMessages[trackId] = now
                delivered.add(ready)
            }

            pendingMessages.removeAll(delivered)
        }

        // Reset interval
        trickleInterval = TRICKLE_I_MIN

        // Cleanup old seen hashes + forwarded markers
        val cutoff = now - 300_000L
        seenMessageHashes.entries.removeAll { it.value < cutoff }
        forwardedMessages.entries.removeAll { it.value < cutoff }
        seenNonces.entries.removeAll { it.value < cutoff }
        forwardedMessages.entries.removeAll { it.value < cutoff }
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

    private fun getBestPeerPublicKey(): String {
        val now = System.currentTimeMillis()
        // Best key = highest-reputation peer whose key we actually hold and
        // who was seen recently. Blank or stale keys are skipped outright.
        // There is deliberately NO self-encrypt fallback: encrypting for
        // ourselves would produce a ciphertext no peer can read and silently
        // fake the broadcast — the queue keeps the message instead.
        return peers.entries
            .asSequence()
            .filter { reputation.getOrDefault(it.key, 0) > 0 }
            .filter { it.value.publicKey.isNotBlank() }
            .filter { now - it.value.lastSeen < PEER_STALE_MS }
            .maxByOrNull { reputation.getOrDefault(it.key, 0) }
            ?.value?.publicKey
            .orEmpty()
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
            buf.copyOf(off)
        } catch (e: Exception) {
            data
        }
    }

    /**
     * Inflate a deflate stream, or null when the bytes are not deflate (the
     * legacy uncompressed wire format falls back to raw UTF-8 decoding).
     */
    private fun decompress(data: ByteArray): String? {
        return try {
            val inflater = java.util.zip.Inflater()
            inflater.setInput(data)
            val out = java.io.ByteArrayOutputStream(data.size * 2)
            val buf = ByteArray(8192)
            while (!inflater.finished()) {
                val len = inflater.inflate(buf)
                if (len == 0) return null // not a deflate stream (or corrupt)
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
     * Wire schema: a pipe-joined frame with 14 fields
     *   messageId|type|payloadB64|iv|hopCount|origEphemeralId|origPublicKey|timestamp|signature|nonce|lat|lng|powNonce|powDifficulty
     * The final two fields carry the sender's proof-of-work so every hop can
     * verify it. Legacy 12-field frames (pre-PoW builds) are still accepted —
     * they carry powDifficulty = 0, which skips the PoW check.
     */
    private fun parseJsonToPayload(json: String): MeshPayload? {
        return try {
            val parts = json.split("|")
            val legacy = parts.size == 12
            if (!legacy && parts.size != 14) return null
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
                powNonce = if (legacy) 0 else parts[12].toInt(),
                powDifficulty = if (legacy) 0 else parts[13].toInt()
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
