package com.observatory.wildfire

import android.util.Base64
import java.security.*
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.random.Random

/**
 * Multi-layer encryption engine for mesh messaging:
 * - X25519 ECDH for key exchange (E2EE)
 * - ECDSA (secp256r1) for digital signatures
 * - AES-256-GCM for message encryption
 * - Ephemeral key rotation
 */
object CryptoEngine {

    private const val AES_KEY_SIZE = 256
    private const val GCM_IV_LENGTH = 12
    private const val GCM_TAG_LENGTH = 128
    private const val EC_ALGORITHM = "EC"
    private const val KEY_EXCHANGE_ALGORITHM = "ECDH"
    private const val SIGNATURE_ALGORITHM = "SHA256withECDSA"
    private const val PROVIDER = "BC"

    // Ephemeral identity — rotated periodically
    private var ephemeralKeyPair: KeyPair? = null
    private var ephemeralId: String = ""
    private var lastEphemeralRotation: Long = 0L
    private const val EPHEMERAL_ROTATION_MS = 60 * 60 * 1000L // 1 hour

    // Long-term identity (persistent per install)
    private var identityKeyPair: KeyPair? = null

    data class SecureMessage(
        val ephemeralId: String,
        val senderPublicKey: String, // base64 encoded
        val ciphertext: String,      // base64 encoded AES-256-GCM
        val iv: String,              // base64 encoded IV
        val signature: String,       // base64 encoded ECDSA signature
        val timestamp: Long,
        val lat: Double,
        val lng: Double,
        val nonce: Int               // anti-replay
    )

    fun initialize() {
        if (identityKeyPair == null) {
            identityKeyPair = generateECKeyPair()
        }
        rotateEphemeralKey()
    }

    @Synchronized
    fun getEphemeralId(): String {
        rotateIfNeeded()
        return ephemeralId
    }

    @Synchronized
    fun getPublicKeyBase64(): String {
        rotateIfNeeded()
        return Base64.encodeToString(ephemeralKeyPair!!.public.encoded, Base64.NO_WRAP)
    }

    @Synchronized
    fun getIdentityPublicKeyBase64(): String {
        return Base64.encodeToString(identityKeyPair!!.public.encoded, Base64.NO_WRAP)
    }

    @Synchronized
    fun rotateEphemeralKey() {
        ephemeralKeyPair = generateECKeyPair()
        ephemeralId = generateRandomId()
        lastEphemeralRotation = System.currentTimeMillis()
    }

    private fun rotateIfNeeded() {
        if (System.currentTimeMillis() - lastEphemeralRotation > EPHEMERAL_ROTATION_MS) {
            rotateEphemeralKey()
        }
    }

    /**
     * Encrypt a message for a specific peer using E2EE:
     * 1. ECDH key agreement with peer's public key → shared secret
     * 2. Derive AES-256 key from shared secret
     * 3. Encrypt payload with AES-256-GCM
     * 4. Sign the ciphertext with our ECDSA key
     */
    @Synchronized
    fun encryptForPeer(
        peerPublicKeyBase64: String,
        payload: ByteArray,
        lat: Double,
        lng: Double
    ): SecureMessage {
        rotateIfNeeded()

        val peerPublicKey = decodePublicKey(peerPublicKeyBase64)
        val sharedSecret = ecdhKeyAgreement(ephemeralKeyPair!!.private, peerPublicKey)
        val aesKey = deriveAESKey(sharedSecret)

        // Encrypt
        val iv = ByteArray(GCM_IV_LENGTH).apply { Random.nextBytes(this) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding", PROVIDER)
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(aesKey, "AES"), GCMParameterSpec(GCM_TAG_LENGTH, iv))
        val ciphertext = cipher.doFinal(payload)

        // Sign
        val signData = ciphertext + iv
        val signature = signData(signData, ephemeralKeyPair!!.private)

        return SecureMessage(
            ephemeralId = ephemeralId,
            senderPublicKey = getPublicKeyBase64(),
            ciphertext = Base64.encodeToString(ciphertext, Base64.NO_WRAP),
            iv = Base64.encodeToString(iv, Base64.NO_WRAP),
            signature = Base64.encodeToString(signature, Base64.NO_WRAP),
            timestamp = System.currentTimeMillis(),
            lat = lat,
            lng = lng,
            nonce = Random.nextInt()
        )
    }

    /**
     * Decrypt a message from a peer:
     * 1. Verify ECDSA signature
     * 2. ECDH key agreement → shared secret
     * 3. Derive AES-256 key
     * 4. Decrypt AES-256-GCM
     */
    @Synchronized
    fun decryptFromPeer(
        message: SecureMessage,
        peerPublicKeyBase64: String? = null
    ): ByteArray? {
        return try {
            val pubKeyB64 = peerPublicKeyBase64 ?: message.senderPublicKey
            val peerPublicKey = decodePublicKey(pubKeyB64)

            // Verify signature
            val ciphertext = Base64.decode(message.ciphertext, Base64.NO_WRAP)
            val iv = Base64.decode(message.iv, Base64.NO_WRAP)
            val signature = Base64.decode(message.signature, Base64.NO_WRAP)
            val signData = ciphertext + iv

            if (!verifySignature(signData, signature, peerPublicKey)) {
                throw SecurityException("ECDSA signature verification failed — message may be tampered")
            }

            // Decrypt
            val sharedSecret = ecdhKeyAgreement(ephemeralKeyPair!!.private, peerPublicKey)
            val aesKey = deriveAESKey(sharedSecret)

            val cipher = Cipher.getInstance("AES/GCM/NoPadding", PROVIDER)
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(aesKey, "AES"), GCMParameterSpec(GCM_TAG_LENGTH, iv))
            cipher.doFinal(ciphertext)
        } catch (e: Exception) {
            android.util.Log.e("CryptoEngine", "Decryption failed", e)
            null
        }
    }

    private fun generateECKeyPair(): KeyPair {
        val kpg = KeyPairGenerator.getInstance(EC_ALGORITHM, PROVIDER)
        kpg.initialize(ECGenParameterSpec("secp256r1"), SecureRandom())
        return kpg.generateKeyPair()
    }

    private fun decodePublicKey(base64: String): PublicKey {
        val keyBytes = Base64.decode(base64, Base64.NO_WRAP)
        val spec = X509EncodedKeySpec(keyBytes)
        return KeyFactory.getInstance(EC_ALGORITHM, PROVIDER).generatePublic(spec)
    }

    private fun ecdhKeyAgreement(privateKey: PrivateKey, publicKey: PublicKey): ByteArray {
        val ka = KeyAgreement.getInstance(KEY_EXCHANGE_ALGORITHM, PROVIDER)
        ka.init(privateKey)
        ka.doPhase(publicKey, true)
        return ka.generateSecret()
    }

    private fun deriveAESKey(sharedSecret: ByteArray): ByteArray {
        val digest = MessageDigest.getInstance("SHA-256")
        return digest.digest(sharedSecret).copyOf(AES_KEY_SIZE / 8)
    }

    private fun signData(data: ByteArray, privateKey: PrivateKey): ByteArray {
        val sig = Signature.getInstance(SIGNATURE_ALGORITHM, PROVIDER)
        sig.initSign(privateKey)
        sig.update(data)
        return sig.sign()
    }

    private fun verifySignature(data: ByteArray, signature: ByteArray, publicKey: PublicKey): Boolean {
        val sig = Signature.getInstance(SIGNATURE_ALGORITHM, PROVIDER)
        sig.initVerify(publicKey)
        sig.update(data)
        return sig.verify(signature)
    }

    private fun generateRandomId(): String {
        val chars = "abcdefghijklmnopqrstuvwxyz0123456789"
        return (1..16).map { chars[Random.nextInt(chars.length)] }.joinToString("")
    }

    // Lightweight Proof-of-Work: find a nonce such that SHA-256(prefix + nonce) starts with 'difficulty' zero bits
    object ProofOfWork {
        fun solve(prefix: String, difficulty: Int = 8): Int {
            var nonce = 0
            val target = 1 shl (256 - difficulty)
            while (true) {
                val hash = sha256("$prefix$nonce")
                val value = hash.take(8).fold(0L) { acc, c -> (acc shl 4) + c.digitToInt(16) }
                if (value < target) return nonce
                nonce++
            }
        }

        fun verify(prefix: String, nonce: Int, difficulty: Int = 8): Boolean {
            val hash = sha256("$prefix$nonce")
            val value = hash.take(8).fold(0L) { acc, c -> (acc shl 4) + c.digitToInt(16) }
            return value < (1L shl (256 - difficulty))
        }

        private fun sha256(input: String): String {
            val digest = MessageDigest.getInstance("SHA-256")
            return digest.digest(input.toByteArray()).joinToString("") { "%02x".format(it) }
        }
    }
}
