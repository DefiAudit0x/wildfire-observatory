package com.observatory.wildfire

import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.zip.Deflater
import java.util.zip.Inflater

/**
 * Pure-JVM wire-format layer for the mesh (audit round): every byte-level
 * concern — framing, compression, proof-of-work, canonical signed metadata,
 * anti-replay hashing — lives here with NO Android imports, so the whole
 * wire contract is unit-testable on the JVM (`app:testDebugUnitTest`).
 *
 * Wire format (pipe-joined, 16 fields):
 *   protocolVersion|messageId|type|payloadB64|iv|hopCount|origEphemeralId|
 *   origPublicKey|timestamp|signature|nonce|lat|lng|powNonce|powDifficulty|hopsLeft
 *
 * The version is FIRST: it gates every other interpretation of the bytes, so
 * a future format change is rejected (never misparsed) by older nodes.
 *
 * Signing scope (audit): the ECDSA signature covers a canonical encoding of
 * EVERY relay-invariant field (ciphertext, iv, messageId, type, hopCount,
 * origEphemeralId, origPublicKey, timestamp, nonce, lat, lng) — a relay can
 * no longer tamper operational metadata (coordinates, type, nonce, ids) and
 * leave the signature valid. hopCount is SIGNED and therefore immutable:
 * relays never touch it; propagation decay is carried by the unsigned
 * hopsLeft field, whose mutation has no security consequence (depth only —
 * seen-hash dedup already bounds loops).
 */
object MeshWire {

    /** Wire protocol version — the FIRST field of every frame. */
    const val PROTOCOL_VERSION = 1

    /** Propagation budget: origin sets hopsLeft = MAX_HOPS; each relay decrements and stops at 0. */
    const val MAX_HOPS = 5

    private val COMPRESS_MAGIC = byteArrayOf(0x4D, 0x43) // "MC"

    /** Compression flag byte right after the magic: 0 = deflate stream, 1 = raw payload. */
    private const val FLAG_DEFLATE: Byte = 0
    private const val FLAG_RAW: Byte = 1

    /** Sanity ceiling for a single decoded frame (defense against absurd memory use). */
    private const val MAX_FRAME_BYTES = 128 * 1024

    /**
     * The canonical 16-field mesh frame. hopCount is 0 for EVERY valid frame
     * (origin-authored and signed — see parseFrame), hopsLeft carries decay.
     */
    data class Frame(
        val protocolVersion: Int,
        val messageId: String,
        val type: String,
        val payloadB64: String,
        val iv: String,
        val hopCount: Int,
        val origEphemeralId: String,
        val origPublicKey: String,
        val timestamp: Long,
        val signature: String,
        val nonce: Int,
        val lat: Double,
        val lng: Double,
        val powNonce: Int,
        val powDifficulty: Int,
        val hopsLeft: Int
    )

    /**
     * Serialize + compress a frame for the wire. Compression failures fall
     * back to RAW with the flag byte set (FLAG_RAW): the receiver MUST be
     * able to distinguish raw from deflate — a magic+raw frame flagged as
     * deflate would be inflated into corruption (audit: the old fallback
     * emitted raw bytes under the plain deflate magic, so it could never be
     * decoded).
     */
    fun compress(data: ByteArray): ByteArray {
        return try {
            val deflater = Deflater(Deflater.BEST_COMPRESSION)
            deflater.setInput(data)
            deflater.finish()
            var buf = ByteArray(data.size * 2 + 1024)
            var off = 0
            while (!deflater.finished()) {
                if (off == buf.size) buf = buf.copyOf(buf.size * 2)
                val len = deflater.deflate(buf, off, buf.size - off)
                if (len == 0) break // defensive: prevent an infinite loop
                off += len
            }
            deflater.end()
            COMPRESS_MAGIC + byteArrayOf(FLAG_DEFLATE) + buf.copyOf(off)
        } catch (e: Exception) {
            COMPRESS_MAGIC + byteArrayOf(FLAG_RAW) + data
        }
    }

    /**
     * Decode a wire frame: requires the magic marker and the flag byte; a
     * deflate body that fails to inflate is NOT silently re-read as raw.
     * Returns null for anything that is not a well-formed frame.
     */
    fun decompress(data: ByteArray): String? {
        if (data.size < COMPRESS_MAGIC.size + 1) return null
        for (i in COMPRESS_MAGIC.indices) {
            if (data[i] != COMPRESS_MAGIC[i]) return null
        }
        val raw = data[COMPRESS_MAGIC.size] == FLAG_RAW
        if (data[COMPRESS_MAGIC.size] != FLAG_DEFLATE && !raw) return null
        val body = data.copyOfRange(COMPRESS_MAGIC.size + 1, data.size)
        if (body.size > MAX_FRAME_BYTES) return null
        return try {
            if (raw) {
                String(body, Charsets.UTF_8)
            } else {
                val inflater = Inflater()
                inflater.setInput(body)
                val out = ByteArrayOutputStream(body.size * 2)
                val buf = ByteArray(8192)
                while (!inflater.finished()) {
                    val len = inflater.inflate(buf)
                    if (len == 0) return null // corrupt deflate stream
                    out.write(buf, 0, len)
                }
                inflater.end()
                out.toString("UTF-8")
            }
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Canonical SHA-256 hex digest.
     */
    fun sha256Hex(input: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        return digest.digest(input.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    /**
     * Anti-replay hash over (messageId, nonce) with EXPLICIT framing: the
     * naive concatenation was ambiguous — ("ab", 12) and ("ab1", 2) both
     * produce "ab12". Length-prefixing makes distinct messages hash apart.
     */
    fun seenMessageHash(messageId: String, nonce: Int): String =
        sha256Hex("${messageId.length}:$messageId:${nonce.toString().length}:$nonce")

    /**
     * Canonical bytes signed by the origin: length-prefixed UTF-8 encoding of
     * every relay-invariant field, concatenated. Deterministic on both ends:
     * Java's Double.toString is the shortest round-trip form, so a lat/lng
     * parsed from the pipe frame and re-serialized yields the SAME bytes.
     * hopsLeft and the PoW fields are deliberately NOT signed (depth control
     * and spam work respectively — each has its own verification).
     */
    fun buildSignedData(
        ciphertext: ByteArray,
        iv: ByteArray,
        messageId: String,
        type: String,
        hopCount: Int,
        origEphemeralId: String,
        origPublicKey: String,
        timestamp: Long,
        nonce: Int,
        lat: Double,
        lng: Double
    ): ByteArray {
        val out = ByteArrayOutputStream()
        out.writeLengthPrefixed(ciphertext)
        out.writeLengthPrefixed(iv)
        out.writeLengthPrefixed(messageId.toByteArray(Charsets.UTF_8))
        out.writeLengthPrefixed(type.toByteArray(Charsets.UTF_8))
        out.writeLengthPrefixed(hopCount.toString().toByteArray(Charsets.UTF_8))
        out.writeLengthPrefixed(origEphemeralId.toByteArray(Charsets.UTF_8))
        out.writeLengthPrefixed(origPublicKey.toByteArray(Charsets.UTF_8))
        out.writeLengthPrefixed(timestamp.toString().toByteArray(Charsets.UTF_8))
        out.writeLengthPrefixed(nonce.toString().toByteArray(Charsets.UTF_8))
        out.writeLengthPrefixed(lat.toString().toByteArray(Charsets.UTF_8))
        out.writeLengthPrefixed(lng.toString().toByteArray(Charsets.UTF_8))
        return out.toByteArray()
    }

    /**
     * Parse a pipe-joined frame string. Frames with the wrong field count or
     * version, a non-zero hopCount (hopCount is signed — relays cannot
     * change it, so anything else is an alien/legacy frame), out-of-band
     * hopsLeft, missing key material or non-finite coordinates are rejected
     * outright — there is no legacy format.
     */
    fun parseFrame(json: String): Frame? {
        return try {
            val parts = json.split("|")
            if (parts.size != 16) return null
            val protocolVersion = parts[0].toInt()
            if (protocolVersion != PROTOCOL_VERSION) return null
            val messageId = parts[1]
            val type = parts[2]
            val payloadB64 = parts[3]
            val iv = parts[4]
            val hopCount = parts[5].toInt()
            val origEphemeralId = parts[6]
            val origPublicKey = parts[7]
            val timestamp = parts[8].toLong()
            val signature = parts[9]
            val nonce = parts[10].toInt()
            val lat = parts[11].toDouble()
            val lng = parts[12].toDouble()
            val powNonce = parts[13].toInt()
            val powDifficulty = parts[14].toInt()
            val hopsLeft = parts[15].toInt()

            if (messageId.isBlank() || type.isBlank() || payloadB64.isBlank() ||
                iv.isBlank() || origEphemeralId.isBlank() || origPublicKey.isBlank() ||
                signature.isBlank()
            ) return null
            if (hopCount != 0) return null
            if (hopsLeft < 0 || hopsLeft > MAX_HOPS) return null
            if (!lat.isFinite() || !lng.isFinite() ||
                lat < -90.0 || lat > 90.0 || lng < -180.0 || lng > 180.0
            ) return null

            Frame(
                protocolVersion = protocolVersion,
                messageId = messageId,
                type = type,
                payloadB64 = payloadB64,
                iv = iv,
                hopCount = hopCount,
                origEphemeralId = origEphemeralId,
                origPublicKey = origPublicKey,
                timestamp = timestamp,
                signature = signature,
                nonce = nonce,
                lat = lat,
                lng = lng,
                powNonce = powNonce,
                powDifficulty = powDifficulty,
                hopsLeft = hopsLeft
            )
        } catch (e: Exception) {
            null
        }
    }

    /** Serialize a frame back to its pipe-joined string form. */
    fun frameToJson(frame: Frame): String {
        return listOf(
            frame.protocolVersion.toString(),
            frame.messageId,
            frame.type,
            frame.payloadB64,
            frame.iv,
            frame.hopCount.toString(),
            frame.origEphemeralId,
            frame.origPublicKey,
            frame.timestamp.toString(),
            frame.signature,
            frame.nonce.toString(),
            frame.lat.toString(),
            frame.lng.toString(),
            frame.powNonce.toString(),
            frame.powDifficulty.toString(),
            frame.hopsLeft.toString()
        ).joinToString("|")
    }

    /**
     * Network-wide proof-of-work: find a nonce such that the top 8 hex digits
     * (32 bits) of SHA-256(prefix + nonce) fall below the difficulty target.
     * NOTE: difficulty 8 means ~8 leading ZERO BITS of that 32-bit prefix
     * (≈1/256 of the space) — not 8 hex characters (a much weaker reading of
     * the old comment). The receiver does NOT trust the sender's declared
     * difficulty: out-of-band values are rejected before any hashing.
     */
    object ProofOfWork {
        private const val MAX_DIFFICULTY = 31
        const val MAX_ITERATIONS = 5_000_000

        fun target(difficulty: Int): Long {
            val d = difficulty.coerceIn(1, MAX_DIFFICULTY)
            return 1L shl (32 - d)
        }

        /**
         * Returns the nonce, or NULL when the iteration budget is exhausted.
         * The budget is a hard cap against pathological inputs — a null
         * return lets the caller handle the failure explicitly instead of
         * catching a thrown SecurityException mid-broadcast.
         */
        fun solve(prefix: String, difficulty: Int = 8): Int? {
            val t = target(difficulty)
            var nonce = 0
            while (nonce < MAX_ITERATIONS) {
                val value = prefixValue(prefix, nonce)
                if (value < t) return nonce
                nonce++
            }
            return null
        }

        fun verify(prefix: String, nonce: Int, difficulty: Int = 8): Boolean {
            return prefixValue(prefix, nonce) < target(difficulty)
        }

        private fun prefixValue(prefix: String, nonce: Int): Long {
            val hash = sha256Hex("$prefix$nonce")
            return hash.take(8).fold(0L) { acc, c -> (acc shl 4) + c.digitToInt(16) }
        }
    }

    private fun ByteArrayOutputStream.writeLengthPrefixed(bytes: ByteArray) {
        write((bytes.size shr 24) and 0xFF)
        write((bytes.size shr 16) and 0xFF)
        write((bytes.size shr 8) and 0xFF)
        write(bytes.size and 0xFF)
        write(bytes)
    }
}
