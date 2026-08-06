import jwt from "jsonwebtoken";
import config from "./config.js";

const MESH_TOKEN_TTL_SECONDS = 150; // short-lived; refreshed by clients

export interface MeshTokenPayload {
  scope: "mesh";
  deviceId: string;
}

export function createMeshToken(deviceId: string): string {
  const payload: MeshTokenPayload = { scope: "mesh", deviceId };
  return jwt.sign(payload, config.jwtSecret, { expiresIn: MESH_TOKEN_TTL_SECONDS });
}

export function verifyMeshToken(token: string): MeshTokenPayload | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret) as MeshTokenPayload;
    if (!decoded || decoded.scope !== "mesh" || typeof decoded.deviceId !== "string") return null;
    return decoded;
  } catch {
    return null;
  }
}