package com.observatory.wildfire

/**
 * Fix 17 (NREP-1, NREP-2): pure refresh-merge policy for [AppRepository].
 *
 * The repository's last-good contract is decided here, not inline in the
 * suspending refresh path, so the decision is JVM-testable without
 * `org.json` (unusable on the JVM test host) and without an Android
 * `Context` (there is no `AppRepositoryTest` harness).
 *
 *  - NREP-1: a refresh pass is a FULL success only when EVERY endpoint
 *    returned a list. One success used to be enough (OR over identity
 *    checks), which stamped a mixed old/new snapshot as a successful
 *    synchronization and advanced `lastSyncMs`.
 *  - NREP-2: a malformed 200 body must be a FAILURE, not an empty list.
 *    The parsers collapse "malformed body" and "genuinely empty array"
 *    into the same `emptyList()`, so an empty parse result is only a
 *    success when the body really was an empty JSON array. Anything else
 *    that parses to nothing keeps the last-good data instead of wiping
 *    it. The failure direction is deliberately safe: a valid array whose
 *    every item is malformed also counts as a failure (zero usable items
 *    must not wipe last-good data).
 */
object RefreshPolicy {

    /**
     * NREP-1: all four fetched lists must be non-null. A `null` entry
     * means that endpoint failed (transport error or, since NREP-2, a
     * malformed 200); the caller keeps the previous list for it.
     */
    fun refreshSucceeded(
        reports: List<*>?,
        hotspots: List<*>?,
        safezones: List<*>?,
        wilayas: List<*>?
    ): Boolean = reports != null && hotspots != null && safezones != null && wilayas != null

    /**
     * NREP-2: true only when the body is exactly an empty JSON array,
     * modulo whitespace (`[]`, `[ ]`, `[\n]`). The server serialises
     * compact JSON, so `[]` is the real-world form; the whitespace
     * tolerance covers pretty-printing. Everything else — `{}`, `""`,
     * `"null"`, truncated JSON, an HTML error page — is NOT a genuine
     * empty array.
     */
    fun isGenuineEmptyBody(body: String): Boolean =
        body.filterNot { it.isWhitespace() } == "[]"
}
