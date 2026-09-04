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
 *
 * Provider policy (v1.0.3 field crash — NEVER pin a provider here): every
 * JCA factory below resolves through the DEFAULT provider list. The old
 * code pinned "BC" and MeshService.onCreate died on real devices with
 * NoSuchAlgorithmException: Android ships a STRIPPED BouncyCastle under the
 * name "BC" (no EC KeyPairGenerator), and the bundled full bcprov could
 * never take the name — Security.insertProviderAt returns -1 silently when
 * a provider with the same name exists — so getInstance("EC", "BC") always
 * hit the stripped one. The default list's first member, AndroidOpenSSL
 * (Conscrypt), provides EVERY algorithm used below — KeyPairGenerator EC,
 * KeyFactory EC, KeyAgreement ECDH, Signature SHA256withECDSA,
 * Cipher AES/GCM/NoPadding — hardware-accelerated on every API 26+ device.
 * Regression gate: CryptoProviderContractTest (JVM, self-validating).
 */
object CryptoEngine {

    private const val AES_KEY_SIZE = 256
    private val protocolRandom = SecureRandom()
    private const val GCM_IV_LENGTH = 12
    private const val GCM_TAG_LENGTH = 128
    private const val EC_ALGORITHM = "EC"
    private const val KEY_EXCHANGE_ALGORITHM = "ECDH"
    private const val SIGNATURE_ALGORITHM = "SHA256withECDSA"
    // Deliberately NO PROVIDER constant: see the class kdoc — pinning "BC"
    // crashed every real device (stripped OS BouncyCastle squats the name).

    private const val IDENTITY_KEYSTORE_ALIAS = "wildfire_observatory_identity"
    private const val IDENTITY_PREFS = "mesh_crypto_identity"
    private const val IDENTITY_PUB_KEY = "identity_pub_b64"
    private const val IDENTITY_PRIV_KEY = "identity_priv_b64"
    // v2.16.0 (audit wave 3): persisted identity-storage policy record.
    private const val IDENTITY_STORAGE_KEY = "identity_storage_mode"
    private const val IDENTITY_REGENERATED_KEY = "identity_regenerated"

    /**
     * v2.16.0 (audit wave 3 — legacy-key migration policy + prefs fallback
     * gating): the DECISION layer for identity-key storage, pure and
     * JVM-testable (IdentityKeyPolicyTest pins the full table).
     *
     * Policy (in force since the keystore became primary):
     *  1. CONTINUITY FIRST — an install that predates the keystore keeps its
     *     SharedPreferences identity. The legacy key is immutable-once-stored
     *     and re-importing software key material into AndroidKeyStore is not
     *     possible without a cert-generation strategy (documented in
     *     docs/ARCHITECTURE_ROADMAP.md as a Phase-2 upgrade), so "migration"
     *     here means: the legacy identity is EXPLICIT, recorded (identity_storage_mode
     *     = legacy_prefs), and loud — never silently treated as a defect.
     *  2. CORRUPTION IS AN EVENT — a stored legacy identity that fails to
     *     decode is kept on disk (forensics), never overwritten, and the
     *     regenerated identity is flagged (identity_regenerated = true).
     *  3. THE SOFTWARE FALLBACK IS GATED — plaintext key material in prefs
     *     happens ONLY when the keystore is genuinely unavailable (the gate:
     *     [softwareFallbackAllowed]), is recorded (mode = software_fallback),
     *     and is a one-time-per-install write so the identity is stable.
     */
    object IdentityKeyPolicy {
        enum class StorageMode { KEYSTORE, LEGACY_PREFS, SOFTWARE_FALLBACK }

        enum class Action {
            /** Upgrade continuity: reuse the pre-keystore prefs identity. */
            USE_LEGACY_IDENTITY,
            /** Keystore alias exists (or was just created) — the normal path. */
            USE_KEYSTORE_IDENTITY,
            /** Legacy identity present but undecodable — regenerate loudly. */
            REGENERATE_AFTER_CORRUPTION,
            /** Keystore unavailable — gated software fallback. */
            FALLBACK_TO_SOFTWARE
        }

        /** The decision table. Order matters: continuity beats regeneration,
         *  regeneration beats fresh minting, the fallback is last resort. */
        fun decide(
            legacyPresent: Boolean,
            legacyValid: Boolean,
            keystoreUsable: Boolean
        ): Action = when {
            legacyPresent && legacyValid -> Action.USE_LEGACY_IDENTITY
            legacyPresent && !legacyValid -> Action.REGENERATE_AFTER_CORRUPTION
            keystoreUsable -> Action.USE_KEYSTORE_IDENTITY
            else -> Action.FALLBACK_TO_SOFTWARE
        }

        /** The gate: software storage may ONLY follow a proven-unusable
         *  keystore — never a preference, never a convenience. */
        fun softwareFallbackAllowed(keystoreUsable: Boolean): Boolean = !keystoreUsable
    }

    // Ephemeral identity — rotated ONLY on explicit request (audit round 12):
    // the previous implementation auto-rotated inside every key getter, which
    // created TWO independent rotation clocks (CryptoEngine's getter timing
    // vs MeshService's advertising lifecycle) — a getter-triggered rotation
    // changed the signing/encryption key WITHOUT restarting Nearby, so the
    // device advertised key A while signing with key B. Rotation is now a
    // service-level decision (MeshService.trickleTick owns the single clock
    // and restarts Nearby presence on each rotation); CryptoEngine rotates
    // only when asked (rotateEphemeralKey / initialize).
    private var ephemeralKeyPair: KeyPair? = null
    private var ephemeralId: String = ""

    // Retired ephemeral keys (audit round 12): a message encrypted to our
    // CURRENT advertised key while we rotate in the middle of its transit
    // window must still be decryptable. decryptFromPeer therefore tries the
    // current key first, then each retired key in order. Bound: rotation
    // period (1h, service-owned) dwarfs MESSAGE_TTL_MS (10 min), so at most
    // one retired generation can host live in-transit ciphertext; 2 retained
    // keys cover the worst case with margin. (Wire-protocol alternative —
    // carrying a recipient-key id in the frame — was deferred: retention
    // deterministically covers the TTL window without a format change and
    // without leaking which key a recipient uses.)
    private val retiredEphemeralKeyPairs = ArrayDeque<KeyPair>()
    private const val MAX_RETIRED_EPHEMERAL_KEYS = 2

    /**
     * An atomic snapshot of the CURRENT ephemeral keys (audit round 11): the
     * old code read ephemeralId and the public key in SEPARATE synchronized
     * calls, and callers (MeshService.broadcastMessage) read them in yet
     * another call — a rotation between any two reads produced a message
     * whose (id, publicKey, PoW prefix, signature) referenced different key
     * material, making peers reject it. Everything that must be consistent
     * — PoW prefix, origEphemeralId, origPublicKey, ECDH key, signature —
     * is now taken from ONE [EphemeralSnapshot] captured atomically.
     *
     * The instance is IMMUTABLE and SHARED: every queued message of one key
     * generation references the SAME snapshot object (audit round 12 — no
     * per-message key material copies; memory burden of a queued message is
     * three references to the generation handle, and the bounded queue ≤
     * MAX_PENDING_MESSAGES can hold at most two generations at once because
     * the 1h rotation period dwarfs the 10-minute message TTL).
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
        // Identity CONTINUITY across the keystore migration (audit round 12):
        // installs that predate the AndroidKeyStore path stored the identity
        // in SharedPreferences. That legacy key is read FIRST — flipping the
        // primary storage to the keystore without a migration would mint a
        // BRAND-NEW identity on every upgrade (the keystore alias is absent
        // on the first post-upgrade launch), silently breaking any server-
        // side trust/history keyed on the old identity.
        // v2.16.0 (policy): every branch below records its storage mode +
        // regeneration flag (IdentityKeyPolicy kdoc) — the storage posture
        // of every install is now observable, not guessable from logs.
        val prefs = context.getSharedPreferences(IDENTITY_PREFS, Context.MODE_PRIVATE)
        val legacyPrivB64 = prefs.getString(IDENTITY_PRIV_KEY, null)
        val legacyPubB64 = prefs.getString(IDENTITY_PUB_KEY, null)
        var legacyCorrupt = false
        if (legacyPrivB64 != null && legacyPubB64 != null) {
            try {
                val pubKey = KeyFactory.getInstance(EC_ALGORITHM)
                    .generatePublic(X509EncodedKeySpec(Base64.decode(legacyPubB64, Base64.NO_WRAP)))
                val privKey = KeyFactory.getInstance(EC_ALGORITHM)
                    .generatePrivate(PKCS8EncodedKeySpec(Base64.decode(legacyPrivB64, Base64.NO_WRAP)))
                android.util.Log.i(
                    "CryptoEngine",
                    "Identity storage: LEGACY_PREFS (upgrade continuity — v2.16.0 policy USE_LEGACY_IDENTITY)"
                )
                recordIdentityStorage(context, IdentityKeyPolicy.StorageMode.LEGACY_PREFS, regenerated = false)
                return KeyPair(pubKey, privKey)
            } catch (e: Exception) {
                // v2.16.0 policy REGENERATE_AFTER_CORRUPTION: the undecodable
                // material is KEPT (forensics, never overwritten) and the
                // regeneration is flagged on disk.
                legacyCorrupt = true
                android.util.Log.w(
                    "CryptoEngine",
                    "Legacy stored identity unusable — policy REGENERATE_AFTER_CORRUPTION (kept on disk for forensics)", e
                )
            }
        }

        // Primary path for NEW installs: Android Keystore (API 26+, minSdk
        // 26). The key is generated inside the keystore; getKeyPair() hands
        // back the PUBLIC key and a non-exportable PrivateKey handle. The
        // private key never leaves the keystore (audit round 11: the legacy
        // path stored the raw PKCS#8 private key in SharedPreferences —
        // plaintext key material in app data).
        try {
            val ks = KeyStore.getInstance("AndroidKeyStore")
            ks.load(null)
            if (ks.containsAlias(IDENTITY_KEYSTORE_ALIAS)) {
                val priv = ks.getKey(IDENTITY_KEYSTORE_ALIAS, null) as PrivateKey
                val pub = ks.getCertificate(IDENTITY_KEYSTORE_ALIAS).publicKey
                recordIdentityStorage(context, IdentityKeyPolicy.StorageMode.KEYSTORE, regenerated = legacyCorrupt)
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
            recordIdentityStorage(context, IdentityKeyPolicy.StorageMode.KEYSTORE, regenerated = legacyCorrupt)
            return KeyPair(kp.public, ks.getKey(IDENTITY_KEYSTORE_ALIAS, null) as PrivateKey)
        } catch (e: Exception) {
            android.util.Log.w("CryptoEngine", "AndroidKeyStore unavailable", e)
        }

        // GATED fallback path (v2.16.0 policy): ONLY reachable when the
        // keystore path threw — the software gate
        // (IdentityKeyPolicy.softwareFallbackAllowed) demands exactly that.
        // SharedPreferences with a loud warning — plaintext key material is
        // a last resort, not the production default. (Legacy keys were
        // already consumed above; only a missing-clean install reaches this
        // point, so a fresh pair is generated.) commit() instead of apply()
        // (audit): a process death between the async apply() flush and the
        // write would silently drop a freshly generated identity, i.e. the
        // device would rotate its identity by accident. This write is
        // one-time per install — a synchronous commit is negligible there.
        check(IdentityKeyPolicy.softwareFallbackAllowed(keystoreUsable = false)) {
            "software identity fallback reached without a failed keystore path — policy gate violated"
        }
        val fresh = generateECKeyPair()
        prefs.edit()
            .putString(IDENTITY_PUB_KEY, Base64.encodeToString(fresh.public.encoded, Base64.NO_WRAP))
            .putString(IDENTITY_PRIV_KEY, Base64.encodeToString(fresh.private.encoded, Base64.NO_WRAP))
            .commit()
        recordIdentityStorage(context, IdentityKeyPolicy.StorageMode.SOFTWARE_FALLBACK, regenerated = legacyCorrupt)
        return fresh
    }

    /**
     * v2.16.0: persist + expose the identity-storage posture. Recorded on
     * every loadOrCreateIdentityKeyPair exit; readable via
     * [identityStorageMode] for diagnostics/telemetry.
     */
    private fun recordIdentityStorage(
        context: Context,
        mode: IdentityKeyPolicy.StorageMode,
        regenerated: Boolean
    ) {
        identityStorageModeField = mode.name
        identityRegeneratedField = regenerated
        runCatching {
            context.getSharedPreferences(IDENTITY_PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(IDENTITY_STORAGE_KEY, mode.name)
                .putBoolean(IDENTITY_REGENERATED_KEY, regenerated)
                .apply()
        }
    }

    @Volatile
    private var identityStorageModeField: String = "unknown"

    @Volatile
    private var identityRegeneratedField: Boolean = false

    /**
     * v2.16.0 (policy observability): why the identity lives where it lives
     * — KEYSTORE / LEGACY_PREFS / SOFTWARE_FALLBACK (or "unknown" before
     * the first initialize). Pairs with [identityRegenerated].
     */
    @Synchronized
    fun identityStorageMode(): String = identityStorageModeField

    /** v2.16.0: true when the in-use identity was regenerated over a
     *  corrupt/missing predecessor (policy REGENERATE_AFTER_CORRUPTION). */
    @Synchronized
    fun identityRegenerated(): Boolean = identityRegeneratedField

    @Synchronized
    fun getEphemeralId(): String = ephemeralId

    @Synchronized
    fun getPublicKeyBase64(): String =
        Base64.encodeToString(ephemeralKeyPair!!.public.encoded, Base64.NO_WRAP)

    /**
     * Atomically capture the CURRENT ephemeral (id + public key + keypair) in
     * one synchronized call (audit round 11): a caller needing a consistent
     * (id, key, PoW prefix, signature) must use ONE snapshot instead of
     * calling getEphemeralId()/getPublicKeyBase64() separately — rotation
     * between those calls was producing frames whose fields referenced
     * different key material.
     *
     * Audit round 12: this getter NEVER rotates. Rotation is exclusively
     * driven by [rotateEphemeralKey] (invoked by MeshService's single
     * rotation clock — see MeshService.rotateEphemeralId). The old getter
     * auto-rotation created a second, independent rotation clock that could
     * change the signing key without restarting Nearby advertising.
     */
    @Synchronized
    fun getEphemeralSnapshot(): EphemeralSnapshot {
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

    /**
     * Rotate the ephemeral key pair AND return the new snapshot. This is the
     * ONLY rotation entry point (audit round 12 — single rotation authority):
     * MeshService calls it from its own clock and restarts Nearby advertising
     * with the new public key name immediately; nothing inside this engine
     * rotates on its own. The retired key is retained for in-transit
     * decryption (see [retiredEphemeralKeyPairs] and [decryptFromPeer]).
     */
    @Synchronized
    fun rotateEphemeralKey(): EphemeralSnapshot {
        ephemeralKeyPair?.let { old ->
            retiredEphemeralKeyPairs.addLast(old)
            while (retiredEphemeralKeyPairs.size > MAX_RETIRED_EPHEMERAL_KEYS) {
                retiredEphemeralKeyPairs.removeFirst()
            }
        }
        ephemeralKeyPair = generateECKeyPair()
        ephemeralId = generateRandomId()
        return EphemeralSnapshot(
            keyPair = ephemeralKeyPair!!,
            ephemeralId = ephemeralId,
            publicKeyB64 = Base64.encodeToString(ephemeralKeyPair!!.public.encoded, Base64.NO_WRAP)
        )
    }

    /**
     * Full cryptographic key check (audit round 12): unlike the cheap shape
     * gate (MeshService.isLikelyPublicKey), this actually decodes the SPKI.
     * Used at peer ADMISSION (onEndpointFound / onConnectionInitiated) so a
     * malformed-but-shape-valid key is rejected BEFORE it can reach
     * encryptForPeer — a decode failure there would otherwise escape the
     * trickle Timer task and kill the whole mesh schedule.
     */
    fun isValidPublicKey(base64: String): Boolean {
        return try {
            decodePublicKey(base64)
            true
        } catch (e: Exception) {
            false
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
        // Wire-contract enforcement at the API boundary (audit round 12):
        // MeshWire.parseFrame rejects blank messageId/type and any non-zero
        // hopCount (hopCount is signed and must stay 0 — see MeshWire). A
        // crypto API that happily emits an un-deliverable SecureMessage is a
        // trap for future callers; fail loudly instead.
        require(messageId.isNotBlank()) { "messageId must be non-blank — MeshWire.parseFrame rejects blank ids" }
        require(type.isNotBlank()) { "type must be non-blank — MeshWire.parseFrame rejects blank types" }
        require(hopCount == 0) { "hopCount must be 0 — it is signed and wire-immutable (see MeshWire)" }
        val peerPublicKey = decodePublicKey(peerPublicKeyBase64)
        val sharedSecret = ecdhKeyAgreement(snapshot.keyPair.private, peerPublicKey)
        val aesKey = deriveAESKey(sharedSecret)

        // Encrypt
        val iv = ByteArray(GCM_IV_LENGTH).apply { protocolRandom.nextBytes(this) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(aesKey, "AES"), GCMParameterSpec(GCM_TAG_LENGTH, iv))
        val ciphertext = cipher.doFinal(payload)
        val nonce = protocolRandom.nextInt()

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
     *
     * Audit round 12 (recipient-side key rotation): the decryption half tries
     * the CURRENT ephemeral key first, then each RETIRED key (in retirement
     * order). A message encrypted to our previously-advertised key — in
     * transit across the moment we rotated — stays decryptable instead of
     * dying silently. The bound on retained keys (MAX_RETIRED_EPHEMERAL_KEYS)
     * covers the full message TTL window (see retiredEphemeralKeyPairs).
     */
    @Synchronized
    fun decryptFromPeer(
        message: SecureMessage,
        peerPublicKeyBase64: String? = null
    ): ByteArray? {
        val messageSenderKey = decodePublicKey(message.senderPublicKey)
        val peerPublicKey = if (peerPublicKeyBase64 != null) {
            val suppliedKey = decodePublicKey(peerPublicKeyBase64)
            if (!MessageDigest.isEqual(suppliedKey.encoded, messageSenderKey.encoded)) return null
            suppliedKey
        } else {
            messageSenderKey
        }

        // Signature covers canonical metadata (same bytes both sides).
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
            return null
        }

        // Decrypt with current key, then each retired key. Each attempt is
        // isolated: a wrong key fails ECDH/decrypt, never short-circuits the
        // next candidate (audit round 12).
        val candidates = ArrayList<KeyPair>(1 + retiredEphemeralKeyPairs.size)
        ephemeralKeyPair?.let { candidates.add(it) }
        candidates.addAll(retiredEphemeralKeyPairs)
        for (candidate in candidates) {
            try {
                val sharedSecret = ecdhKeyAgreement(candidate.private, peerPublicKey)
                val aesKey = deriveAESKey(sharedSecret)
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(aesKey, "AES"), GCMParameterSpec(GCM_TAG_LENGTH, iv))
                return cipher.doFinal(ciphertext)
            } catch (_: Exception) {
                android.util.Log.d("CryptoEngine", "Decrypt attempt with one key candidate failed")
            }
        }
        android.util.Log.e("CryptoEngine", "Decryption failed with all key candidates")
        return null
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
        val kpg = KeyPairGenerator.getInstance(EC_ALGORITHM)
        kpg.initialize(ECGenParameterSpec("secp256r1"), SecureRandom())
        return kpg.generateKeyPair()
    }

    private fun decodePublicKey(base64: String): PublicKey {
        val keyBytes = Base64.decode(base64, Base64.NO_WRAP)
        val spec = X509EncodedKeySpec(keyBytes)
        return KeyFactory.getInstance(EC_ALGORITHM).generatePublic(spec)
    }

    private fun ecdhKeyAgreement(privateKey: PrivateKey, publicKey: PublicKey): ByteArray {
        val ka = KeyAgreement.getInstance(KEY_EXCHANGE_ALGORITHM)
        ka.init(privateKey)
        ka.doPhase(publicKey, true)
        return ka.generateSecret()
    }

    private fun deriveAESKey(sharedSecret: ByteArray): ByteArray {
        val digest = MessageDigest.getInstance("SHA-256")
        return digest.digest(sharedSecret).copyOf(AES_KEY_SIZE / 8)
    }

    private fun signData(data: ByteArray, privateKey: PrivateKey): ByteArray {
        val sig = Signature.getInstance(SIGNATURE_ALGORITHM)
        sig.initSign(privateKey)
        sig.update(data)
        return sig.sign()
    }

    private fun verifySignature(data: ByteArray, signature: ByteArray, publicKey: PublicKey): Boolean {
        val sig = Signature.getInstance(SIGNATURE_ALGORITHM)
        sig.initVerify(publicKey)
        sig.update(data)
        return sig.verify(signature)
    }

    private fun generateRandomId(): String {
        val chars = "abcdefghijklmnopqrstuvwxyz0123456789"
        return (1..16).map { chars[protocolRandom.nextInt(chars.length)] }.joinToString("")
    }
}
