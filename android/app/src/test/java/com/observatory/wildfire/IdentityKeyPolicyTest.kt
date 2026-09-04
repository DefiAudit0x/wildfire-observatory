package com.observatory.wildfire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * v2.16.0 (audit wave 3) — the identity-key storage policy table.
 * Continuity beats regeneration, regeneration beats fresh minting, and the
 * plaintext software fallback is a gated last resort.
 */
class IdentityKeyPolicyTest {

    private val policy = CryptoEngine.IdentityKeyPolicy

    @Test
    fun `valid legacy identity wins — upgrade continuity`() {
        assertEquals(
            CryptoEngine.IdentityKeyPolicy.Action.USE_LEGACY_IDENTITY,
            policy.decide(legacyPresent = true, legacyValid = true, keystoreUsable = true)
        )
        assertEquals(
            CryptoEngine.IdentityKeyPolicy.Action.USE_LEGACY_IDENTITY,
            policy.decide(legacyPresent = true, legacyValid = true, keystoreUsable = false)
        )
    }

    @Test
    fun `corrupt legacy identity regenerates loudly`() {
        assertEquals(
            CryptoEngine.IdentityKeyPolicy.Action.REGENERATE_AFTER_CORRUPTION,
            policy.decide(legacyPresent = true, legacyValid = false, keystoreUsable = true)
        )
        // Even a keystore-less device regenerates (into the gated fallback)
        // rather than silently ignoring a corrupt identity.
        assertEquals(
            CryptoEngine.IdentityKeyPolicy.Action.REGENERATE_AFTER_CORRUPTION,
            policy.decide(legacyPresent = true, legacyValid = false, keystoreUsable = false)
        )
    }

    @Test
    fun `clean install with a usable keystore uses the keystore`() {
        assertEquals(
            CryptoEngine.IdentityKeyPolicy.Action.USE_KEYSTORE_IDENTITY,
            policy.decide(legacyPresent = false, legacyValid = false, keystoreUsable = true)
        )
    }

    @Test
    fun `software fallback only when the keystore is unusable`() {
        assertEquals(
            CryptoEngine.IdentityKeyPolicy.Action.FALLBACK_TO_SOFTWARE,
            policy.decide(legacyPresent = false, legacyValid = false, keystoreUsable = false)
        )
    }

    @Test
    fun `the software gate opens only for a proven-unusable keystore`() {
        assertFalse(policy.softwareFallbackAllowed(keystoreUsable = true))
        assertTrue(policy.softwareFallbackAllowed(keystoreUsable = false))
    }

    @Test
    fun `storage modes map one to one from actions`() {
        assertEquals(
            CryptoEngine.IdentityKeyPolicy.StorageMode.LEGACY_PREFS,
            CryptoEngine.IdentityKeyPolicy.StorageMode.valueOf("LEGACY_PREFS")
        )
        // The three persisted modes are exactly the storage postures the
        // executor records — REGENERATE_AFTER_CORRUPTION is an action, not a
        // storage location (its storage is keystore-or-fallback + the
        // identity_regenerated flag).
        assertEquals(
            setOf("KEYSTORE", "LEGACY_PREFS", "SOFTWARE_FALLBACK"),
            CryptoEngine.IdentityKeyPolicy.StorageMode.entries.map { it.name }.toSet()
        )
        assertEquals(
            setOf("USE_LEGACY_IDENTITY", "USE_KEYSTORE_IDENTITY", "REGENERATE_AFTER_CORRUPTION", "FALLBACK_TO_SOFTWARE"),
            CryptoEngine.IdentityKeyPolicy.Action.entries.map { it.name }.toSet()
        )
    }
}
