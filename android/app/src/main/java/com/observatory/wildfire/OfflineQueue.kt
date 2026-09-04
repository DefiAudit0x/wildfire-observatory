package com.observatory.wildfire

/**
 * v2.16.0 (audit wave 3) — offline submission queue core, Android-free.
 *
 * Doctrine (mirrors MeshService's store-and-forward hygiene):
 *  - entries are keyed by the server idempotency key (clientGeneratedId) so a
 *    retry can never duplicate a report/SOS the server already accepted;
 *  - entries that were NEVER attempted (no connectivity yet) are shielded
 *    from eviction — they carry the newest field intel;
 *  - already-attempted entries evict first, ordered by last attempt time;
 *  - a poisoned entry (MAX_ATTEMPTS real failures) is dropped, not hoarded;
 *  - exponential backoff (v2.16.0): a failed entry is not re-attempted until
 *    its backoff window elapses (30s doubling, 10-min cap) — a dead endpoint
 *    must not burn radio + battery on every 20s drain tick.
 *
 * v2.16.0 (audit — I/O under lock, 🟠): the queue NEVER runs network or disk
 * I/O under its monitor anymore. The old drain(send) invoked the transport
 * INSIDE the synchronized block, so a 10s-timeout POST stalled every
 * enqueue/snapshot/size caller for the entire send. The API is now
 * two-phase:
 *
 *      val reserved = q.reserveDue(3, now)      // lock held: atomic take
 *      // ...send each payload OUTSIDE any lock...
 *      q.commit(now, deliveredKeys)             // lock held: atomic outcome
 *
 * A process death between reserve and commit loses nothing: snapshot() —
 * what the persistence layer writes — INCLUDES in-flight entries, and
 * restoreAll() rehydrates them with their attempt history intact.
 */
class OfflineQueue<T>(private val capacity: Int = CAPACITY) {

    data class Entry<T>(
        val key: String,
        val payload: T,
        val attempts: Int = 0,
        val lastAttemptMs: Long = 0L,
        val lastError: String? = null,
        val nextAttemptMs: Long = 0L
    ) {
        val neverAttempted: Boolean get() = attempts == 0
    }

    companion object {
        const val CAPACITY = 60
        const val MAX_ATTEMPTS = 8
        const val BACKOFF_BASE_MS = 30_000L
        const val BACKOFF_MAX_MS = 600_000L

        /**
         * Backoff deadline offset after the Nth failed attempt (1-based):
         * 30s, 60s, 120s ... capped at 10 min — the same "10-minute-class
         * clock" the eviction doctrine uses, so an entry never waits longer
         * than the horizon its own eviction clock measures. Shift is clamped
         * so a hostile/broken attempts value can never overflow.
         */
        fun backoffFor(failedAttempts: Int): Long {
            if (failedAttempts <= 0) return 0L
            val shift = (failedAttempts - 1).coerceAtMost(20)
            return (BACKOFF_BASE_MS shl shift).coerceAtMost(BACKOFF_MAX_MS)
        }
    }

    private val items = ArrayDeque<Entry<T>>()
    private val inFlight = LinkedHashMap<String, Entry<T>>()

    /** Total undelivered entries (waiting + in-flight). */
    @Synchronized
    fun size(): Int = items.size + inFlight.size

    /**
     * FIFO snapshot: in-flight entries first (they were reserved off the
     * head), then the waiting tail. This IS the persistence contract — a
     * crash mid-send is recovered from exactly this list.
     */
    @Synchronized
    fun snapshot(): List<Entry<T>> = inFlight.values.toList() + items.toList()

    /** Returns false when the key already exists or is in flight. */
    @Synchronized
    fun enqueue(key: String, payload: T, nowMs: Long = 0L): Boolean {
        if (inFlight.containsKey(key)) return false
        if (items.any { it.key == key }) return false
        evictForAdmission(nowMs)
        items.addLast(Entry(key, payload))
        return true
    }

    /**
     * Hydrate the queue from persisted state (F1: cold-start survival).
     * Replaces the WAITING contents with [entries] in order, deduped by key
     * (keys currently in flight are never duplicated), capped at capacity
     * keeping the NEWEST entries (mirrors enqueue-time eviction: capacity
     * bounds memory, the newest intel must always fit). Attempts/lastAttempt/
     * backoff survive so a nearly-poisoned entry stays nearly-poisoned after
     * restore instead of getting fresh lives.
     */
    @Synchronized
    fun restoreAll(entries: List<Entry<T>>) {
        items.clear()
        val seen = HashSet<String>()
        for (e in entries) {
            if (seen.add(e.key) && !inFlight.containsKey(e.key)) items.addLast(e)
        }
        while (items.size + inFlight.size > capacity) items.removeFirst()
    }

    /**
     * Phase 1: atomically take up to [max] DUE entries off the head
     * (nextAttemptMs <= nowMs, FIFO order). The caller owns them until
     * commit(); they are invisible to enqueue-eviction and cannot be
     * reserved twice. Returns [] when nothing is due — an empty queue and
     * a fully-backed-off queue look identical to the caller: nothing to send.
     */
    @Synchronized
    fun reserveDue(max: Int, nowMs: Long): List<Entry<T>> {
        if (max <= 0) return emptyList()
        val taken = ArrayList<Entry<T>>(minOf(max, items.size))
        var i = 0
        while (i < items.size && taken.size < max) {
            val e = items[i]
            if (e.nextAttemptMs <= nowMs) {
                items.removeAt(i)
                inFlight[e.key] = e
                taken.add(e)
                // do not advance i — next entry shifted into this slot
            } else {
                i++
            }
        }
        return taken
    }

    /**
     * Phase 2: ONE atomic outcome for a reserve batch. Keys in
     * [deliveredKeys] leave the queue forever (the server accepted them; the
     * idempotency key is burned). Every other reserved entry is a FAILURE:
     * attempts+1, then either poisoned (attempts >= MAX_ATTEMPTS → dropped,
     * never hoarded) or re-queued at the head — reserve takes a FIFO prefix,
     * so failures re-insert in reservation order, preserving global FIFO —
     * stamped with lastAttemptMs/lastError and the next backoff deadline.
     * Unknown keys are ignored: commit is idempotent.
     */
    @Synchronized
    fun commit(nowMs: Long, deliveredKeys: Set<String>, error: String? = null) {
        if (inFlight.isEmpty()) return
        val requeue = ArrayList<Entry<T>>()
        for ((key, entry) in inFlight) {
            if (key in deliveredKeys) continue
            val attempts = entry.attempts + 1
            if (attempts < MAX_ATTEMPTS) {
                requeue.add(
                    entry.copy(
                        attempts = attempts,
                        lastAttemptMs = nowMs,
                        lastError = error ?: entry.lastError,
                        nextAttemptMs = nowMs + backoffFor(attempts)
                    )
                )
            }
            // else: poisoned — dropped, never hoarded
        }
        inFlight.clear()
        for ((idx, e) in requeue.withIndex()) items.add(idx, e)
    }

    /**
     * Admission eviction: when full, drop the OLDEST already-attempted entry
     * (its 10-minute-class clock is the oldest); never-attempted entries are
     * shielded. If everything left was never attempted, drop the oldest
     * anyway — capacity bounds memory, the newest intel must always fit.
     * In-flight entries are not eviction candidates: they are owned by the
     * sender and bounded by the reserve batch size, not by capacity.
     */
    private fun evictForAdmission(nowMs: Long) {
        if (items.size < capacity) return
        val victim = items.withIndex()
            .filter { !it.value.neverAttempted }
            .minByOrNull { it.value.lastAttemptMs }
            ?.index
            ?: 0
        items.removeAt(victim)
    }
}
