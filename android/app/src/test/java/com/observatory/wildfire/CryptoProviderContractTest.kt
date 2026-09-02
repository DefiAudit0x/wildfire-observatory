package com.observatory.wildfire

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.security.KeyAgreement
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.NoSuchAlgorithmException
import java.security.Provider
import java.security.Security
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Regression gate for the v1.0.3 FIELD CRASH (owner's Xiaomi, MIUI):
 * MeshService.onCreate died with "NoSuchAlgorithmException: no such
 * algorithm: EC for provider BC" because CryptoEngine pinned "BC" on every
 * JCA factory call. Android ships a STRIPPED BouncyCastle registered under
 * the name "BC" (no EC KeyPairGenerator among its removals), and the bundled
 * full bcprov could never replace it — Security.insertProviderAt returns -1
 * silently when a provider of the same name exists — so every pinned call
 * resolved to the OS's stripped provider and exploded.
 *
 * How these tests stay honest: @Before installs a provider named "BC" with
 * ZERO services at priority 1 — the JVM equivalent of Android's stripped OS
 * provider. The JVM default list (no BouncyCastle at all) makes this a
 * faithful stand-in.
 *
 *  - [pinnedBCResolutionFailsExactlyLikeTheFieldCrash] proves the environment
 *    reproduces the field conditions: the OLD code style MUST throw here.
 *    Without this self-check the survival test could pass vacuously.
 *  - [defaultProviderResolutionSurvivesStrippedBC] walks the ENTIRE
 *    algorithm chain CryptoEngine uses — EC P-256 generation, ECDH
 *    agreement, SHA-256 derive, AES-256-GCM round trip, SHA256withECDSA
 *    sign/verify, KeyFactory X.509/PKCS#8 decode — with NO provider pinned,
 *    asserting the default-resolution contract.
 *
 * COUPLING OBLIGATION: the algorithm strings below mirror CryptoEngine
 * (EC / secp256r1 / ECDH / SHA256withECDSA / AES/GCM/NoPadding). If you
 * change CryptoEngine's algorithm set, change them here in the same commit.
 */
class CryptoProviderContractTest {

    private fun installStrippedBC(): Int =
        Security.insertProviderAt(
            object : Provider(
                "BC", 1.0,
                "Test stub: mimics Android's stripped OS BouncyCastle (no services)"
            ) {},
            1
        )

    @Before
    fun strippedBCIsInstalledAtHighestPriority() {
        val at = installStrippedBC()
        assertTrue(
            "Expected to insert the stripped 'BC' stub at position 1; got $at. " +
                "A provider named BC already exists in this JVM, so this test " +
                "class cannot reproduce the field environment.",
            at == 1
        )
    }

    @After
    fun removeStub() {
        Security.removeProvider("BC")
    }

    @Test
    fun pinnedBCResolutionFailsExactlyLikeTheFieldCrash() {
        // The field-crash fingerprint, reproduced on demand: this is what
        // MeshService.onCreate did on the owner's device before v1.0.3.
        assertThrows(NoSuchAlgorithmException::class.java) {
            KeyPairGenerator.getInstance("EC", "BC")
        }
        assertThrows(NoSuchAlgorithmException::class.java) {
            Signature.getInstance("SHA256withECDSA", "BC")
        }
    }

    @Test
    fun defaultProviderResolutionSurvivesStrippedBC() {
        // --- identity generation (CryptoEngine.generateECKeyPair) -----------
        val kpg = KeyPairGenerator.getInstance("EC")
        kpg.initialize(ECGenParameterSpec("secp256r1"))
        val alice = kpg.generateKeyPair()
        val bob = kpg.generateKeyPair()

        // --- KeyFactory decode (CryptoEngine.decodePublicKey) ---------------
        val bobDecoded = KeyFactory.getInstance("EC")
            .generatePublic(X509EncodedKeySpec(bob.public.encoded))
        assertArrayEquals(bob.public.encoded, bobDecoded.encoded)

        // --- ECDH agreement (CryptoEngine.ecdhKeyAgreement) ------------------
        val kaA = KeyAgreement.getInstance("ECDH")
        kaA.init(alice.private)
        kaA.doPhase(bobDecoded, true)
        val kaB = KeyAgreement.getInstance("ECDH")
        kaB.init(bob.private)
        kaB.doPhase(alice.public, true)
        assertArrayEquals(kaA.generateSecret(), kaB.generateSecret())

        // --- key derive (CryptoEngine.deriveAESKey) ---------------------------
        val aesKey = MessageDigest.getInstance("SHA-256")
            .digest(kaA.generateSecret()).copyOf(256 / 8)

        // --- AES-256-GCM round trip (CryptoEngine.encrypt/decryptFromPeer) ---
        val iv = ByteArray(12).also { java.security.SecureRandom().nextBytes(it) }
        val plaintext = "mesh-frame-payload".toByteArray(Charsets.UTF_8)
        val enc = Cipher.getInstance("AES/GCM/NoPadding")
        enc.init(Cipher.ENCRYPT_MODE, SecretKeySpec(aesKey, "AES"), GCMParameterSpec(128, iv))
        val ciphertext = enc.doFinal(plaintext)
        val dec = Cipher.getInstance("AES/GCM/NoPadding")
        dec.init(Cipher.DECRYPT_MODE, SecretKeySpec(aesKey, "AES"), GCMParameterSpec(128, iv))
        assertArrayEquals(plaintext, dec.doFinal(ciphertext))

        // --- ECDSA sign/verify (CryptoEngine.signData/verifySignature) -------
        val sig = Signature.getInstance("SHA256withECDSA")
        sig.initSign(alice.private)
        sig.update(ciphertext)
        val signature = sig.sign()
        val ver = Signature.getInstance("SHA256withECDSA")
        ver.initVerify(alice.public)
        ver.update(ciphertext)
        assertTrue(ver.verify(signature))

        // --- PKCS#8 decode path (CryptoEngine legacy identity load) ----------
        val privDecoded = KeyFactory.getInstance("EC")
            .generatePrivate(PKCS8EncodedKeySpec(alice.private.encoded))
        assertEquals(alice.private, privDecoded)
    }
}
