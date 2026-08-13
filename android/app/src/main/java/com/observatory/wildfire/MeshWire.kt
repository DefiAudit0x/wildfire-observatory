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

    /** Allowed message types on the wire (audit: inbound whitelist). */
    const val MESSAGE_TYPE_REPORT = "report"
    const val MESSAGE_TYPE_ECHO = "echo"
    private val ALLOWED_TYPES = setOf(MESSAGE_TYPE_REPORT, MESSAGE_TYPE_ECHO)

    private val COMPRESS_MAGIC = byteArrayOf(0x4D, 0x43) // "MC"

    /** Compression flag byte right after the magic: 0 = deflate stream, 1 = raw payload. */
    private const val FLAG_DEFLATE: Byte = 0
    private const val FLAG_RAW: Byte = 1

    /** Sanity ceiling for the COMPRESSED body of a single frame (defense
     *  against absurd memory use BEFORE inflation). Audit: the old
     *  MAX_FRAME_BYTES name implied it capped the DECODED frame, but it only
     *  bounded the compressed input — a tiny deflate bomb could inflate to
     *  unbounded output. The DECOMPRESSED side is capped by
     *  MAX_DECOMPRESSED_BODY_BYTES enforced DURING inflation (not after —
     *  allocation happens inside the loop). */
    private const val MAX_COMPRESSED_BODY_BYTES = 128 * 1024
    private const val MAX_DECOMPRESSED_BODY_BYTES = 256 * 1024

    // Individual field ceilings (audit): besides the whole-frame caps, every
    // variable-length field is bounded so a hostile frame cannot carry a
    // multi-megabyte string in a field the rest of the pipeline treats as a
    // small identifier. Generators in this codebase stay far below these.
    private const val MAX_MESSAGE_ID_LEN = 64
    private const val MAX_TYPE_LEN = 32
    private const val MAX_EPHEMERAL_ID_LEN = 64
    private const val MAX_PUBLIC_KEY_LEN = 512
    private const val MAX_IV_LEN = 64
    private const val MAX_SIGNATURE_LEN = 512
    private const val GCM_TAG_BYTES = 16
    private const val MAX_PAYLOAD_B64_LEN = (MAX_DECOMPRESSED_BODY_BYTES + GCM_TAG_BYTES) * 4 / 3 + 24

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
        require(data.size <= MAX_DECOMPRESSED_BODY_BYTES) {
            "Frame body exceeds the maximum uncompressed size"
        }
        return try {
            val deflater = Deflater(Deflater.BEST_COMPRESSION)
            deflater.setInput(data)
            deflater.finish()
            var buf = ByteArray(data.size * 2 + 1024)
            var off = 0
            while (!deflater.finished()) {
                if (off == buf.size) buf = buf.copyOf(buf.size * 2)
                val len = deflater.deflate(buf, off, buf.size - off)
                if (len == 0) {
                    // Audit: a stalled deflater used to break out of the loop,
                    // emitting a TRUNCATED deflate stream that the receiver
                    // can never inflate — and the RAW fallback never ran,
                    // because nothing threw. Treat it as a compression failure
                    // so the payload goes out under FLAG_RAW instead.
                    deflater.end()
                    throw IllegalStateException("Deflater stalled with output pending")
                }
                off += len
                if (off > MAX_COMPRESSED_BODY_BYTES) {
                    deflater.end()
                    throw IllegalArgumentException("Compressed frame exceeds wire limit")
                }
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
     *
     * Decompression bomb defense (audit): the inflater output is capped
     * DURING the loop — output is bounded by MAX_DECOMPRESSED_BODY_BYTES no
     * matter how small the compressed input was.
     */
    fun decompress(data: ByteArray): String? {
        if (data.size < COMPRESS_MAGIC.size + 1) return null
        for (i in COMPRESS_MAGIC.indices) {
            if (data[i] != COMPRESS_MAGIC[i]) return null
        }
        val raw = data[COMPRESS_MAGIC.size] == FLAG_RAW
        if (data[COMPRESS_MAGIC.size] != FLAG_DEFLATE && !raw) return null
        val body = data.copyOfRange(COMPRESS_MAGIC.size + 1, data.size)
        if (!raw && body.size > MAX_COMPRESSED_BODY_BYTES) return null
        return try {
            if (raw) {
                if (body.size > MAX_DECOMPRESSED_BODY_BYTES) return null
                String(body, Charsets.UTF_8)
            } else {
                val inflater = Inflater()
                try {
                    inflater.setInput(body)
                    val out = ByteArrayOutputStream()
                    val buf = ByteArray(8192)
                    while (!inflater.finished()) {
                        val len = inflater.inflate(buf)
                        if (len == 0) return null // corrupt deflate stream
                        out.write(buf, 0, len)
                        if (out.size() > MAX_DECOMPRESSED_BODY_BYTES) return null // bomb guard
                    }
                    out.toString("UTF-8")
                } finally {
                    // Audit round 12: every early return above used to leak the
                    // Inflater's native allocations (end() runs only after the
                    // loop) — a peer feeding malformed/bomb frames could drive
                    // unbounded inflater handles. The finally releases the
                    // inflater on EVERY path, including return null.
                    inflater.end()
                }
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
     * Canonical coordinate serialization (audit round 12): micro-degrees,
     * i.e. round(value * 1e6) as a decimal string. This is the ONLY form the
     * native runtime (Kotlin Math.round) and the browser fallback (JS
     * Math.round) emit byte-identically for every Double. The previous
     * Double.toString serialization was runtime-dependent — JS String(0) is
     * "0" while Kotlin 0.0.toString() is "0.0", so a browser-signed message
     * with zeroed coordinates could never verify against the native
     * verifier. Micro-degrees also round away float accumulation noise
     * (0.1+0.2 → 300000 on both runtimes).
     */
    fun canonicalLatLng(value: Double): String = Math.round(value * 1_000_000.0).toString()

    /**
     * Canonical bytes signed by the origin: length-prefixed UTF-8 encoding of
     * every relay-invariant field, concatenated. Deterministic on both ends:
     * coordinates use [canonicalLatLng] (micro-degrees — see above), strings
     * are UTF-8, integers are decimal — no runtime-pinned formatting.
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
        out.writeLengthPrefixed(canonicalLatLng(lat).toByteArray(Charsets.UTF_8))
        out.writeLengthPrefixed(canonicalLatLng(lng).toByteArray(Charsets.UTF_8))
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
            // Per-field ceilings (audit): see the MAX_*_LEN constants above.
            if (messageId.length > MAX_MESSAGE_ID_LEN ||
                type.length > MAX_TYPE_LEN ||
                origEphemeralId.length > MAX_EPHEMERAL_ID_LEN ||
                origPublicKey.length > MAX_PUBLIC_KEY_LEN ||
                iv.length > MAX_IV_LEN ||
                signature.length > MAX_SIGNATURE_LEN ||
                payloadB64.length > MAX_PAYLOAD_B64_LEN
            ) return null
            // Pipe-injection guard (audit): the wire format is pipe-joined
            // and field values MUST NOT carry the delimiter themselves — a
            // field containing '|' would shift every following field and
            // change the frame's meaning. Such a frame is rejected outright.
            if (messageId.contains('|') || type.contains('|') ||
                origEphemeralId.contains('|') || origPublicKey.contains('|') ||
                payloadB64.contains('|') || iv.contains('|') || signature.contains('|')
            ) return null
            if (hopCount != 0) return null
            if (hopsLeft < 0 || hopsLeft > MAX_HOPS) return null
            if (!lat.isFinite() || !lng.isFinite() ||
                lat < -90.0 || lat > 90.0 || lng < -180.0 || lng > 180.0
            ) return null
            // Inbound type whitelist (audit): only known protocol types accepted.
            if (type !in ALLOWED_TYPES) return null

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

    /**
     * Serialize a frame back to its pipe-joined string form. Audit: the
     * serializer does not try to escape pipes inside fields — it REJECTS
     * them (an escaped encoding would silently change a frame's meaning to
     * parsers without the same rule; the parse side likewise rejects pipe-
     * carrying fields, see parseFrame). Our own generators never produce
     * pipes (UUIDs, whitelisted types, base64), so this is a guard against
     * a future internally-generated field carrying the delimiter — the
     * caller must catch it and drop the frame rather than emit a corrupt one.
     */
    fun frameToJson(frame: Frame): String {
        val fields = listOf(
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
        )
        if (fields.any { it.contains('|') }) {
            throw IllegalArgumentException("frame field contains the pipe delimiter")
        }
        return fields.joinToString("|")
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

        /**
         * Canonical wire challenge string (audit): the old concatenation
         * "$messageId$origEphemeralId" was ambiguous across field boundaries
         * ("ab"+"12" and "ab1"+"2" collide as "ab12"), so an attacker could
         * reuse one solved nonce for a different (messageId, origin) pair
         * that concatenates identically. Length-prefixing removes the
         * ambiguity; every hop constructs the challenge with this helper so
         * solver and verifier always agree.
         */
        fun wirePrefix(messageId: String, ephemeralId: String): String =
            "${messageId.length}:$messageId:${ephemeralId.length}:$ephemeralId"

        fun target(difficulty: Int): Long {
            // Audit: previously coerced silently via coerceIn — a caller
            // asking for difficulty 0 or 64 got an unexpected band. Fail
            // loudly on out-of-band input instead.
            require(difficulty in 1..MAX_DIFFICULTY) { "difficulty out of band: $difficulty" }
            return 1L shl (32 - difficulty)
        }

        /**
         * Returns the nonce, or NULL when the iteration budget is exhausted
         * OR the difficulty is out of band (an out-of-band challenge is
         * unsolvable by definition — the network rejects those frames).
         * The budget is a hard cap against pathological inputs — a null
         * return lets the caller handle the failure explicitly instead of
         * catching a thrown SecurityException mid-broadcast.
         */
        fun solve(prefix: String, difficulty: Int = 8): Int? {
            val t = try {
                target(difficulty)
            } catch (e: IllegalArgumentException) {
                return null
            }
            var nonce = 0
            while (nonce < MAX_ITERATIONS) {
                val value = prefixValue(prefix, nonce)
                if (value < t) return nonce
                nonce++
            }
            return null
        }

        fun verify(prefix: String, nonce: Int, difficulty: Int = 8): Boolean {
            val t = try {
                target(difficulty)
            } catch (e: IllegalArgumentException) {
                return false
            }
            return prefixValue(prefix, nonce) < t
        }

        private fun prefixValue(prefix: String, nonce: Int): Long {
            // Nonce framing (audit): "$prefix$nonce" was ambiguous across the
            // prefix/nonce boundary — ("a", 12) and ("a1", 2) hash identically.
            // Length-prefixing the prefix makes each (prefix, nonce) pair hash
            // apart, so a nonce solved for one prefix cannot be replayed
            // against a colliding one.
            val framed = "${prefix.length}:$prefix:$nonce"
            val hash = sha256Hex(framed)
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
