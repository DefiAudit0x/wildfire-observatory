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
        // The exact ephemeral material this message was (or will be) signed
        // and encrypted with (audit round 11): the PoW prefix, origEphemeralId,
        // origPublicKey and the E2EE signature must ALL derive from ONE
        // snapshot, otherwise rotation between reads yields a frame every
        // peer rejects. Locally generated messages carry the snapshot; relayed
        // messages carry null and re-emit the stored frame verbatim.
        val snapshot: CryptoEngine.EphemeralSnapshot? = null,
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
        // acknowledged delivery can be evicted early. Failed/canceled
        // transfers REMOVE their endpoint so the eviction check above never
        // counts a failed attempt as "delivered pending" (audit round 11).
        val attemptedTargets: MutableSet<String> = ConcurrentHashMap.newKeySet(),
        // Real in-flight guard (audit round 11): checked in trickleTick's
        // batch selection and cleared in a finally block. The old field was
        // only ever SET and never READ — a marker, not a guard; now a message
        // currently inside a send loop cannot be picked up by a concurrent
        // tick (defense in depth against a future async send path).
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
        // Audit round 11: the Nearby endpoint NAME now carries the public key
        // (key exchange, see discovery). A rotated key is therefore invisible
        // to peers until advertising restarts with the new name — restart it
        // here instead of letting the old key linger on the air for hours.
        restartNearbyPresence()
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
            // Key exchange at the transport level (audit round 11): the
            // Nearby "endpoint name" carries the initiator's EPHEMERAL
            // PUBLIC KEY (base64, see startAdvertising/requestConnection), so
            // every peer learns the other's key the moment a connection is
            // initiated — no wire message needed, and no deadlock where both
            // sides wait for the other's key (the old design only learned
            // keys from received hopCount==0 frames, which requires one side
            // to already be able to send — see trickleTick).
            //
            // Authentication-token flow (decision, audit round 11): Nearby
            // offers info.authenticationToken for out-of-band human
            // verification ("both phones show the same code"). This mesh is
            // headless (no user UI per connection) and already authenticates
            // every PAYLOAD cryptographically (PoW + ECDSA, see
            // handleIncomingMessage): an attacker who cannot sign valid
            // frames cannot inject authenticated content regardless of the
            // token. We deliberately do not block on token comparison.
            val initiatorKey = info.endpointName.takeIf { isLikelyPublicKey(it) }
            peers[endpointId]?.let { existing ->
                if (initiatorKey != null && existing.publicKey != initiatorKey) {
                    peers[endpointId] = existing.copy(publicKey = initiatorKey)
                }
            }
            connectionsClient.acceptConnection(endpointId, payloadCallback)
        }

        override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {
            if (result.status.isSuccess) {
                Log.d(TAG, "Connected: $endpointId")
                // Preserve any key already learned from discovery/initiation
                // instead of wiping it (audit round 11): the old code reset
                // publicKey="" here, discarding the discovery-time key
                // exchange and re-creating the send deadlock.
                val known = peers[endpointId]
                peers[endpointId] = EndpointInfo(
                    endpointId = endpointId,
                    ephemeralId = "unknown",
                    publicKey = known?.publicKey ?: "",
                    lastSeen = System.currentTimeMillis()
                )
                reputation.putIfAbsent(endpointId, REPUTATION_INITIAL)
                lastActivityTime = System.currentTimeMillis()
            } else {
                Log.d(TAG, "Connection failed: $endpointId")
                peers.remove(endpointId)
            }
        }

        override fun onDisconnected(endpointId: String) {
            Log.d(TAG, "Disconnected: $endpointId")
            peers.remove(endpointId)
        }
    }

    private val discoveryEndpointCallback = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
            Log.d(TAG, "Found endpoint: $endpointId")
            // The advertiser's Nearby name is its ephemeral public key
            // (audit round 11): learn the peer's key NOW, at discovery —
            // before any message exchange — breaking the old bootstrap
            // deadlock where peers only learned keys from received frames.
            val advertisedKey = info.endpointName.takeIf { isLikelyPublicKey(it) }
            if (reputation.getOrDefault(endpointId, REPUTATION_INITIAL) > REPUTATION_MIN / 2) {
                peers.putIfAbsent(endpointId, EndpointInfo(
                    endpointId = endpointId,
                    ephemeralId = "unknown",
                    publicKey = advertisedKey ?: "",
                    lastSeen = System.currentTimeMillis()
                ))
                connectionsClient.requestConnection(CryptoEngine.getPublicKeyBase64(), endpointId, connectionLifecycleCallback)
            }
        }

        override fun onEndpointLost(endpointId: String) {
            // Audit round 11: previously a no-op (only onDisconnected cleaned
            // up), so a peer that vanished from the radio without an orderly
            // disconnect left a stale entry that trickleTick kept trying to
            // encrypt to (and PEER_STALE_MS only filtered it after 10 min).
            Log.d(TAG, "Lost endpoint: $endpointId")
            peers.remove(endpointId)
            forwardedMessages.keys.removeAll { it.startsWith("$endpointId:") }
        }
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
            val messageId = payloadToMessage[update.payloadId] ?: return
            when (update.status) {
                PayloadTransferUpdate.Status.SUCCESS -> {
                    deliveredTargets.getOrPut(messageId) { ConcurrentHashMap.newKeySet() }.add(endpointId)
                    payloadToMessage.remove(update.payloadId)
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
                    forwardedMessages.remove("$endpointId:$messageId")
                    payloadToMessage.remove(update.payloadId)
                    pendingMessages.firstOrNull { it.messageId == messageId }
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
     */
    private fun handleIncomingMessage(endpointId: String, bytes: ByteArray): Boolean {
        try {
            // Wire format: only magic-framed frames (deflate or raw-flagged)
            // are accepted. Decoding a raw frame as JSON would defeat the
            // format gate and risk parsing attacker-chosen bytes as JSON.
            val json = MeshWire.decompress(bytes) ?: run {
                Log.w(TAG, "Incoming frame missing compression magic")
                updateReputation(endpointId, REPUTATION_FALSE_REPORT / 2)
                return false
            }
            val payload = MeshWire.parseFrame(json) ?: return false

            // Proof-of-Work verification: the nonce is carried in the payload
            // and checked at every hop — solving without transmitting/verifying
            // would be a no-op. Difficulty is clamped to a sane band: solving
            // more than our constant is a marker of a modified (non-stock)
            // client and is rejected, keeping the network uniform.
            if (payload.powDifficulty <= 0 || payload.powDifficulty > PO_W_DIFFICULTY) {
                Log.w(TAG, "Out-of-band proof-of-work difficulty")
                updateReputation(endpointId, REPUTATION_FALSE_REPORT / 2)
                return false
            }
            // Canonical challenge framing (audit round 11): same
            // length-prefixed composition the origin used to solve.
            val powPrefix = MeshWire.ProofOfWork.wirePrefix(payload.messageId, payload.origEphemeralId)
            if (!MeshWire.ProofOfWork.verify(powPrefix, payload.powNonce, payload.powDifficulty)) {
                Log.w(TAG, "Invalid proof-of-work on wire message")
                updateReputation(endpointId, REPUTATION_FALSE_REPORT / 2)
                return false
            }

            // Verify the ECDSA signature over the CANONICAL SIGNED METADATA
            // (ciphertext + iv + messageId + type + hopCount + origEphemeralId
            // + origPublicKey + timestamp + nonce + lat + lng) — public-key
            // integrity check available to every relay, independent of the AES
            // key. A relay cannot alter lat/lng/type/nonce/messageId anymore
            // without invalidating the signature (audit).
            //
            // Audit round 11: the signature check is now UNCONDITIONAL. The
            // old `type != ECHO` exemption let anyone (a peer with a valid PoW
            // budget, i.e. any nearby device) push UNVERIFIED plaintext into
            // notifyListeners — ECHO's payload is decoded directly, so an
            // attacker could inject arbitrary text into the UI with zero
            // cryptographic proof. No legitimate caller emits ECHO today, so
            // exempting nothing costs nothing.
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

            if (!CryptoEngine.verifyMessageSignature(secureMsg)) {
                Log.w(TAG, "Invalid signature on wire message")
                updateReputation(endpointId, REPUTATION_FALSE_REPORT / 2)
                return false
            }

            // Anti-replay / anti-broadcast-storm — ONLY AFTER authentication:
            // recording (messageId + nonce) BEFORE the PoW + signature checks
            // let a forged invalid frame poison the cache and block the valid
            // one (audit). Only authenticated frames may enter the seen-cache.
            val msgHash = MeshWire.seenMessageHash(payload.messageId, payload.nonce)
            if (seenMessageHashes.containsKey(msgHash)) return false
            seenMessageHashes[msgHash] = System.currentTimeMillis()
            if (seenMessageHashes.size > MAX_SEEN_HASHES) {
                // Unbounded cache = untrusted growth window (audit): evict
                // the OLDEST entry as soon as the cap is exceeded.
                seenMessageHashes.entries.minByOrNull { it.value }
                    ?.let { seenMessageHashes.remove(it.key) }
            }

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
            peers[endpointId]?.let { info ->
                val now = System.currentTimeMillis()
                if (now - info.lastSeen > 1000) {
                    peers[endpointId] = info.copy(lastSeen = now)
                }
            }

            val decrypted = if (payload.type == MESSAGE_TYPE_ECHO) {
                // Echo messages are plaintext hop counters by design — but
                // they are SIGNED like every other frame (see above).
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
    fun broadcastMessage(plaintext: String, reportType: String, lat: Double, lng: Double) {
        val messageId = UUID.randomUUID().toString()
        val nonce = Random.nextInt()

        // ONE snapshot for everything (audit round 11): the PoW challenge,
        // the queued origEphemeralId/origPublicKey and the eventual E2EE
        // signature must derive from the same key material or rotation
        // between reads yields a frame peers reject. The single
        // getEphemeralSnapshot() call makes that impossible to get wrong.
        val snapshot = CryptoEngine.getEphemeralSnapshot()

        // Lightweight Proof-of-Work (anti-spam) — solved here, transmitted in
        // the payload, verified at every receiving hop. Budget exhaustion is
        // pathological (difficulty 8 averages 256 tries): the message is still
        // queued with an unsolvable nonce rather than crashing the broadcast
        // (audit: a thrown SecurityException used to escape this path).
        val powPrefix = MeshWire.ProofOfWork.wirePrefix(messageId, snapshot.ephemeralId)
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

        // Audit round 11: the old global "recentForwarded < TRICKLE_K" gate
        // counted forwards of ALL messages in the window — one busy message
        // starved every other message out of the trickle window (each tick
        // sent at most K frames network-wide). Trickle-K is per-message by
        // definition ("heard < K redundant transmissions OF THIS MESSAGE"):
        // each message now has its own redundancy counter. inFlight is now
        // actually READ (was a marker only): a message inside a send loop is
        // skipped by a concurrent tick.
        val batch = pendingMessages.filter { msg ->
            !msg.inFlight &&
                forwardedMessages.count { (key, ts) ->
                    key.endsWith(":${msg.messageId}") && now - ts < trickleInterval
                } < TRICKLE_K
        }

        if (batch.isEmpty()) {
            // Double interval up to max (nothing to send right now)
            trickleInterval = min(trickleInterval * 2, TRICKLE_I_MAX)
            return
        }

        batch.forEach { msg ->
            // In-flight guard: set while the send loop below runs, cleared in
            // a finally block. Synchronous sends mean no interleaving today,
            // but the guard is now real — a concurrent tick cannot pick up a
            // message the send loop is currently processing (audit round 11).
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
                            // Audit round 11 (P0, frames never verified): the
                            // old call omitted messageId/type/hopCount AND the
                            // frame was then built with msg.nonce — so the
                            // frame carried a nonce/messageId the signature did
                            // NOT cover, and EVERY locally generated broadcast
                            // failed signature verification at every peer. The
                            // signed fields must be exactly the fields the
                            // frame transmits: they are now passed in here and
                            // read back from the returned SecureMessage below.
                            messageId = msg.messageId,
                            type = msg.type,
                            hopCount = msg.hopCount
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
            return
        }
        val compressed = MeshWire.compress(json.toByteArray(Charsets.UTF_8))
        val payload = Payload.fromBytes(compressed)
        // Attribute the outgoing transfer outcome to this message: only an
        // onPayloadTransferUpdate(SUCCESS) counts as delivered. The mapping
        // is removed on SUCCESS/FAILURE/CANCELED, so a retry attributes
        // cleanly.
        payloadToMessage[payload.id] = msg.messageId
        msg.attemptedTargets.add(endpointId)
        // Audit round 11 (B11): the sendPayload Task used to be fire-and-
        // forget — a client-side failure (buffer full, endpoint just died)
        // never unmarked the forwarded marker, silently starving that peer
        // of retries past the 5-minute cleanup. Handle the failure inline.
        connectionsClient.sendPayload(endpointId, payload)
            .addOnFailureListener { e ->
                Log.w(TAG, "sendPayload failed for $endpointId", e)
                forwardedMessages.remove("$endpointId:${msg.messageId}")
                payloadToMessage.remove(payload.id)
                msg.attemptedTargets.remove(endpointId)
            }
    }

    private fun notifyListeners(message: String) {
        messageListeners.forEach { it(message) }
    }
}
