package com.observatory.wildfire

import java.util.concurrent.ConcurrentHashMap

/**
 * ARC-H16: reputation state extracted from MeshService as a PURE JVM module
 * (no Android imports — unit-tested in MeshReputationTest). Owns the TOFU
 * device-record table: the scoring, the clamp band, the bounded cap and the
 * admission threshold. The SERVICE composes this with the peer registry
 * (endpointId -> publicKey lookup) and executes the transport-level
 * auto-disconnect when scoring says so — this module never touches Nearby.
 *
 * Reputation is anchored on the peer's TOFU device record (public-key
 * identity — audit round 12): a peer re-announcing under a new Nearby
 * endpointId KEEPS its history, and a vanished peer stops accumulating
 * state (its record is evicted only by the bounded cap). A reputation
 * update for an unregistered endpoint is a no-op — anonymous
 * connections were already gated out at admission, so there is no
 * keyless reputation path to abuse.
 *
 * Instance-scoped: the service owns one instance and clears it in
 * onDestroy, exactly like the original in-service deviceRecords map.
 */
class MeshReputation {

    companion object {
        const val REPUTATION_INITIAL = 50
        // ARC-L24: REPUTATION_GOOD_REPORT (15) and REPUTATION_FALSE_REPORT
        // (-50) were deleted — reputation is scored from AUTHENTICATED
        // traffic quality elsewhere; these two were never referenced and
        // implied a report-quality link that does not exist.
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

        // Device records (TOFU identity — audit round 12): reputation and
        // first/last-seen are anchored on the peer's ADVERTISED PUBLIC KEY,
        // not on the transport endpointId, which is a Nearby session id that
        // changes every re-announce. The cap bounds distinct devices seen;
        // a larger herd evicts the least-recently-seen record.
        const val MAX_DEVICE_RECORDS = 1024
    }

    data class DeviceRecord(
        var reputation: Int,
        var firstSeen: Long,
        var lastSeen: Long
    )

    val deviceRecords = ConcurrentHashMap<String, DeviceRecord>()

    /**
     * TOFU sight (trust-on-first-use): creates the record at [REPUTATION_INITIAL]
     * on first sight of a public key, refreshes NOTHING else on repeat sight
     * (lastSeen here is refreshed by scoring/quarantine paths — discovery
     * sightings in MeshService only need the record to EXIST to admit the
     * connection), and bounds the table via [capRecords].
     *
     * Mirrors the original MeshService.onEndpointFound block verbatim:
     * getOrPut + cap, so an anonymous herd cannot grow memory forever.
     */
    fun sight(publicKey: String, now: Long) {
        deviceRecords.getOrPut(publicKey) {
            DeviceRecord(
                reputation = REPUTATION_INITIAL,
                firstSeen = now,
                lastSeen = now
            )
        }
        capRecords()
    }

    /**
     * Bound the TOFU record table (audit round 12): distinct near-mesh
     * devices are bounded by MAX_DEVICE_RECORDS; overflow evicts the
     * least-recently-seen record so an anonymous herd cannot grow memory
     * forever.
     */
    fun capRecords() {
        while (deviceRecords.size > MAX_DEVICE_RECORDS) {
            deviceRecords.entries.minByOrNull { it.value.lastSeen }
                ?.let { deviceRecords.remove(it.key) } ?: break
        }
    }

    /** Admission threshold: strictly above the quarantine floor (audit: `> REPUTATION_MIN / 2`). */
    fun isAdmitted(publicKey: String): Boolean {
        val record = deviceRecords[publicKey] ?: return false
        return record.reputation > REPUTATION_MIN / 2
    }

    /** Current score for a key; [REPUTATION_INITIAL] when the key is unknown (original getReputation fallback). */
    fun score(publicKey: String): Int =
        deviceRecords[publicKey]?.reputation ?: REPUTATION_INITIAL

    fun known(publicKey: String): Boolean = deviceRecords.containsKey(publicKey)

    /**
     * Apply a reputation delta to a key, clamped to [REPUTATION_MIN, REPUTATION_MAX],
     * refreshing lastSeen (verbatim from the original updateReputation compute block).
     * Returns the NEW score.
     */
    fun update(publicKey: String, delta: Int, now: Long): Int {
        val record = deviceRecords.compute(publicKey) { _, existing ->
            val base = existing ?: DeviceRecord(REPUTATION_INITIAL, now, now)
            base.reputation = (base.reputation + delta).coerceIn(REPUTATION_MIN, REPUTATION_MAX)
            base.lastSeen = now
            base
        }
        return record?.reputation ?: REPUTATION_INITIAL
    }

    /**
     * Quarantine a peer that failed mid-processing (audit round 12): drop
     * the TOFU record's reputation below the admission threshold so the
     * device is not re-admitted until scoring recovers it. The record
     * itself stays (identity history is bounded and scored), but the
     * quarantine bit is the reputation floor.
     */
    fun quarantine(publicKey: String, now: Long) {
        deviceRecords.computeIfPresent(publicKey) { _, record ->
            record.reputation = REPUTATION_MIN / 2 - 1
            record.lastSeen = now
            record
        }
    }
}
