import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import logger from "./logger.js";

/**
 * ARC-M09: the AES-256-GCM envelope (12-byte IV | auth tag | ciphertext,
 * "."-joined base64) used to be hand-rolled independently in volunteers.ts
 * (volunteer PII) and sos.ts (SOS profiles) — two copies that could drift on
 * IV length, encoding, or auth-tag handling. This module is the single
 * envelope; each caller keeps its OWN key-derivation domain, which is correct
 * design (different data domains must not share keys) and is unchanged here.
 */

export function encryptAead(plaintext: string | Buffer, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, "utf8");
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}

/** Returns null on ANY failure (bad format, wrong key, tampered tag) — never throws. */
export function decryptAead(token: string | undefined, key: Buffer): Buffer | null {
  if (!token) return null;
  try {
    const [ivB64, tagB64, dataB64] = token.split(".");
    if (!ivB64 || !tagB64 || !dataB64) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  } catch (err) {
    logger.debug({ err }, "AEAD decryption failed");
    return null;
  }
}
