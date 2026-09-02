package com.observatory.wildfire

import android.util.Log
import android.webkit.JavascriptInterface
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.Manifest
import android.net.Uri
import android.os.Build
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * JavaScript bridge exposed to the WebView as `window.AndroidBridge`.
 * Provides encrypted mesh messaging, key management, and device info.
 * The MeshService instance is resolved lazily via [meshProvider] so the
 * bridge always talks to the service instance actually bound by MainActivity.
 *
 * Security: every method is gated on [isTrustedOrigin] — the bridge answers
 * ONLY while the main frame is our own HTTPS PWA origin (or a local dev
 * host). If the WebView ever lands on another origin (redirect/XSS), the
 * native surface goes inert instead of handing out keys and signatures.
 *
 * Origin-binding note (audit): the gate authenticates the PAGE's current
 * URL, not the JS CALLER's origin cryptographically — a page that (shares
 * the trusted origin) can always call. That is inherent to addJavascriptInterface;
 * the compensating controls are (a) MainActivity's navigation policy
 * (shouldOverrideUrlLoading keeps the WebView on allow-listed hosts) and
 * (b) the WebView's own hard settings (no file/content access, mixed content
 * never allowed). Do not weaken those while this interface is exposed.
 */
class WebAppInterface(
    private val meshProvider: () -> MeshService?,
    private val urlProvider: () -> String = { "" },
    private val deviceIdProvider: () -> String = { "" },
    private val capabilityProvider: () -> Boolean = { true },
    // Phase 2: application context for the team-tracking FGS surface. The
    // bridge never holds an Activity reference, so no leak is possible.
    private val appContext: Context? = null
) {

    companion object {
        private const val TAG = "WebAppInterface"
        private val ALLOWED_MESSAGE_TYPES = setOf(
            MeshService.MESSAGE_TYPE_REPORT,
            MeshService.MESSAGE_TYPE_ECHO
        )
    }

    private val meshService: MeshService?
        get() = meshProvider()

    // The device identifier is a STABLE identity, so it is resolved once and
    // cached: "deviceId" must not rotate with the ephemeral mesh key (that is
    // the whole point of a device ID — server-side deduplication depends on it).
    @Volatile
    private var cachedDeviceId: String? = null

    /**
     * Origin gate. The check is done on the parsed HOSTNAME — an exact match
     * against a trusted allow-list — never a substring test: a
     * "https://evil-localhost.example.com" URL must not pass because it
     * merely CONTAINS "localhost".
     */
    private fun isTrustedOrigin(): Boolean {
        val url = urlProvider().trim()
        if (url.isBlank()) return false
        val scheme = url.substringBefore("://").lowercase()
        if (scheme != "https" && scheme != "http") return false
        val host = try {
            android.net.Uri.parse(url).host?.lowercase()
        } catch (e: Exception) {
            null
        } ?: return false

        val productionHost = "wildfire-observatory.onrender.com"
        if (host == productionHost) {
            // Production PWA is served over HTTPS only.
            return scheme == "https"
        }
        // Local development hosts (emulator loopback): http/https both fine.
        return host == "localhost" || host == "127.0.0.1" || host == "10.0.2.2"
    }

    // ========================
    // CAPABILITY DETECTION
    // ========================

    @JavascriptInterface
    fun isMeshSupported(): Boolean =
        isTrustedOrigin() && meshService != null && capabilityProvider()

    @JavascriptInterface
    fun getDeviceId(): String {
        if (!isTrustedOrigin()) return ""
        val existing = cachedDeviceId
        if (existing != null) return existing
        val generated = deviceIdProvider()
        cachedDeviceId = generated
        return generated
    }

    @JavascriptInterface
    fun getPublicKey(): String {
        if (!isTrustedOrigin()) return ""
        return try {
            CryptoEngine.getPublicKeyBase64()
        } catch (e: Exception) {
            Log.w(TAG, "Public key requested before CryptoEngine initialization")
            ""
        }
    }

    @JavascriptInterface
    fun getIdentityKey(): String {
        if (!isTrustedOrigin()) return ""
        return try {
            CryptoEngine.getIdentityPublicKeyBase64()
        } catch (e: Exception) {
            Log.w(TAG, "Identity key requested before CryptoEngine initialization")
            ""
        }
    }

    // ========================
    // MESSAGING
    // ========================

    /**
     * Encrypt and broadcast a message to the mesh network.
     * @param plaintext The message content
     * @param type Message type (report, echo)
     * @param lat Latitude of the sender
     * @param lng Longitude of the sender
     */
    @JavascriptInterface
    fun broadcastMessage(plaintext: String, type: String, lat: Double, lng: Double): Boolean {
        if (!isTrustedOrigin()) return false
        // Type whitelist (audit round 11): the type travels pipe-joined on the
        // wire; arbitrary strings could corrupt framing (defense-in-depth —
        // parseFrame now rejects pipes too) and would muddy relay routing.
        // (Audit round 12: MESSAGE_TYPE_REPUTATION removed from the surface —
        // the protocol has no reputation-message handling, so advertising the
        // type was a dead branch. Reputation is scored from report/echo
        // traffic only.)
        if (type !in ALLOWED_MESSAGE_TYPES) return false
        if (!lat.isFinite() || !lng.isFinite() || lat !in -90.0..90.0 || lng !in -180.0..180.0) {
            Log.w(TAG, "Rejecting broadcast with invalid coordinates")
            return false
        }
        return meshService?.broadcastMessage(plaintext, type, lat, lng) == true
    }

    /**
     * Encrypt a message for a specific peer by their public key (E2EE).
     * @param peerPublicKey Base64-encoded ECDH (secp256r1 / P-256) public key
     * @param plaintext The message content
     * @return JSON string with { ciphertext, iv, signature, ephemeralId }
     */
    @JavascriptInterface
    fun encryptForPeer(peerPublicKey: String, plaintext: String, lat: Double, lng: Double): String {
        if (!isTrustedOrigin()) return ""
        if (!lat.isFinite() || !lng.isFinite() || lat !in -90.0..90.0 || lng !in -180.0..180.0) return ""
        val plaintextBytes = plaintext.toByteArray(Charsets.UTF_8)
        if (plaintextBytes.size > MeshService.MAX_PLAINTEXT_BYTES) return ""
        return try {
            val messageId = UUID.randomUUID().toString()
            val secureMsg = CryptoEngine.encryptForPeer(
                peerPublicKeyBase64 = peerPublicKey,
                payload = plaintextBytes,
                lat = lat,
                lng = lng,
                messageId = messageId,
                type = MeshService.MESSAGE_TYPE_REPORT,
                hopCount = 0
            )
            JSONObject().apply {
                put("ciphertext", secureMsg.ciphertext)
                put("iv", secureMsg.iv)
                put("signature", secureMsg.signature)
                put("ephemeralId", secureMsg.ephemeralId)
                put("senderPublicKey", secureMsg.senderPublicKey)
                put("timestamp", secureMsg.timestamp)
                put("lat", secureMsg.lat)
                put("lng", secureMsg.lng)
                put("nonce", secureMsg.nonce)
                put("messageId", secureMsg.messageId)
                put("type", secureMsg.type)
                put("hopCount", secureMsg.hopCount)
            }.toString()
        } catch (e: Exception) {
            Log.e(TAG, "encryptForPeer failed", e)
            ""
        }
    }

    /**
     * Decrypt a message from a peer (E2EE).
     * @param jsonMessage JSON string with SecureMessage fields
     * @param peerPublicKey Optional public key of sender
     * @return Decrypted plaintext, or empty string on failure
     */
    @JavascriptInterface
    fun decryptFromPeer(jsonMessage: String, peerPublicKey: String?): String {
        if (!isTrustedOrigin()) return ""
        if (jsonMessage.toByteArray(Charsets.UTF_8).size > MeshService.MAX_BRIDGE_JSON_BYTES) return ""
        return try {
            val json = JSONObject(jsonMessage)
            if (!json.has("lat") || !json.has("lng") || !json.has("type")) return ""
            val lat = json.getDouble("lat")
            val lng = json.getDouble("lng")
            val type = json.getString("type")
            if (!lat.isFinite() || !lng.isFinite() || lat !in -90.0..90.0 || lng !in -180.0..180.0) return ""
            if (type !in ALLOWED_MESSAGE_TYPES) return ""
            val msg = CryptoEngine.SecureMessage(
                ephemeralId = json.getString("ephemeralId"),
                senderPublicKey = json.getString("senderPublicKey"),
                ciphertext = json.getString("ciphertext"),
                iv = json.optString("iv", ""),
                signature = json.getString("signature"),
                timestamp = json.getLong("timestamp"),
                lat = lat,
                lng = lng,
                nonce = json.getInt("nonce"),
                messageId = json.getString("messageId"),
                type = type,
                hopCount = json.getInt("hopCount")
            )
            val decrypted = CryptoEngine.decryptFromPeer(msg, peerPublicKey)
            if (decrypted == null || decrypted.size > MeshService.MAX_PLAINTEXT_BYTES) ""
            else String(decrypted, Charsets.UTF_8)
        } catch (e: Exception) {
            ""
        }
    }

    // ========================
    // PEER MANAGEMENT
    // ========================

    /**
     * Get all currently connected peers with reputation scores.
     * @return JSON array: [{ endpointId, publicKey, lastSeen, reputation }]
     * (audit round 12: the old ephemeralId/hopCount peer fields were never
     * populated from a real source and are gone; the public key is the peer
     * identity.)
     */
    @JavascriptInterface
    fun getConnectedPeers(): String {
        if (!isTrustedOrigin()) return "[]"
        val peers = meshService?.getConnectedPeers() ?: emptyList()
        val arr = JSONArray()
        peers.forEach { peer ->
            arr.put(JSONObject(peer))
        }
        return arr.toString()
    }

    /**
     * Get reputation score of a specific peer.
     */
    @JavascriptInterface
    fun getPeerReputation(endpointId: String): Int {
        if (!isTrustedOrigin()) return 0
        return meshService?.getReputation(endpointId) ?: 0
    }

    // ========================
    // CRYPTO UTILITIES
    // ========================

    /**
     * Solve a Proof-of-Work challenge (anti-spam).
     * @param prefix Challenge string
     * @param difficulty Number of leading zero bits required
     * @return Nonce solution
     */
    @JavascriptInterface
    fun solvePoW(prefix: String, difficulty: Int): Int {
        if (!isTrustedOrigin()) return -1
        if (difficulty != MeshService.PO_W_DIFFICULTY) return -1
        // -1 on budget exhaustion: mesh broadcast handles it without crashing.
        return MeshWire.ProofOfWork.solve(prefix, difficulty) ?: -1
    }

    /**
     * Verify a Proof-of-Work solution.
     */
    @JavascriptInterface
    fun verifyPoW(prefix: String, nonce: Int, difficulty: Int): Boolean {
        if (!isTrustedOrigin()) return false
        if (difficulty != MeshService.PO_W_DIFFICULTY) return false
        return MeshWire.ProofOfWork.verify(prefix, nonce, difficulty)
    }

    // ========================
    // TEAM TRACKING (Phase 2) — native foreground-service GPS surface
    // ========================

    /**
     * Feature probe for the member panel. True when this build carries the
     * TeamLocationService surface; actual readiness (fine-location grant) is
     * answered by the prerequisite check so the panel can guide the user.
     */
    @JavascriptInterface
    fun isTeamTrackingSupported(): Boolean = isTrustedOrigin()

    /**
     * Pre-flight for startTeamTracking: "ok" when the FGS can legally start
     * right now, otherwise a machine-readable reason the panel renders as
     * guidance (the fix is a system-settings action, not a retry).
     */
    @JavascriptInterface
    fun teamTrackingPrerequisite(): String {
        if (!isTrustedOrigin()) return "unsupported"
        val context = appContext ?: return "unsupported"
        val fineGranted = ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        return if (fineGranted) "ok" else "missing-fine-location"
    }

    /**
     * Start the team-location FGS with the panel's session config. The JSON
     * is validated NATIVELY (allow-listed base URL, sane token, id shapes,
     * interval clamp) inside TeamLocationService.parseConfig — a false return
     * here means "refused", and the panel shows the prerequisite hint.
     *
     * S3 (defense in depth): the FINE-location check happens HERE, before the
     * FGS clock starts — returning true for a start that could only die inside
     * onStartCommand was a false promise to the panel. The service keeps its
     * own last-line check (F1) because the permission state can change between
     * this call and the service's entry.
     *
     * The token travels this bridge exactly once; the service keeps it in
     * memory only and the beats go directly to the server from native code,
     * so no heartbeat (and no token) ever round-trips through JS again.
     */
    @JavascriptInterface
    fun startTeamTracking(configJson: String): Boolean {
        if (!isTrustedOrigin()) return false
        val context = appContext ?: return false
        if (configJson.length > 4096) return false
        val fineGranted = ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        if (!fineGranted) return false
        val intent = Intent(context, TeamLocationService::class.java)
            .setAction(TeamLocationService.ACTION_START)
            .putExtra(TeamLocationService.EXTRA_CONFIG, configJson)
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
            true
        } catch (e: Exception) {
            Log.w(TAG, "startTeamTracking refused", e)
            false
        }
    }

    /**
     * F4 (A3/P3): synchronous answer to "is the FGS alive and owning the GPS
     * stream right now". A re-mounted panel queries this on mount — the
     * "started" event fired long ago and the panel must not double-stream
     * beside the native service while guessing.
     */
    @JavascriptInterface
    fun isTeamTrackingActive(): Boolean {
        if (!isTrustedOrigin()) return false
        return TeamLocationService.isServiceActive()
    }

    /** Stop the team-location FGS (panel button or member leaving the team). */
    @JavascriptInterface
    fun stopTeamTracking() {
        if (!isTrustedOrigin()) return
        val context = appContext ?: return
        try {
            context.stopService(Intent(context, TeamLocationService::class.java))
        } catch (e: Exception) {
            Log.w(TAG, "stopTeamTracking error", e)
        }
    }

    /**
     * Phase 3: open the mission target in the device's navigation app. The
     * JSON payload is validated NATIVELY — finite doubles inside the
     * North-Africa coverage bounds (the server's NA_BOUNDS mirror) — and the
     * geo: intent is BUILT from those doubles only; the WebView never hands a
     * raw URL across this bridge. Fallback to the Google Maps web URL when no
     * geo-capable activity resolves; both startActivity calls catch their own
     * failure so the panel can surface an honest message (no
     * resolveActivity probing — API 30+ package-visibility filtering makes it
     * unreliable, and the manifest stays free of <queries> entries).
     */
    @JavascriptInterface
    fun openNavigation(targetJson: String): Boolean {
        if (!isTrustedOrigin()) return false
        if (targetJson.length > 256) return false
        val context = appContext ?: return false
        return try {
            val json = JSONObject(targetJson)
            val lat = json.optDouble("lat", Double.NaN)
            val lng = json.optDouble("lng", Double.NaN)
            if (!lat.isFinite() || !lng.isFinite()) return false
            if (lat < 19.0 || lat > 38.0 || lng < -18.0 || lng > 25.0) return false
            try {
                context.startActivity(
                    Intent(Intent.ACTION_VIEW, Uri.parse("geo:$lat,$lng?q=$lat,$lng"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
                true
            } catch (e: ActivityNotFoundException) {
                try {
                    context.startActivity(
                        Intent(
                            Intent.ACTION_VIEW,
                            Uri.parse("https://www.google.com/maps/dir/?api=1&destination=$lat,$lng&travelmode=driving")
                        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    )
                    true
                } catch (e2: Exception) {
                    Log.w(TAG, "openNavigation: no navigation target available", e2)
                    false
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "openNavigation refused", e)
            false
        }
    }
}
