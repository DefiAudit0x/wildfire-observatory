package com.observatory.wildfire

import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject

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
    private val deviceIdProvider: () -> String = { "" }
) {

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

        val productionHost = "wildfire-observatory-production.up.railway.app"
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
    fun isMeshSupported(): Boolean = isTrustedOrigin()

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
    fun getPublicKey(): String = if (isTrustedOrigin()) CryptoEngine.getPublicKeyBase64() else ""

    @JavascriptInterface
    fun getIdentityKey(): String = if (isTrustedOrigin()) CryptoEngine.getIdentityPublicKeyBase64() else ""

    // ========================
    // MESSAGING
    // ========================

    /**
     * Encrypt and broadcast a message to the mesh network.
     * @param plaintext The message content
     * @param type Message type (report, echo, reputation)
     * @param lat Latitude of the sender
     * @param lng Longitude of the sender
     */
    @JavascriptInterface
    fun broadcastMessage(plaintext: String, type: String, lat: Double, lng: Double) {
        if (!isTrustedOrigin()) return
        // Type whitelist (audit round 11): the type travels pipe-joined on the
        // wire; arbitrary strings could corrupt framing (defense-in-depth —
        // parseFrame now rejects pipes too) and would muddy relay routing.
        if (type !in setOf(MeshService.MESSAGE_TYPE_REPORT, MeshService.MESSAGE_TYPE_ECHO, MeshService.MESSAGE_TYPE_REPUTATION)) return
        meshService?.broadcastMessage(plaintext, type, lat, lng)
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
        val secureMsg = CryptoEngine.encryptForPeer(
            peerPublicKeyBase64 = peerPublicKey,
            payload = plaintext.toByteArray(Charsets.UTF_8),
            lat = lat,
            lng = lng
        )
        return JSONObject().apply {
            put("ciphertext", secureMsg.ciphertext)
            put("iv", secureMsg.iv)
            put("signature", secureMsg.signature)
            put("ephemeralId", secureMsg.ephemeralId)
            put("senderPublicKey", secureMsg.senderPublicKey)
            put("timestamp", secureMsg.timestamp)
            put("lat", secureMsg.lat)
            put("lng", secureMsg.lng)
            put("nonce", secureMsg.nonce)
        }.toString()
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
        return try {
            val json = JSONObject(jsonMessage)
            val msg = CryptoEngine.SecureMessage(
                ephemeralId = json.getString("ephemeralId"),
                senderPublicKey = json.getString("senderPublicKey"),
                ciphertext = json.getString("ciphertext"),
                iv = json.optString("iv", ""),
                signature = json.getString("signature"),
                timestamp = json.getLong("timestamp"),
                lat = json.optDouble("lat", 0.0),
                lng = json.optDouble("lng", 0.0),
                nonce = json.getInt("nonce"),
                // Signed-metadata fields (audit): absent (sender is an older
                // web layer) → defaults to empty/0, which is what the sender
                // signed over; present → verified against them.
                messageId = json.optString("messageId", ""),
                type = json.optString("type", ""),
                hopCount = json.optInt("hopCount", 0)
            )
            val decrypted = CryptoEngine.decryptFromPeer(msg, peerPublicKey)
            if (decrypted != null) String(decrypted, Charsets.UTF_8) else ""
        } catch (e: Exception) {
            ""
        }
    }

    // ========================
    // PEER MANAGEMENT
    // ========================

    /**
     * Get all currently connected peers with reputation scores.
     * @return JSON array: [{ endpointId, ephemeralId, lastSeen, reputation, hopCount }]
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
        // -1 on budget exhaustion: mesh broadcast handles it without crashing.
        return MeshWire.ProofOfWork.solve(prefix, difficulty) ?: -1
    }

    /**
     * Verify a Proof-of-Work solution.
     */
    @JavascriptInterface
    fun verifyPoW(prefix: String, nonce: Int, difficulty: Int): Boolean {
        if (!isTrustedOrigin()) return false
        return MeshWire.ProofOfWork.verify(prefix, nonce, difficulty)
    }
}
