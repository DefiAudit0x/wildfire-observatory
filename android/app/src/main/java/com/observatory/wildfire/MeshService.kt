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

    // Message queue for Trickle algorithm
    private data class MeshMessage(
        val messageId: String,
        val type: String,
        val payload: ByteArray,
        val hopCount: Int,
        val origEphemeralId: String,
        val origPublicKey: String,
        val timestamp: Long,
        val signature: String
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
        val hopCount: Int,
        val origEphemeralId: String,
        val origPublicKey: String,
        val timestamp: Long,
        val signature: String,
        val nonce: Int,
        val lat: Double,
        val lng: Double
    )

    private fun handleIncomingMessage(endpointId: String, bytes: ByteArray) {
        try {
            val json = String(bytes, Charsets.UTF_8)
            val payload = parseJsonToPayload(json) ?: return

            // Anti-replay: reject duplicate nonces
            if (seenNonces.containsKey(payload.nonce)) return
            seenNonces[payload.nonce] = System.currentTimeMillis()

            // Anti-broadcast storm: deduplicate by messageId
            val msgHash = sha256(payload.messageId + payload.nonce)
            if (seenMessageHashes.containsKey(msgHash)) return
            seenMessageHashes[msgHash] = System.currentTimeMillis()

            // Verify ECDSA signature
            val secureMsg = CryptoEngine.SecureMessage(
                ephemeralId = payload.origEphemeralId,
                senderPublicKey = payload.origPublicKey,
                ciphertext = payload.payloadB64,
                iv = "",
                signature = payload.signature,
                timestamp = payload.timestamp,
                lat = payload.lat,
                lng = payload.lng,
                nonce = payload.nonce
            )

            val decrypted = if (payload.type == MESSAGE_TYPE_ECHO) {
                // Echo messages don't need E2EE decryption at relay
                Base64.decode(payload.payloadB64, Base64.NO_WRAP)
            } else {
                CryptoEngine.decryptFromPeer(secureMsg)
            }

            if (decrypted != null) {
                // Notify web layer
                val plaintext = String(decrypted, Charsets.UTF_8)
                notifyListeners(plaintext)

                // Relay via Trickle algorithm if hop count permits
                if (payload.hopCount < MAX_HOPS) {
                    val relayMsg = MeshMessage(
                        messageId = payload.messageId,
                        type = payload.type,
                        payload = decrypted,
                        hopCount = payload.hopCount + 1,
                        origEphemeralId = payload.origEphemeralId,
                        origPublicKey = payload.origPublicKey,
                        timestamp = System.currentTimeMillis(),
                        signature = payload.signature
                    )
                    pendingMessages.add(relayMsg)
                }

                // Update reputation
                updateReputation(endpointId, REPUTATION_CONFIRM_MATCH)
            } else {
                // Failed decryption → bad actor
                updateReputation(endpointId, REPUTATION_FALSE_REPORT / 2)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Message handling error", e)
        }
    }

    /**
     * Send an encrypted message to all connected peers.
     * Web layer calls this via JS bridge.
     */
    fun broadcastMessage(plaintext: String, reportType: String, lat: Double, lng: Double) {
        val messageId = UUID.randomUUID().toString()
        val nonce = Random.nextInt()

        // Lightweight Proof-of-Work (anti-spam)
        val powPrefix = "$messageId${CryptoEngine.getEphemeralId()}"
        val powNonce = CryptoEngine.ProofOfWork.solve(powPrefix, 8)

        val encrypted = CryptoEngine.encryptForPeer(
            peerPublicKeyBase64 = getBestPeerPublicKey(),
            payload = plaintext.toByteArray(Charsets.UTF_8),
            lat = lat,
            lng = lng
        )

        val payload = MeshPayload(
            messageId = messageId,
            type = reportType,
            payloadB64 = encrypted.ciphertext,
            hopCount = 0,
            origEphemeralId = encrypted.ephemeralId,
            origPublicKey = encrypted.senderPublicKey,
            timestamp = encrypted.timestamp,
            signature = encrypted.signature,
            nonce = nonce,
            lat = lat,
            lng = lng
        )

        val json = payloadToJson(payload)
        val compressed = compress(json.toByteArray(Charsets.UTF_8))

        // Gossip to all connected peers, filtering by reputation
        val highRepPeers = peers.filter { (id, _) ->
            reputation.getOrDefault(id, REPUTATION_INITIAL) > 0
        }

        highRepPeers.keys.forEach { endpointId ->
            connectionsClient.sendPayload(endpointId, Payload.fromBytes(compressed))
        }

        // Also queue for Trickle relay
        pendingMessages.add(MeshMessage(
            messageId = messageId,
            type = reportType,
            payload = plaintext.toByteArray(Charsets.UTF_8),
            hopCount = 0,
            origEphemeralId = encrypted.ephemeralId,
            origPublicKey = encrypted.senderPublicKey,
            timestamp = encrypted.timestamp,
            signature = encrypted.signature
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
        if (pendingMessages.isEmpty()) {
            // Double interval up to max
            trickleInterval = min(trickleInterval * 2, TRICKLE_I_MAX)
            return
        }

        // Trickle: only send if we've heard < K redundant transmissions
        val recentForwarded = forwardedMessages.count { (_, ts) ->
            System.currentTimeMillis() - ts < trickleInterval
        }

        if (recentForwarded < TRICKLE_K) {
            // Take a batch of pending messages
            val batch = pendingMessages.take(TRICKLE_K)
            pendingMessages.removeAll(batch)

            batch.forEach { msg ->
                val messageId = msg.messageId
                if (!forwardedMessages.containsKey(messageId)) {
                    forwardedMessages[messageId] = System.currentTimeMillis()

                    val targetPeers = peers.filter { (id, _) ->
                        reputation.getOrDefault(id, REPUTATION_INITIAL) > REPUTATION_MIN / 2
                    }

                    // Spatio-temporal stamped relay
                    val relayPayload = MeshPayload(
                        messageId = messageId,
                        type = msg.type,
                        payloadB64 = Base64.encodeToString(msg.payload, Base64.NO_WRAP),
                        hopCount = msg.hopCount,
                        origEphemeralId = msg.origEphemeralId,
                        origPublicKey = msg.origPublicKey,
                        timestamp = System.currentTimeMillis(),
                        signature = msg.signature,
                        nonce = Random.nextInt(),
                        lat = 0.0,
                        lng = 0.0
                    )

                    val json = payloadToJson(relayPayload)
                    val compressed = compress(json.toByteArray(Charsets.UTF_8))

                    targetPeers.keys.forEach { endpointId ->
                        connectionsClient.sendPayload(endpointId, Payload.fromBytes(compressed))
                    }
                }
            }
        }

        // Reset interval
        trickleInterval = TRICKLE_I_MIN

        // Cleanup old seen hashes
        val cutoff = System.currentTimeMillis() - 300_000L
        seenMessageHashes.entries.removeAll { it.value < cutoff }
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
        // Use highest-reputation peer's public key for E2EE
        return peers.entries
            .filter { reputation.getOrDefault(it.key, 0) > 0 }
            .maxByOrNull { reputation.getOrDefault(it.key, 0) }
            ?.value?.publicKey
            ?: CryptoEngine.getPublicKeyBase64()  // fallback: self-encrypt
    }

    private fun notifyListeners(message: String) {
        messageListeners.forEach { it(message) }
    }

    private fun compress(data: ByteArray): ByteArray {
        try {
            val deflater = java.util.zip.Deflater(java.util.zip.Deflater.BEST_COMPRESSION)
            deflater.setInput(data)
            deflater.finish()
            val buf = ByteArray(data.size * 2 + 1024)
            val len = deflater.deflate(buf)
            deflater.end()
            return buf.copyOf(len)
        } catch (e: Exception) {
            return data
        }
    }

    private fun sha256(input: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        return digest.digest(input.toByteArray()).joinToString("") { "%02x".format(it) }
    }

    private fun parseJsonToPayload(json: String): MeshPayload? {
        return try {
            val parts = json.split("|")
            if (parts.size < 11) return null
            MeshPayload(
                messageId = parts[0],
                type = parts[1],
                payloadB64 = parts[2],
                hopCount = parts[3].toInt(),
                origEphemeralId = parts[4],
                origPublicKey = parts[5],
                timestamp = parts[6].toLong(),
                signature = parts[7],
                nonce = parts[8].toInt(),
                lat = parts[9].toDouble(),
                lng = parts[10].toDouble()
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
            payload.hopCount.toString(),
            payload.origEphemeralId,
            payload.origPublicKey,
            payload.timestamp.toString(),
            payload.signature,
            payload.nonce.toString(),
            payload.lat.toString(),
            payload.lng.toString()
        ).joinToString("|")
    }
}
