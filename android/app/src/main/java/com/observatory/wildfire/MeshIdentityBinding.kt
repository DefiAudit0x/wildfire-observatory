package com.observatory.wildfire

/** Phase 1: new origins use a key-bound, scheme-marked ID. Old random IDs
 * remain accepted for interoperability. Their shared-budget attack is still
 * possible until a separate minimum-peer-version / legacy-sunset decision.
 * Never fall back to a public-key-keyed variant budget. */
object MeshIdentityBinding {
    private const val SCHEME_PREFIX = "k1:"

    // 63 chars: within the existing 64-char wire limit. The colon cannot
    // occur in a legacy ID (16 independent lowercase letters/digits).
    fun issue(publicKeyBase64: String): String =
        SCHEME_PREFIX + MeshWire.sha256Hex("wlfire-ephemeral-k1:$publicKeyBase64").take(60)

    fun accepts(ephemeralId: String, publicKeyBase64: String): Boolean =
        !ephemeralId.startsWith(SCHEME_PREFIX) || ephemeralId == issue(publicKeyBase64)
}
