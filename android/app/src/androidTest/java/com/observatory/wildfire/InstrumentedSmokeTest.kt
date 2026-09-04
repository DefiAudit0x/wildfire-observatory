package com.observatory.wildfire

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * v2.16.0 (audit wave 3) — the instrumented layer the JVM suite can never
 * be: android.jar is stubbed out in unit tests, so the REAL AndroidKeyStore
 * path, the REAL LocationManager wiring and the REAL ContextCompat permission
 * reads only execute here, on an emulator, in CI's emulator job.
 *
 * Kept deliberately small and hermetic (no network, no grant dialogs): each
 * spec exercises one android-bound subsystem the JVM pins can only describe.
 */
@RunWith(AndroidJUnit4::class)
class InstrumentedSmokeTest {

    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun cryptoEngine_identity_survives_reinitialize_on_real_keystore() {
        CryptoEngine.initialize(context)
        val mode = CryptoEngine.identityStorageMode()
        // The policy must have recorded ONE of the three storage postures.
        assertTrue(
            "unexpected storage mode: $mode",
            mode == "KEYSTORE" || mode == "LEGACY_PREFS" || mode == "SOFTWARE_FALLBACK"
        )
        val identity1 = CryptoEngine.getIdentityPublicKeyBase64()
        assertTrue(identity1.isNotEmpty())
        // A second initialize in the same process must NOT mint a new identity.
        CryptoEngine.initialize(context)
        assertEquals(identity1, CryptoEngine.getIdentityPublicKeyBase64())
    }

    @Test
    fun cryptoEngine_identity_is_stable_while_the_ephemeral_plane_rotates() {
        CryptoEngine.initialize(context)
        val before = CryptoEngine.getIdentityPublicKeyBase64()
        // The ephemeral plane is NOT the identity plane: a rotation must
        // change the ephemeral key while the identity key stays put.
        val eph1 = CryptoEngine.getEphemeralSnapshot().publicKeyB64
        CryptoEngine.rotateEphemeralKey()
        val eph2 = CryptoEngine.getEphemeralSnapshot().publicKeyB64
        assertNotEquals(eph1, eph2)
        assertEquals(before, CryptoEngine.getIdentityPublicKeyBase64())
    }

    @Test
    fun locationEngine_permission_tier_reads_the_real_system_state() {
        val engine = LocationEngine(context)
        // No grant dialogs on CI: the tier is whatever the emulator's default
        // grant state is — the contract is that it resolves to a VALID tier
        // and that the derived permission booleans agree with each other.
        val tier = engine.permissionTier()
        val any = engine.hasAnyLocationPermission()
        when (tier) {
            LocationLogic.Tier.NONE -> assertTrue(!any)
            LocationLogic.Tier.COARSE -> assertTrue(any && !engine.hasPermission())
            LocationLogic.Tier.FINE -> assertTrue(any && engine.hasPermission())
        }
    }

    @Test
    fun observatoryApi_allowlist_resolves_on_device() {
        val api = ObservatoryApi("https://wildfire-observatory.onrender.com")
        assertEquals(
            "https://wildfire-observatory.onrender.com/api/reports",
            api.resolveTarget("/api/reports")
        )
        assertTrue(
            api.resolveTarget("https://api.open-meteo.com/v1/forecast?latitude=1") != null
        )
        assertEquals(null, api.resolveTarget("https://evil.example.com/collect"))
    }
}
