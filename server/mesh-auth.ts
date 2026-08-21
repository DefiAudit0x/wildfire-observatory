import jwt from "jsonwebtoken";
import { createHash, verify as verifySignature } from "node:crypto";
import config from "./config.js";

const MESH_TOKEN_TTL_SECONDS = 150;

export interface MeshTokenPayload {
  scope: "mesh";
  deviceId: string;
  publicKeyFingerprint: string;
}

export function fingerprintPublicKey(publicKey: string): string {
  return createHash("sha256").update(publicKey).digest("hex");
}

export function createMeshToken(deviceId: string, publicKey: string): string {
  const payload: MeshTokenPayload = {
    scope: "mesh",
    deviceId,
    publicKeyFingerprint: fingerprintPublicKey(publicKey),
  };
  return jwt.sign(payload, config.jwtSecret, { expiresIn: MESH_TOKEN_TTL_SECONDS });
}

export function verifyMeshOwnership(publicKey: string, challenge: string, signature: string): boolean {
  try {
    return verifySignature(null, Buffer.from(challenge, "utf8"), publicKey, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export function verifyMeshToken(token: string): MeshTokenPayload | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret) as MeshTokenPayload;
    if (!decoded || decoded.scope !== "mesh" || typeof decoded.deviceId !== "string" ||
        !/^[a-f0-9]{64}$/.test(decoded.publicKeyFingerprint)) return null;
    return decoded;
  } catch {
    return null;
  }
}
