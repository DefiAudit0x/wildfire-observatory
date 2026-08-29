import jwt from "jsonwebtoken";
import config from "./config.js";

const MESH_TOKEN_TTL_SECONDS = 150; // short-lived; refreshed by clients

export interface MeshTokenPayload {
  scope: "mesh";
  subject: string;
}

export function createMeshToken(subject: string): string {
  const payload: MeshTokenPayload = { scope: "mesh", subject };
  return jwt.sign(payload, config.jwtSecret, { expiresIn: MESH_TOKEN_TTL_SECONDS });
}

export function verifyMeshToken(token: string): MeshTokenPayload | null {
  try {
    const decoded = jwt.verify(token, config.jwtSecret) as MeshTokenPayload;
    if (!decoded || decoded.scope !== "mesh" || typeof decoded.subject !== "string" || !decoded.subject) return null;
    return decoded;
  } catch {
    return null;
  }
}
