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
        // Wire constants live in MeshWire (pure JVM, unit-tested); these
        // companion aliases keep call sites readable.
        const val MAX_HOPS = MeshWire.MAX_HOPS
        const val PROTOCOL_VERSION = MeshWire.PROTOCOL_VERSION
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

        // Seen-hash cache bound (audit): the 5-minute TTL limits LIFETIME but
        // not SIZE — an attacker flooding unique garbage could grow the map
        // unbounded in the window. The cap evicts the OLDEST entry as soon as
        // it is exceeded (see handleIncomingMessage / trickleTick).
        const val MAX_SEEN_HASHES = 4096
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
    // every hop; only hopsLeft decays (hopCount is SIGNED and immutable — see
    // MeshWire).
    private data class MeshMessage(
        val messageId: String,
        val type: String,
        val payloadB64: String,
        val iv: String,
        val hopCount: Int,
        val hopsLeft: Int,
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
        // budget (ttl, one decrement per REAL delivery attempt) is exhausted,
        // when MESSAGE_TTL_MS elapses after the LAST SEND, or when every peer
        // it was actually sent to acknowledges delivery. The clock starts at
        // the last actual send — NEVER at birth: a message that sat queued
        // while no peer was in range burns no budget and no clock, because it
        // could not act. lastSendAttemptAt anchors that clock; 0 means
        // "never sent to anyone".
        var lastSendAttemptAt: Long = 0L,
        var ttl: Long = MESSAGE_TTL_WINDOWS,
        // Endpoints this message was actually handed to the transport for
        // (one frame per endpoint). Delivery ACKs arrive via
        // onPayloadTransferUpdate; a message whose every attempted endpoint
        // acknowledged delivery can be evicted early.
        val attemptedTargets: MutableSet<String> = ConcurrentHashMap.newKeySet(),
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
    // Send-attempt dedup markers: "the same frame was handed to the transport
    // for this peer at time t". These are NOT delivery acknowledgements —
    // delivery is accounted separately in deliveredTargets.
    private val forwardedMessages = ConcurrentHashMap<String, Long>()
    // Nearby payload id -> mesh messageId: lets onPayloadTransferUpdate
    // attribute an outgoing transfer outcome to its mesh message.
    private val payloadToMessage = ConcurrentHashMap<Long, String>()
    // messageId -> set of endpointIds whose transfer acknowledged SUCCESS.
    // Only this set counts as "delivered" (sendPayload ≠ delivery).
    private val deliveredTargets = ConcurrentHashMap<String, MutableSet<String>>()

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
        // The identity key pair is now durable (SharedPreferences) so the
        // "persistent per install" identity actually survives restarts.
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

        override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {
            // Delivery accounting: SUCCESS is the ONLY signal that the peer's
            // transport accepted the bytes — sendPayload() returning means
            // merely "handed to the transport", not "delivered". FAILURE and
            // CANCELED forget the mapping so a later retry can be attributed
            // again.
            val messageId = payloadToMessage[update.payloadId] ?: return
            when (update.status) {
                PayloadTransferUpdate.Status.SUCCESS -> {
                    deliveredTargets.getOrPut(messageId) { ConcurrentHashMap.newKeySet() }.add(endpointId)
                    payloadToMessage.remove(update.payloadId)
                }
                PayloadTransferUpdate.Status.FAILURE -> {
                    // Unmark the send attempt (audit): the forwarded marker is
                    // the retry gate in trickleTick — leaving it behind after
                    // a FAILED transfer would exclude that peer from retries
                    // until the 5-minute marker cleanup. The next trickle
                    // window retries honestly.
                    forwardedMessages.remove("$endpointId:$messageId")
                    payloadToMessage.remove(update.payloadId)
                }
                else -> { /* IN_PROGRESS / CANCELED — keep waiting */ }
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

    private fun handleIncomingMessage(endpointId: String, bytes: ByteArray) {
        try {
            // Wire format: only magic-framed frames (deflate or raw-flagged)
            // are accepted. Decoding a raw frame as JSON would defeat the
            // format gate and risk parsing attacker-chosen bytes as JSON.
            val json = MeshWire.decompress(bytes) ?: run {
                Log.w(TAG, "Incoming frame missing compression magic")
                updateReputation(endpointId, REPUTATION_FALSE_REPORT / 2)
                return
            }
            val payload = MeshWire.parseFrame(json) ?: return

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
            if (!MeshWire.ProofOfWork.verify(powPrefix, payload.powNonce, payload.powDifficulty)) {
                Log.w(TAG, "Invalid proof-of-work on wire message")
                updateReputation(endpointId, REPUTATION_FALSE_REPORT / 2)
                return
            }

            // Verify the ECDSA signature over the CANONICAL SIGNED METADATA
            // (ciphertext + iv + messageId + type + hopCount + origEphemeralId
            // + origPublicKey + timestamp + nonce + lat + lng) — public-key
            // integrity check available to every relay, independent of the AES
            // key. A relay cannot alter lat/lng/type/nonce/messageId anymore
            // without invalidating the signature (audit).
            val secureMsg = CryptoEngine.SecureMessage(
                ephemeralId = payload.origEphemeralId,
                senderPublicKey = payload.origPublicKey,
                ciphertext = payload.payloadB64,
                iv = payload.iv,
                signature = payload.signature,
                timestamp = payload.timestamp,
                lat = payload.lat,
                lng = payload.lng,
                nonce = payload.nonce,
                messageId = payload.messageId,
                type = payload.type,
                hopCount = payload.hopCount
            )

            if (payload.type != MESSAGE_TYPE_ECHO && !CryptoEngine.verifyMessageSignature(secureMsg)) {
                Log.w(TAG, "Invalid signature on wire message")
                updateReputation(endpointId, REPUTATION_FALSE_REPORT / 2)
                return
            }

            // Anti-replay / anti-broadcast-storm — ONLY AFTER authentication:
            // recording (messageId + nonce) BEFORE the PoW + signature checks
            // let a forged invalid frame poison the cache and block the valid
            // one (audit). Only authenticated frames may enter the seen-cache.
            val msgHash = MeshWire.seenMessageHash(payload.messageId, payload.nonce)
            if (seenMessageHashes.containsKey(msgHash)) return
            seenMessageHashes[msgHash] = System.currentTimeMillis()
            if (seenMessageHashes.size > MAX_SEEN_HASHES) {
                // Unbounded cache = untrusted growth window (audit): evict
                // the OLDEST entry as soon as the cap is exceeded.
                seenMessageHashes.entries.minByOrNull { it.value }
                    ?.let { seenMessageHashes.remove(it.key) }
            }

            // Learn the peer's public key ONLY from the origin's signed message
            // (hopCount == 0). With hopCount part of the SIGNED metadata, this
            // origin claim is authenticated: a relay can forward an origin's
            // frame but cannot forge or alter the claim itself. The residual
            // (a relay forwarding an origin frame maps the RELAY endpoint to
            // the true origin's key, so a response to that key travels toward
            // the origin via the relay) is benign for E2EE: only the true key
            // holder can decrypt.
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
            // sender timestamp travel unchanged; only the unsigned hopsLeft
            // decays (hopCount stays 0 — it is signed and immutable). A message
            // addressed to a deeper peer reaches it hop by hop.
            if (payload.hopsLeft > 0) {
                pendingMessages.add(MeshMessage(
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
        // the payload, verified at every receiving hop. Budget exhaustion is
        // pathological (difficulty 8 averages 256 tries): the message is still
        // queued with an unsolvable nonce rather than crashing the broadcast
        // (audit: a thrown SecurityException used to escape this path).
        val powPrefix = "$messageId${CryptoEngine.getEphemeralId()}"
        val powNonce = MeshWire.ProofOfWork.solve(powPrefix, PO_W_DIFFICULTY) ?: run {
            Log.w(TAG, "Proof-of-work budget exhausted; frame will be rejected by peers")
            -1
        }

        // Eviction policy: entries that have never been sent to anyone
        // (no reachable peers yet) are shielded from eviction — they carry
        // the newest reports and would otherwise be the first to die under
        // load. Expired (TTL 0) or already-sent entries go first.
        if (pendingMessages.size >= MAX_PENDING_MESSAGES) {
            val evictable = pendingMessages
                .withIndex()
                .filter { it.value.lastSendAttemptAt > 0 || it.value.ttl <= 0 }
                .minByOrNull { it.value.lastSendAttemptAt }
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
            hopsLeft = MAX_HOPS,
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
        // without delivering, or when EVERY peer it was actually sent to
        // acknowledged delivery (deliveredTargets — sendPayload ≠ delivery).
        // The clock starts at the LAST SEND — never at birth: a message that
        // sat queued while no peer was in range burns no budget and no time,
        // because it could not act.
        val cutoff = now - MESSAGE_TTL_MS
        pendingMessages.removeAll { msg ->
            msg.ttl <= 0 ||
                (msg.lastSendAttemptAt > 0 && msg.lastSendAttemptAt < cutoff) ||
                (msg.attemptedTargets.isNotEmpty() &&
                    msg.attemptedTargets.all { ep -> deliveredTargets[msg.messageId]?.contains(ep) == true })
        }

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
                    val targetPeers = peers.filter { (id, info) ->
                        reputation.getOrDefault(id, REPUTATION_INITIAL) > REPUTATION_MIN / 2 &&
                            info.publicKey.isNotBlank() &&
                            now - info.lastSeen < PEER_STALE_MS &&
                            !forwardedMessages.containsKey("$id:${msg.messageId}")
                    }
                    if (targetPeers.isEmpty()) {
                        // Store-and-forward: no candidate peer this window. The
                        // message keeps waiting WITHOUT burning its attempt
                        // budget or its TTL clock — nothing could be sent.
                        return@forEach
                    }

                    // Delivery-attempt semantics: lastSendAttemptAt and the ttl
                    // budget advance ONLY when at least one frame actually went
                    // out to the transport — never for scans, missing peer
                    // keys or per-target encryption failures.
                    var sentToTransport = false
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
                        sentToTransport = true
                        // Per-target dedup: the same frame is never handed to
                        // the same peer twice within a window. This marker is
                        // a SEND attempt, not a delivery acknowledgement (the
                        // outcome lives in deliveredTargets).
                        forwardedMessages["$endpointId:${msg.messageId}"] = now
                    }
                    if (sentToTransport) {
                        msg.lastSendAttemptAt = now
                        msg.ttl = (msg.ttl - 1).coerceAtLeast(0)
                    }
                } finally {
                    msg.inFlight = false
                }
            }
        }

        // Reset interval
        trickleInterval = TRICKLE_I_MIN

        // Cleanup old seen hashes + forwarded markers + delivery state
        val cutoff2 = now - 300_000L
        seenMessageHashes.entries.removeAll { it.value < cutoff2 }
        // Bound enforcement as a safety net (audit): the cap is primarily
        // enforced at insert time (handleIncomingMessage); this catches any
        // growth from the window between inserts.
        while (seenMessageHashes.size > MAX_SEEN_HASHES) {
            seenMessageHashes.entries.minByOrNull { it.value }
                ?.let { seenMessageHashes.remove(it.key) } ?: break
        }
        forwardedMessages.entries.removeAll { it.value < cutoff2 }
        val liveMessageIds = pendingMessages.map { it.messageId }.toSet()
        // Delivery sets for evicted messages can go; in-flight mapping entries
        // for gone messages too (bounded by payloads actually in flight).
        deliveredTargets.keys.retainAll(liveMessageIds)
        payloadToMessage.entries.removeAll { (_, msgId) -> msgId !in liveMessageIds }
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
            MeshWire.Frame(
                protocolVersion = PROTOCOL_VERSION,
                messageId = msg.messageId,
                type = msg.type,
                payloadB64 = encrypted.ciphertext,
                iv = encrypted.iv,
                hopCount = encrypted.hopCount,
                origEphemeralId = encrypted.ephemeralId,
                origPublicKey = encrypted.senderPublicKey,
                timestamp = encrypted.timestamp,
                signature = encrypted.signature,
                nonce = msg.nonce,
                lat = msg.lat,
                lng = msg.lng,
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
        val json = MeshWire.frameToJson(frame)
        val compressed = MeshWire.compress(json.toByteArray(Charsets.UTF_8))
        val payload = Payload.fromBytes(compressed)
        // Attribute the outgoing transfer outcome to this message: only an
        // onPayloadTransferUpdate(SUCCESS) counts as delivered. The mapping
        // is removed on SUCCESS/FAILURE, so a retry attributes cleanly.
        payloadToMessage[payload.id] = msg.messageId
        msg.attemptedTargets.add(endpointId)
        connectionsClient.sendPayload(endpointId, payload)
    }

    private fun notifyListeners(message: String) {
        messageListeners.forEach { it(message) }
    }
}
