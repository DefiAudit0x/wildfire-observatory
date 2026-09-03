package com.observatory.wildfire

/**
 * v2.0.0 (native UI) — offline submission queue core, Android-free.
 *
 * Doctrine (mirrors MeshService's store-and-forward hygiene):
 *  - entries are keyed by the server idempotency key (clientGeneratedId) so a
 *    retry can never duplicate a report/SOS the server already accepted;
 *  - entries that were NEVER attempted (no connectivity yet) are shielded
 *    from eviction — they carry the newest field intel;
 *  - already-attempted entries evict first, ordered by last attempt time;
 *  - a poisoned entry (MAX_ATTEMPTS real failures) is dropped, not hoarded.
 *
 * The file-persistence wrapper lives in the app layer (org.json); this core
 * is pure so every ordering/eviction rule is unit-testable.
 */
class OfflineQueue<T>(private val capacity: Int = CAPACITY) {

    data class Entry<T>(
        val key: String,
        val payload: T,
        val attempts: Int = 0,
        val lastAttemptMs: Long = 0L,
        val lastError: String? = null
    ) {
        val neverAttempted: Boolean get() = attempts == 0
    }

    companion object {
        const val CAPACITY = 60
        const val MAX_ATTEMPTS = 8
    }

    private val items = ArrayDeque<Entry<T>>()

    @Synchronized
    fun size(): Int = items.size

    @Synchronized
    fun snapshot(): List<Entry<T>> = items.toList()

    /** Returns false when the key already exists (never double-queued). */
    @Synchronized
    fun enqueue(key: String, payload: T, nowMs: Long = 0L): Boolean {
        if (items.any { it.key == key }) return false
        evictForAdmission(nowMs)
        items.addLast(Entry(key, payload))
        return true
    }

    /**
     * Hydrate the queue from persisted state (F1: cold-start survival).
     * Replaces in-memory contents with [entries] in order, deduped by key,
     * capped at capacity keeping the NEWEST entries (mirrors enqueue-time
     * eviction: capacity bounds memory, the newest intel must always fit).
     * Attempts/lastAttemptMs survive so a nearly-poisoned entry stays
     * nearly-poisoned after restore instead of getting fresh lives.
     */
    @Synchronized
    fun restoreAll(entries: List<Entry<T>>) {
        items.clear()
        val seen = HashSet<String>()
        for (e in entries) {
            if (seen.add(e.key)) items.addLast(e)
        }
        while (items.size > capacity) items.removeFirst()
    }

    /**
     * Try up to [max] entries in FIFO order via [send]. true = delivered
     * (removed), false = transport failure this round (kept, attempts+1).
     * Returns the number of delivered entries.
     */
    @Synchronized
    fun drain(max: Int, nowMs: Long, send: (T) -> Boolean): Int {
        var delivered = 0
        var i = 0
        while (i < items.size && delivered < max) {
            val entry = items[i]
            val ok = try {
                send(entry.payload)
            } catch (e: Exception) {
                false
            }
            if (ok) {
                items.removeAt(i)
                delivered++
                // do not advance i — next entry shifted into this slot
            } else {
                val attempts = entry.attempts + 1
                if (attempts >= MAX_ATTEMPTS) {
                    items.removeAt(i) // poisoned: drop, never hoard
                } else {
                    items[i] = entry.copy(attempts = attempts, lastAttemptMs = nowMs)
                    i++
                }
            }
        }
        return delivered
    }

    /**
     * Admission eviction: when full, drop the OLDEST already-attempted entry
     * (its 10-minute-class clock is the oldest); never-attempted entries are
     * shielded. If everything left was never attempted, drop the oldest
     * anyway — capacity bounds memory, the newest intel must always fit.
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
