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
import java.security.SecureRandom

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
        // NOTE (audit round 12): MESSAGE_TYPE_REPUTATION was removed. It was
        // whitelisted in the bridge but had NO wire protocol handling — the
        // receiver has no reputation branch, so advertising a type nothing
        // processes is a dead + misleading protocol surface. Reputation is
        // scored from authenticated traffic (reports/echoes) only.
        // Wire constants live in MeshWire (pure JVM, unit-tested); these
        // companion aliases keep call sites readable.
        const val MAX_HOPS = MeshWire.MAX_HOPS
        const val PROTOCOL_VERSION = MeshWire.PROTOCOL_VERSION
        const val REPUTATION_INITIAL = 50
        const val REPUTATION_GOOD_REPORT = 15
        const val REPUTATION_FALSE_REPORT = -50
        const val REPUTATION_CONFIRM_MATCH = 5
        // Audit B2: penalties are differentiated by offense severity — garbage
        // bytes are often environmental noise, a failed PoW is cheap to fake,
        // a wrong difficulty signals a modified client, and a bad signature is
        // active tampering. A single flat penalty made every offense worth the
        // same (de)credit.
        const val REPUTATION_MALFORMED_FRAME = -10
        const val REPUTATION_BAD_POW = -20
        const val REPUTATION_BAD_DIFFICULTY = -30
        const val REPUTATION_BAD_SIGNATURE = -40
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
        // unbounded. Messages that were NEVER attempted (no peer in range)
        // wait indefinitely and are only evicted by the queue cap.
        // (Audit round 12: the old MESSAGE_TTL_WINDOWS delivery budget was
        // removed — 3 trickle windows expired messages in well under a minute
        // even when every attempt was retryable, making the stated 10-minute
        // TTL a lie. Expiry is now purely time-based.)
        const val MESSAGE_TTL_MS = 10 * 60 * 1000L
        // Admission freshness policy: the signed origin timestamp must be
        // within the message lifetime, with a small allowance for clock skew.
        const val MESSAGE_CLOCK_SKEW_MS = 2 * 60 * 1000L
        const val MAX_PENDING_MESSAGES = 200
        const val PEER_STALE_MS = 10 * 60 * 1000L
        // Maximum plaintext size before queueing (audit: prevent OOM via oversized payloads).
        const val MAX_PLAINTEXT_BYTES = 256 * 1024 // 256 KB
        const val MAX_BRIDGE_JSON_BYTES = 512 * 1024 // JSON envelope before parsing

        // Network-wide proof-of-work requirement: the receiver does NOT trust
        // the sender's declared difficulty. A frame carrying anything other
        // than the network requirement is rejected before any hashing — this
        // bounds the verification cost an untrusted neighbor can impose (a
        // "difficulty 999999" frame is dropped, not computed).
        const val PO_W_DIFFICULTY = MeshWire.NETWORK_POW_DIFFICULTY

        // Seen-hash cache bound (audit): the 5-minute TTL limits LIFETIME but
        // not SIZE — an attacker flooding unique garbage could grow the map
        // unbounded in the window. The cap evicts the OLDEST entry as soon as
        // it is exceeded (see handleIncomingMessage / trickleTick).
        //
        // Threat budget (audit round 12 — why 4096): entries are only added
        // AFTER full authentication (PoW + ECDSA), so the cache grows at the
        // rate of VALID traffic. 4096 spans ~13.6 verified messages/second
        // across the whole 5-minute window — far beyond the capacity of a
        // battery-powered P2P cluster — so eviction under normal operation
        // never shrinks the effective replay window. The residual trade-off:
        // an authenticated flooding sender can truncate the replay window by
        // outrunning the cap — the cap caps MEMORY, not the replay policy.
        const val MAX_SEEN_HASHES = 4096
        // Secure randomness for protocol nonces and identifiers.
        private val protocolRandom = SecureRandom()
        // Device records (TOFU identity — audit round 12): reputation and
        // first/last-seen are anchored on the peer's ADVERTISED PUBLIC KEY,
        // not on the transport endpointId, which is a Nearby session id that
        // changes every re-announce. The cap bounds distinct devices seen;
        // a larger herd evicts the least-recently-seen record.
        const val MAX_DEVICE_RECORDS = 1024
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

    // TOFU device identity (audit round 12): reputation and first/last-seen
    // are anchored on the peer's ADVERTISED PUBLIC KEY — the key IS the
    // device identity in this anonymous proximity mesh. The Nearby
    // endpointId is merely a transport session handle that changes on every
    // re-announce, so keying reputation on it let state outlive peers
    // (accumulating forever) and lost all history when a device re-announced.
    // Records are created at first sight (trust-on-first-use), keyed forever
    // by the public key, and bounded by MAX_DEVICE_RECORDS.
    //
    // Authenticated-key-exchange caveat (audit round 12): "peer key from the
    // Nearby name" binds a public key to an endpoint NAME, and the device
    // that OWNS the private half of that key can prove it when decrypting —
    // but without an out-of-band channel there is no way to prove WHICH
    // physical device the key belongs to (any nearby device can name itself
    // and hold a key). E2EE here therefore guarantees "only the holder of
    // the private key can read it", not "this specific device I met before".
    // Device-level attestation (binding an ephemeral key to the keystore
    // identity in a challenge/response) is future work — it needs an
    // out-of-band trust bootstrap (QR pairing / human confirmation), which
    // this headless mesh does not have.
    private data class DeviceRecord(
        var reputation: Int,
        var firstSeen: Long,
        var lastSeen: Long
    )
    private val deviceRecords = ConcurrentHashMap<String, DeviceRecord>()

    // Known peers: endpointId -> EndpointInfo (transport registry; the
    // identity/reputation anchor is the public key — see DeviceRecord).
    // Audit round 12: the old EndpointInfo.ephemeralId ("unknown" forever)
    // and hopCount fields were removed — they were never populated from a
    // real source, and a misleading "identity-looking" field invites future
    // misuse. hop state lives on MeshMessage/wire frames only.
    private data class EndpointInfo(
        val endpointId: String,
        val publicKey: String,
        var lastSeen: Long
    )
    private val peers = ConcurrentHashMap<String, EndpointInfo>()

    // Connection state machine (audit A4): Nearby re-fires onEndpointFound
    // repeatedly while discovery is active. Tracking pending + established
    // connections here means one requestConnection per endpoint — no duplicate
    // handshakes, no reconnect storms while a session is already in flight.
    private val connectingPeers = ConcurrentHashMap.newKeySet<String>()
    private val connectedPeers = ConcurrentHashMap.newKeySet<String>()

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
        //
        // Audit round 12: this is the SHARED immutable key-generation handle
        // — every queued message of one generation references the SAME
        // instance (no per-message key material copies). Memory per queued
        // message is three references, and the 1h rotation period dwarfs the
        // 10-minute message TTL, so the bounded queue can hold at most two
        // generations at once. The snapshot keeps working after rotation —
        // signing/encrypting with a retired sender key is valid because the
        // frame carries that generation's id+pubkey and the signature is
        // verified against them.
        val snapshot: CryptoEngine.EphemeralSnapshot? = null,
        // Delivery bookkeeping. Expiry is TIME-BASED since the last actual
        // send (audit round 12: the old per-window attempt budget expired
        // messages in seconds even when every attempt stayed retryable).
        // lastSendAttemptAt anchors the clock; 0 means "never sent to
        // anyone" (such messages wait indefinitely, evicted only by the
        // queue cap — store-and-forward semantics).
        var lastSendAttemptAt: Long = 0L,
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
    // Nearby payload id -> (endpointId, mesh messageId): lets
    // onPayloadTransferUpdate attribute an outgoing transfer outcome to its
    // mesh message AND lets peer-cleanup drop mappings whose endpoint is
    // gone (audit round 12 — the mapping used to be endpoint-agnostic, so a
    // peer vanishing without a final transfer callback leaked the entry).
    private data class PayloadBinding(val endpointId: String, val messageId: String)
    private val payloadToMessage = ConcurrentHashMap<Long, PayloadBinding>()
    // messageId -> set of endpointIds whose transfer acknowledged SUCCESS.
    // Only this set counts as "delivered" (sendPayload ≠ delivery).
    private val deliveredTargets = ConcurrentHashMap<String, MutableSet<String>>()

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
        peers.clear()
        deviceRecords.clear()
        pendingMessages.clear()
        forwardedMessages.clear()
        payloadToMessage.clear()
        deliveredTargets.clear()
        seenMessageHashes.clear()
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
                connectingPeers.remove(endpointId)
                connectedPeers.add(endpointId)
                // Preserve any key already learned from discovery/initiation
                // instead of wiping it (audit round 11).
                val known = peers[endpointId]
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
                connectingPeers.remove(endpointId)
                peerCleanup(endpointId)
            }
        }

        override fun onDisconnected(endpointId: String) {
            Log.d(TAG, "Disconnected: $endpointId")
            connectingPeers.remove(endpointId)
            connectedPeers.remove(endpointId)
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
            deviceRecords.getOrPut(advertisedKey) {
                DeviceRecord(
                    reputation = REPUTATION_INITIAL,
                    firstSeen = System.currentTimeMillis(),
                    lastSeen = System.currentTimeMillis()
                ).also { capDeviceRecords() }
            }
            if (deviceRecords[advertisedKey]!!.reputation > REPUTATION_MIN / 2) {
                // Upsert the transport handle: a re-announcement (fresh
                // endpointId or rotated key) updates the CURRENT key instead
                // of being ignored by putIfAbsent (audit round 12).
                registerPeer(endpointId, advertisedKey)
                // Audit A4: dedupe the handshake — onEndpointFound can fire
                // repeatedly for the same endpoint while discovery runs.
                if (!connectingPeers.contains(endpointId) && !connectedPeers.contains(endpointId)) {
                    connectingPeers.add(endpointId)
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
            connectingPeers.remove(endpointId)
            connectedPeers.remove(endpointId)
            peerCleanup(endpointId)
        }
    }

    /**
     * Register (or refresh) a transport handle. UPSERT semantics (audit round
     * 12): the old putIfAbsent kept the FIRST key seen for an endpointId —
     * after a peer rotated its ephemeral key and re-announced, the registry
     * kept encrypting to the STALE key. Every sighting (discovery,
     * connection-initiated, connection-result) refreshes the CURRENT key.
     */
    @Synchronized
    private fun registerPeer(endpointId: String, publicKey: String) {
        if (endpointId.isBlank() || !isLikelyPublicKey(publicKey) || !CryptoEngine.isValidPublicKey(publicKey)) {
            Log.w(TAG, "Ignoring peer with invalid identity: $endpointId")
            return
        }
        val now = System.currentTimeMillis()
        val existing = peers[endpointId]
        val lastSeen = if (existing != null) maxOf(existing.lastSeen, now) else now
        peers[endpointId] = EndpointInfo(endpointId = endpointId, publicKey = publicKey, lastSeen = lastSeen)
    }

    /**
     * Unified session-bound teardown (audit round 12): EVERY peer-gone event
     * — endpoint lost, disconnected, connection failed, auto-disconnect —
     * runs the SAME cleanup: the transport handle goes, as do the forwarded
     * markers (retry gate), the in-flight payload bindings (with no final
     * transfer callback, the old code leaked the mapping), the per-message
     * attempted-target set and the delivered set for that endpoint. The TOFU
     * device RECORD survives deliberately (reputation is identity history,
     * keyed by the key, bounded by MAX_DEVICE_RECORDS).
     */
    @Synchronized
    private fun peerCleanup(endpointId: String) {
        peers.remove(endpointId)
        // Audit A4: every teardown path (lost/disconnect/failed/quarantine)
        // also clears the handshake dedupe flags.
        connectingPeers.remove(endpointId)
        connectedPeers.remove(endpointId)
        forwardedMessages.keys.removeAll { it.startsWith("$endpointId:") }
        payloadToMessage.entries.removeAll { (_, binding) -> binding.endpointId == endpointId }
        // A vanished peer can never deliver: drop it from every message's
        // attempted/delivered bookkeeping so those messages stay re-openable.
        pendingMessages.forEach { it.attemptedTargets.remove(endpointId) }
        deliveredTargets.values.forEach { it.remove(endpointId) }
    }

    /**
     * Bound the TOFU record table (audit round 12): distinct near-mesh
     * devices are bounded by MAX_DEVICE_RECORDS; overflow evicts the
     * least-recently-seen record so an anonymous herd cannot grow memory
     * forever.
     */
    private fun capDeviceRecords() {
        while (deviceRecords.size > MAX_DEVICE_RECORDS) {
            deviceRecords.entries.minByOrNull { it.value.lastSeen }
                ?.let { deviceRecords.remove(it.key) } ?: break
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
            val binding = payloadToMessage[update.payloadId] ?: return
            when (update.status) {
                PayloadTransferUpdate.Status.SUCCESS -> {
                    deliveredTargets.getOrPut(binding.messageId) { ConcurrentHashMap.newKeySet() }.add(endpointId)
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
                    forwardedMessages.remove("$endpointId:${binding.messageId}")
                    payloadToMessage.remove(update.payloadId)
                    pendingMessages.firstOrNull { it.messageId == binding.messageId }
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
                updateReputation(endpointId, REPUTATION_MALFORMED_FRAME)
                return false
            }
            val payload = MeshWire.parseFrame(json) ?: return false

            // Signature validity alone does not imply freshness. Reject old
            // frames and timestamps too far in the future before spending CPU
            // on PoW or cryptographic verification. The timestamp is signed,
            // so this gate cannot be bypassed by a relay changing metadata.
            val now = System.currentTimeMillis()
            if (!MeshWire.isFreshTimestamp(
                    payload.timestamp,
                    now,
                    MESSAGE_TTL_MS,
                    MESSAGE_CLOCK_SKEW_MS
                )
            ) {
                Log.w(TAG, "Rejecting stale or future-dated mesh frame")
                updateReputation(endpointId, REPUTATION_MALFORMED_FRAME)
                return false
            }

            // Proof-of-Work verification: the nonce is carried in the payload
            // and checked at every hop — solving without transmitting/verifying
            // would be a no-op. Difficulty is clamped to a sane band: solving
            // more than our constant is a marker of a modified (non-stock)
            // client and is rejected, keeping the network uniform.
            if (payload.powDifficulty != PO_W_DIFFICULTY) {
                Log.w(TAG, "Out-of-band proof-of-work difficulty")
                updateReputation(endpointId, REPUTATION_BAD_DIFFICULTY)
                return false
            }
            // Canonical challenge framing (audit round 11): same
            // length-prefixed composition the origin used to solve.
            val powPrefix = MeshWire.ProofOfWork.wirePrefix(payload.messageId, payload.origEphemeralId)
            if (!MeshWire.ProofOfWork.verify(powPrefix, payload.powNonce, payload.powDifficulty)) {
                Log.w(TAG, "Invalid proof-of-work on wire message")
                updateReputation(endpointId, REPUTATION_BAD_POW)
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
                updateReputation(endpointId, REPUTATION_BAD_SIGNATURE)
                return false
            }

            // Anti-replay / anti-broadcast-storm — ONLY AFTER authentication:
            // recording (messageId + nonce) BEFORE the PoW + signature checks
            // let a forged invalid frame poison the cache and block the valid
            // one (audit). Only authenticated frames may enter the seen-cache.
            val msgHash = MeshWire.seenMessageHash(payload.messageId, payload.nonce)
            val seenAt = System.currentTimeMillis()
            // Atomic admission prevents two concurrent Nearby callbacks from
            // accepting the same authenticated frame at the same time.
            if (seenMessageHashes.putIfAbsent(msgHash, seenAt) != null) return false
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

            // Store-and-forward relay FIRST (audit B1): enqueue relay BEFORE
            // notifying local listeners so a listener exception cannot stop propagation.
            if (payload.hopsLeft > 0) {
                // H1 fix: the relay path must respect the same queue bound as
                // broadcastMessage — otherwise a peer flooding unique valid
                // frames grows pendingMessages without limit (OOM on a device
                // that must stay alive for an emergency).
                evictIfQueueFull()
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
     * H1 fix: single eviction policy shared by the local broadcast and relay
     * paths. Entries that have never been sent to anyone (no reachable peers
     * yet) are shielded from eviction — they carry the newest reports and
     * would otherwise be the first to die under load. Already-attempted
     * entries go first (their 10-minute clock is ordered by lastSendAttemptAt).
     */
    @Synchronized
    private fun evictIfQueueFull() {
        if (pendingMessages.size < MAX_PENDING_MESSAGES) return
        val evictable = pendingMessages
            .withIndex()
            .filter { it.value.lastSendAttemptAt > 0 }
            .minByOrNull { it.value.lastSendAttemptAt }
        if (evictable != null) {
            pendingMessages.removeAt(evictable.index)
        } else {
            // Everything is un-attempted and alive: drop the oldest
            // entry to keep the queue bounded.
            if (pendingMessages.isNotEmpty()) {
                pendingMessages.removeAt(0)
            }
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
        evictIfQueueFull()

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
        return true
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
        val cutoff = now - MESSAGE_TTL_MS
        pendingMessages.removeAll { msg ->
            (msg.lastSendAttemptAt > 0 && msg.lastSendAttemptAt < cutoff) ||
                (msg.attemptedTargets.isNotEmpty() &&
                    msg.attemptedTargets.all { ep -> deliveredTargets[msg.messageId]?.contains(ep) == true })
        }
        val replayCutoff = now - (MESSAGE_TTL_MS + MESSAGE_CLOCK_SKEW_MS)
        seenMessageHashes.entries.removeAll { it.value < replayCutoff }
        // Bound enforcement as a safety net (audit): the cap is primarily
        // enforced at insert time (handleIncomingMessage); this catches any
        // growth from the window between inserts.
        while (seenMessageHashes.size > MAX_SEEN_HASHES) {
            seenMessageHashes.entries.minByOrNull { it.value }
                ?.let { seenMessageHashes.remove(it.key) } ?: break
        }
        val forwardedCutoff = now - 300_000L
        forwardedMessages.entries.removeAll { it.value < forwardedCutoff }
        val liveMessageIds = pendingMessages.map { it.messageId }.toSet()
        // Delivery sets for evicted messages can go; in-flight mapping entries
        // for gone messages too (bounded by payloads actually in flight).
        deliveredTargets.keys.retainAll(liveMessageIds)
        payloadToMessage.entries.removeAll { (_, binding) -> binding.messageId !in liveMessageIds }

        // Trickle-K with O(F) counting (audit round 12): the old batch filter
        // ran a full forwardedMessages scan PER queued message — O(M×F) per
        // tick, quadratic in the mesh size. Count forwards ONCE into a small
        // map (O(F)), then filter in O(M).
        val forwardsPerMessage = HashMap<String, Int>()
        for ((key, ts) in forwardedMessages) {
            if (now - ts >= trickleInterval) continue
            val sep = key.indexOf(':')
            if (sep <= 0 || sep == key.length - 1) continue
            forwardsPerMessage.merge(key.substring(sep + 1), 1, Int::plus)
        }
        val batch = pendingMessages.filter { msg ->
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
                val targetPeers = peers.filter { (id, info) ->
                    connectedPeers.contains(id) &&
                    (deviceRecords[info.publicKey]?.reputation ?: REPUTATION_INITIAL) > REPUTATION_MIN / 2 &&
                        now - info.lastSeen < PEER_STALE_MS &&
                        !forwardedMessages.containsKey("$id:${msg.messageId}")
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
                            forwardedMessages["$endpointId:${msg.messageId}"] = now
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
        peers[endpointId]?.publicKey?.takeIf { it.isNotBlank() }?.let { key ->
            deviceRecords.computeIfPresent(key) { _, record ->
                record.reputation = REPUTATION_MIN / 2 - 1
                record.lastSeen = System.currentTimeMillis()
                record
            }
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
     * keyless reputation path to abuse.
     */
    @Synchronized
    fun updateReputation(endpointId: String, delta: Int) {
        val info = peers[endpointId] ?: run {
            Log.d(TAG, "Reputation update for unknown endpoint $endpointId: ignored")
            return
        }
        if (info.publicKey.isBlank()) return
        val now = System.currentTimeMillis()
        val record = deviceRecords.compute(info.publicKey) { _, existing ->
            val base = existing ?: DeviceRecord(REPUTATION_INITIAL, now, now)
            base.reputation = (base.reputation + delta).coerceIn(REPUTATION_MIN, REPUTATION_MAX)
            base.lastSeen = now
            base
        } ?: return

        Log.d(TAG, "Reputation $endpointId (${info.publicKey.take(8)}…): ${record.reputation - delta} → ${record.reputation} (Δ$delta)")

        // Auto-disconnect malicious peers
        if (record.reputation <= REPUTATION_MIN / 2) {
            connectionsClient.disconnectFromEndpoint(endpointId)
            peerCleanup(endpointId)
        }
    }

    fun getReputation(endpointId: String): Int {
        return peers[endpointId]?.publicKey
            ?.takeIf { it.isNotBlank() }
            ?.let { deviceRecords[it]?.reputation }
            ?: REPUTATION_INITIAL
    }

    fun getConnectedPeers(): List<Map<String, Any>> {
        return peers.map { (id, info) ->
            mapOf(
                "endpointId" to id,
                // The public key is the peer's mesh identity (audit round
                // 12: the old ephemeralId field was always "unknown" and
                // hopCount was unused — removed as misleading state).
                "publicKey" to info.publicKey,
                "lastSeen" to info.lastSeen,
                "reputation" to (deviceRecords[info.publicKey]?.reputation ?: REPUTATION_INITIAL)
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
    private fun sendToTarget(endpointId: String, msg: MeshMessage, encrypted: CryptoEngine.SecureMessage?): Boolean {
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
        payloadToMessage[payload.id] = PayloadBinding(endpointId = endpointId, messageId = msg.messageId)
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
                    forwardedMessages,
                    msg.attemptedTargets
                )
                payloadToMessage.remove(payload.id)
            }
        // Update lastSeen for this peer since we successfully handed off a frame to the transport.
        peers[endpointId]?.let { info ->
            val now = System.currentTimeMillis()
            if (now - info.lastSeen > 1000) {
                peers[endpointId] = info.copy(lastSeen = now)
            }
        }
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
