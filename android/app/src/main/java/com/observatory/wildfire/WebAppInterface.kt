package com.observatory.wildfire

import android.util.Base64
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject

/**
 * JavaScript bridge exposed to the WebView as `window.AndroidBridge`.
 * Provides encrypted mesh messaging, key management, and device info.
 */
class WebAppInterface(private val meshService: MeshService) {

    // ========================
    // CAPABILITY DETECTION
    // ========================

    @JavascriptInterface
    fun isMeshSupported(): Boolean = true

    @JavascriptInterface
    fun getDeviceId(): String = meshService.getEphemeralId()

    @JavascriptInterface
    fun getPublicKey(): String = CryptoEngine.getPublicKeyBase64()

    @JavascriptInterface
    fun getIdentityKey(): String = CryptoEngine.getIdentityPublicKeyBase64()

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
        meshService.broadcastMessage(plaintext, type, lat, lng)
    }

    /**
     * Encrypt a message for a specific peer by their public key (E2EE).
     * @param peerPublicKey Base64-encoded X25519 public key
     * @param plaintext The message content
     * @return JSON string with { ciphertext, iv, signature, ephemeralId }
     */
    @JavascriptInterface
    fun encryptForPeer(peerPublicKey: String, plaintext: String, lat: Double, lng: Double): String {
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
                nonce = json.getInt("nonce")
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
        val peers = meshService.getConnectedPeers()
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
        return meshService.getReputation(endpointId)
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
        return CryptoEngine.ProofOfWork.solve(prefix, difficulty)
    }

    /**
     * Verify a Proof-of-Work solution.
     */
    @JavascriptInterface
    fun verifyPoW(prefix: String, nonce: Int, difficulty: Int): Boolean {
        return CryptoEngine.ProofOfWork.verify(prefix, nonce, difficulty)
    }

    /**
     * Generate an ECDSA signature for arbitrary data.
     * @param dataBase64 Data to sign (base64 encoded)
     * @return Base64-encoded signature
     */
    @JavascriptInterface
    fun signData(dataBase64: String): String {
        val data = Base64.decode(dataBase64, Base64.NO_WRAP)
        val keyPair = CryptoEngine::class.java.getDeclaredMethod("generateECKeyPair")
        keyPair.isAccessible = true
        // Use CryptoEngine's signing capability
        return android.util.Base64.encodeToString(
            java.security.Signature.getInstance("SHA256withECDSA", "BC").let { sig ->
                sig.initSign(
                    CryptoEngine::class.java.getDeclaredField("ephemeralKeyPair").apply {
                        isAccessible = true
                    }.get(null) as java.security.KeyPair
                )
                sig.update(data)
                sig.sign()
            },
            android.util.Base64.NO_WRAP
        )
    }
}
