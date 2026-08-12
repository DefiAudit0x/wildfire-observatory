package com.observatory.wildfire

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
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
 * Multi-layer encryption engine for mesh messaging (audit round):
 * - ECDH over secp256r1 (P-256) for key exchange (E2EE) — NOT X25519: the
 *   implementation has always key-agreed on ECGenParameterSpec("secp256r1"),
 *   so the header now says what the code does (a doc claiming X25519 would
 *   mislead any security review).
 * - ECDSA (secp256r1) for digital signatures
 * - AES-256-GCM for message encryption
 * - Ephemeral key rotation
 *
 * Signature scope (audit): signatures bound the CIPHERTEXT, the IV and every
 * relay-invariant metadata field via MeshWire.buildSignedData — a relay can
 * no longer alter lat/lng/type/nonce/messageId/origPubKey on the wire while
 * the ECDSA signature stays valid.
 */
object CryptoEngine {

    private const val AES_KEY_SIZE = 256
    private const val GCM_IV_LENGTH = 12
    private const val GCM_TAG_LENGTH = 128
    private const val EC_ALGORITHM = "EC"
    private const val KEY_EXCHANGE_ALGORITHM = "ECDH"
    private const val SIGNATURE_ALGORITHM = "SHA256withECDSA"
    private const val PROVIDER = "BC"

    private const val IDENTITY_KEYSTORE_ALIAS = "wildfire_observatory_identity"
    private const val IDENTITY_PREFS = "mesh_crypto_identity"
    private const val IDENTITY_PUB_KEY = "identity_pub_b64"
    private const val IDENTITY_PRIV_KEY = "identity_priv_b64"

    // Ephemeral identity — rotated periodically
    private var ephemeralKeyPair: KeyPair? = null
    private var ephemeralId: String = ""
    private var lastEphemeralRotation: Long = 0L
    private const val EPHEMERAL_ROTATION_MS = 60 * 60 * 1000L // 1 hour

    /**
     * An atomic snapshot of the CURRENT ephemeral keys (audit round 11): the
     * old code read ephemeralId and the public key in SEPARATE synchronized
     * calls, and callers (MeshService.broadcastMessage) read them in yet
     * another call — a rotation between any two reads produced a message
     * whose (id, publicKey, PoW prefix, signature) referenced different key
     * material, making peers reject it. Everything that must be consistent
     * — PoW prefix, origEphemeralId, origPublicKey, ECDH key, signature —
     * is now taken from ONE [EphemeralSnapshot] captured atomically.
     */
    data class EphemeralSnapshot(
        val keyPair: KeyPair,
        val ephemeralId: String,
        val publicKeyB64: String
    )

    // Long-term identity — PERSISTENT ACROSS RESTARTS AND REBOOTS (audit):
    // backed by Android Keystore (API 26+, minSdk 26) when available — the
    // private key is generated inside the keystore and is NON-EXPORTABLE, so
    // it never lives in app files or SharedPreferences. The SharedPreferences
    // path is a fallback for keystore-less environments (some emulators) and
    // logs a warning — plaintext private keys in app data are a last resort,
    // not the default storage.
    //
    // Role decision (audit round 11): the identity key deliberately signs
    // NOTHING on the wire. Message signatures use the rotating ephemeral key
    // so relay-hop messages cannot be correlated back to a device across
    // rotation windows (privacy). The identity key exists for future
    // device-level attestation (e.g. binding an ephemeral key to a device
    // identity in a handshake); getIdentityPublicKeyBase64() exposes only
    // the public half.
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
        val nonce: Int,              // anti-replay
        val messageId: String = "",  // signed (relay-invariant)
        val type: String = "",       // signed (relay-invariant)
        val hopCount: Int = 0        // signed (relay-invariant; always 0 — see MeshWire)
    )

    fun initialize(context: Context) {
        if (identityKeyPair == null) {
            identityKeyPair = loadOrCreateIdentityKeyPair(context)
        }
        rotateEphemeralKey()
    }

    private fun loadOrCreateIdentityKeyPair(context: Context): KeyPair {
        // Primary path: Android Keystore (API 26+, minSdk 26). The key is
        // generated inside the keystore; getKeyPair() hands back the PUBLIC
        // key and a non-exportable PrivateKey handle. The private key never
        // leaves the keystore (audit round 11: the previous implementation
        // stored the raw PKCS#8 private key in SharedPreferences — plaintext
        // key material in app data).
        try {
            val ks = KeyStore.getInstance("AndroidKeyStore")
            ks.load(null)
            if (ks.containsAlias(IDENTITY_KEYSTORE_ALIAS)) {
                val priv = ks.getKey(IDENTITY_KEYSTORE_ALIAS, null) as PrivateKey
                val pub = ks.getCertificate(IDENTITY_KEYSTORE_ALIAS).publicKey
                return KeyPair(pub, priv)
            }
            val kpg = KeyPairGenerator.getInstance(EC_ALGORITHM, "AndroidKeyStore")
            kpg.initialize(
                KeyGenParameterSpec.Builder(
                    IDENTITY_KEYSTORE_ALIAS,
                    KeyProperties.PURPOSE_SIGN
                )
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .build()
            )
            val kp = kpg.generateKeyPair()
            // NOTE: some OEM/emulator keystores return null for the private
            // half of a freshly generated pair via getKeyPair(); back the
            // pair with the aliased key material directly.
            return KeyPair(kp.public, ks.getKey(IDENTITY_KEYSTORE_ALIAS, null) as PrivateKey)
        } catch (e: Exception) {
            android.util.Log.w("CryptoEngine", "AndroidKeyStore unavailable, falling back to SharedPreferences", e)
        }

        // Fallback path (keystore-less emulators/devices): SharedPreferences
        // with a loud warning — plaintext key material should never be the
        // production default (audit round 11: the keystore is primary now).
        val prefs = context.getSharedPreferences(IDENTITY_PREFS, Context.MODE_PRIVATE)
        val pubB64 = prefs.getString(IDENTITY_PUB_KEY, null)
        val privB64 = prefs.getString(IDENTITY_PRIV_KEY, null)
        if (pubB64 != null && privB64 != null) {
            try {
                val pubKey = KeyFactory.getInstance(EC_ALGORITHM, PROVIDER)
                    .generatePublic(X509EncodedKeySpec(Base64.decode(pubB64, Base64.NO_WRAP)))
                val privKey = KeyFactory.getInstance(EC_ALGORITHM, PROVIDER)
                    .generatePrivate(PKCS8EncodedKeySpec(Base64.decode(privB64, Base64.NO_WRAP)))
                return KeyPair(pubKey, privKey)
            } catch (e: Exception) {
                // Corrupt/partial stored identity: regenerate below.
                android.util.Log.w("CryptoEngine", "Stored identity unusable, regenerating", e)
            }
        }
        val fresh = generateECKeyPair()
        // commit() instead of apply() (audit): a process death between the
        // async apply() flush and the write would silently drop a freshly
        // generated identity, i.e. the device would rotate its identity by
        // accident. This write is one-time per install — a synchronous
        // commit is negligible there.
        prefs.edit()
            .putString(IDENTITY_PUB_KEY, Base64.encodeToString(fresh.public.encoded, Base64.NO_WRAP))
            .putString(IDENTITY_PRIV_KEY, Base64.encodeToString(fresh.private.encoded, Base64.NO_WRAP))
            .commit()
        return fresh
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

    /**
     * Atomically capture the CURRENT ephemeral (id + public key + keypair) in
     * one synchronized call (audit round 11): a caller needing a consistent
     * (id, key, PoW prefix, signature) must use ONE snapshot instead of
     * calling getEphemeralId()/getPublicKeyBase64() separately — rotation
     * between those calls was producing frames whose fields referenced
     * different key material.
     */
    @Synchronized
    fun getEphemeralSnapshot(): EphemeralSnapshot {
        rotateIfNeeded()
        val pair = ephemeralKeyPair ?: run {
            rotateEphemeralKey()
            ephemeralKeyPair!!
        }
        return EphemeralSnapshot(
            keyPair = pair,
            ephemeralId = ephemeralId,
            publicKeyB64 = Base64.encodeToString(pair.public.encoded, Base64.NO_WRAP)
        )
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
     * 4. Sign the ciphertext, IV and EVERY relay-invariant metadata field
     *    (MeshWire.buildSignedData) with our ECDSA key — a relay that
     *    changes lat/lng/type/messageId/nonce on the wire invalidates the
     *    signature instead of silently re-labeling the message.
     *
     * Audit (round 11): the signature and the emitted SecureMessage now use
     * the SAME timestamp value and the SAME ephemeral key material. The old
     * code called System.currentTimeMillis() twice (once inside the signed
     * data, once for the message field) and re-read the ephemeral id/key —
     * any clock tick or rotation between those reads made the receiver's
     * signature verification fail with a valid-looking message.
     */
    @Synchronized
    fun encryptForPeer(
        peerPublicKeyBase64: String,
        payload: ByteArray,
        lat: Double,
        lng: Double,
        messageId: String = "",
        type: String = "",
        hopCount: Int = 0
    ): SecureMessage {
        return encryptForPeerWithSnapshot(
            getEphemeralSnapshot(),
            peerPublicKeyBase64,
            payload,
            lat,
            lng,
            messageId,
            type,
            hopCount
        )
    }

    /**
     * Snapshot-pinned variant (audit round 11): encrypt with the EXACT
     * ephemeral material a caller already captured via [getEphemeralSnapshot]
     * — broadcastMessage builds its PoW prefix from that snapshot's id, and
     * the frame must be encrypted + signed with the matching keypair, or a
     * border-line rotation would yield an id/key mismatch that every peer
     * would reject. All of these are consistent because they derive from one
     * snapshot object.
     */
    @Synchronized
    fun encryptForPeerWithSnapshot(
        snapshot: EphemeralSnapshot,
        peerPublicKeyBase64: String,
        payload: ByteArray,
        lat: Double,
        lng: Double,
        messageId: String = "",
        type: String = "",
        hopCount: Int = 0
    ): SecureMessage {
        val peerPublicKey = decodePublicKey(peerPublicKeyBase64)
        val sharedSecret = ecdhKeyAgreement(snapshot.keyPair.private, peerPublicKey)
        val aesKey = deriveAESKey(sharedSecret)

        // Encrypt
        val iv = ByteArray(GCM_IV_LENGTH).apply { Random.nextBytes(this) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding", PROVIDER)
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(aesKey, "AES"), GCMParameterSpec(GCM_TAG_LENGTH, iv))
        val ciphertext = cipher.doFinal(payload)
        val nonce = Random.nextInt()

        // ONE timestamp for both the signature and the message (audit): a
        // second now-call between the two would desync the signed value from
        // the transmitted value and fail verification at the receiver.
        val timestamp = System.currentTimeMillis()

        // Sign canonical metadata (audit) — not just ciphertext+iv.
        val signature = signData(
            MeshWire.buildSignedData(
                ciphertext = ciphertext,
                iv = iv,
                messageId = messageId,
                type = type,
                hopCount = hopCount,
                origEphemeralId = snapshot.ephemeralId,
                origPublicKey = snapshot.publicKeyB64,
                timestamp = timestamp,
                nonce = nonce,
                lat = lat,
                lng = lng
            ),
            snapshot.keyPair.private
        )

        return SecureMessage(
            ephemeralId = snapshot.ephemeralId,
            senderPublicKey = snapshot.publicKeyB64,
            ciphertext = Base64.encodeToString(ciphertext, Base64.NO_WRAP),
            iv = Base64.encodeToString(iv, Base64.NO_WRAP),
            signature = Base64.encodeToString(signature, Base64.NO_WRAP),
            timestamp = timestamp,
            lat = lat,
            lng = lng,
            nonce = nonce,
            messageId = messageId,
            type = type,
            hopCount = hopCount
        )
    }

    /**
     * Decrypt a message from a peer:
     * 1. Verify ECDSA signature over the canonical metadata
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

            // Verify signature over the canonical metadata (same bytes both sides)
            val ciphertext = Base64.decode(message.ciphertext, Base64.NO_WRAP)
            val iv = Base64.decode(message.iv, Base64.NO_WRAP)
            val signature = Base64.decode(message.signature, Base64.NO_WRAP)
            val signData = MeshWire.buildSignedData(
                ciphertext = ciphertext,
                iv = iv,
                messageId = message.messageId,
                type = message.type,
                hopCount = message.hopCount,
                origEphemeralId = message.ephemeralId,
                origPublicKey = message.senderPublicKey,
                timestamp = message.timestamp,
                nonce = message.nonce,
                lat = message.lat,
                lng = message.lng
            )

            if (!verifySignature(signData, signature, peerPublicKey)) {
                throw SecurityException("ECDSA signature verification failed — message or metadata may be tampered")
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

    /**
     * Verify the ECDSA signature over the canonical signed metadata using the
     * sender's public key. Any relay can run this — no AES key required —
     * and MUST reject messages whose wire signature does not match, which
     * also covers the metadata (lat/lng/type/nonce/messageId can no longer
     * be altered in transit).
     */
    fun verifyMessageSignature(message: SecureMessage): Boolean {
        return try {
            val ciphertext = Base64.decode(message.ciphertext, Base64.NO_WRAP)
            val iv = Base64.decode(message.iv, Base64.NO_WRAP)
            val signature = Base64.decode(message.signature, Base64.NO_WRAP)
            verifySignature(
                MeshWire.buildSignedData(
                    ciphertext = ciphertext,
                    iv = iv,
                    messageId = message.messageId,
                    type = message.type,
                    hopCount = message.hopCount,
                    origEphemeralId = message.ephemeralId,
                    origPublicKey = message.senderPublicKey,
                    timestamp = message.timestamp,
                    nonce = message.nonce,
                    lat = message.lat,
                    lng = message.lng
                ),
                signature,
                decodePublicKey(message.senderPublicKey)
            )
        } catch (e: Exception) {
            false
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
}
