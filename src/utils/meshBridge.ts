/**
 * Secure Mesh Bridge
 * 
 * Unified interface for Bluetooth Mesh networking.
 * When running inside the Android WebView, delegates to `window.AndroidBridge`.
 * When running in a browser, provides a no-op fallback.
 * 
 * Security layers:
 * - E2EE: AES-256-GCM via Web Crypto API (browser) or native (Android)
 * - ECDSA signatures (P-256) via Web Crypto (browser) or SpongyCastle (Android)
 * - Anti-replay nonce tracking
 * - Reputation scoring
 * - Lightweight Proof-of-Work anti-spam (32-bit window, matches CryptoEngine.kt)
 * - Ephemeral identity rotation
 */

type MeshMessageHandler = (message: string, peerId: string, reputation: number) => void;
type PeerUpdateHandler = (peers: PeerInfo[]) => void;

export interface PeerInfo {
  endpointId: string;
  ephemeralId: string;
  lastSeen: number;
  reputation: number;
  hopCount: number;
}

// Anti-replay cache with a REAL time-to-live: entries are purged by age
// (5 minutes, matching the native service), never "when the set got big" —
// a burst of traffic must not wipe the whole replay window at once.
const ANTI_REPLAY_TTL_MS = 5 * 60 * 1000;
const seenNonces = new Map<number, number>();
const seenMessageHashes = new Map<string, number>();

// Ephemeral key pair for E2EE (browser fallback)
let browserKeyPair: CryptoKeyPair | null = null;
let browserEphemeralId = "";
let browserPublicKeyBase64 = "";

// Reputation cache
const reputationCache = new Map<string, number>();

// Listeners
const messageListeners = new Set<MeshMessageHandler>();
const peerListeners = new Set<PeerUpdateHandler>();

// ========================
// INITIALIZATION
// ========================

export async function initMesh(): Promise<{ supported: boolean; deviceId: string }> {
  const bridge = getAndroidBridge();

  if (bridge) {
    // Android native path
    const deviceId = bridge.getDeviceId();
    return { supported: true, deviceId };
  }

  // Browser fallback: generate ephemeral key pair
  try {
    browserKeyPair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveKey", "deriveBits"]
    );

    const exported = await crypto.subtle.exportKey("spki", browserKeyPair.publicKey);
    browserPublicKeyBase64 = arrayBufferToBase64(exported);
    browserEphemeralId = generateId();

    return { supported: false, deviceId: browserEphemeralId };
  } catch {
    return { supported: false, deviceId: "browser-unsupported" };
  }
}

function getAndroidBridge(): AndroidBridge | null {
  if (typeof window === "undefined") return null;
  return (window as any).AndroidBridge || null;
}

export function isMeshSupported(): boolean {
  const bridge = getAndroidBridge();
  if (!bridge) return false;
  // The truth source is the bridge itself: presence of the interface is not
  // the capability (an app shell could expose the object yet lack the radio).
  try {
    return bridge.isMeshSupported() !== false;
  } catch {
    // Legacy bridges without the method: interface presence implies support.
    return true;
  }
}

interface AndroidBridge {
  isMeshSupported(): boolean;
  getDeviceId(): string;
  getPublicKey(): string;
  getIdentityKey(): string;
  broadcastMessage(plaintext: string, type: string, lat: number, lng: number): void;
  encryptForPeer(peerPublicKey: string, plaintext: string, lat: number, lng: number): string;
  decryptFromPeer(jsonMessage: string, peerPublicKey?: string): string;
  getConnectedPeers(): string;
  getPeerReputation(endpointId: string): number;
  solvePoW(prefix: string, difficulty: number): number;
  verifyPoW(prefix: string, nonce: number, difficulty: number): boolean;
}

// ========================
// MESSAGING API
// ========================

export function broadcastMessage(
  plaintext: string,
  type: string = "report",
  lat: number = 0,
  lng: number = 0
): void {
  const bridge = getAndroidBridge();

  if (bridge) {
    // Solve Proof-of-Work first (anti-spam)
    const prefix = `${Date.now()}-${bridge.getDeviceId()}`;
    const nonce = bridge.solvePoW(prefix, 8);

    // Add PoW metadata to message, plus the type/coordinates needed by any
    // ONLINE device that receives this message to relay it to /api/reports
    // (store-and-forward gateway: A offline → B → C → D online → API).
    const enrichedMsg = JSON.stringify({
      payload: plaintext,
      type,
      lat,
      lng,
      ts: Date.now(),
      powNonce: nonce,
      powPrefix: prefix,
      powDifficulty: 8,
    });

    bridge.broadcastMessage(enrichedMsg, type, lat, lng);
    return;
  }

  // Browser fallback: no actual mesh, just log
  console.log("[MeshBridge] Browser broadcast (no-op):", {
    plaintext,
    type,
    lat,
    lng,
    ephemeralId: browserEphemeralId,
  });
}

export function encryptForPeer(
  peerPublicKey: string,
  plaintext: string,
  lat: number = 0,
  lng: number = 0
): Promise<EncryptedMessage | null> {
  const bridge = getAndroidBridge();

  if (bridge) {
    const json = bridge.encryptForPeer(peerPublicKey, plaintext, lat, lng);
    return Promise.resolve(JSON.parse(json));
  }

  // Browser fallback: Web Crypto API E2EE
  return browserEncrypt(peerPublicKey, plaintext);
}

export function decryptFromPeer(
  encrypted: EncryptedMessage,
  peerPublicKey?: string
): Promise<string | null> {
  const bridge = getAndroidBridge();

  if (bridge) {
    const result = bridge.decryptFromPeer(JSON.stringify(encrypted), peerPublicKey);
    return Promise.resolve(result || null);
  }

  return browserDecrypt(encrypted, peerPublicKey);
}

interface EncryptedMessage {
  ciphertext: string;
  iv: string;
  signature: string;
  ephemeralId: string;
  senderPublicKey: string;
  timestamp: number;
  lat: number;
  lng: number;
  nonce: number;
  messageId?: string;
  type?: string;
  hopCount?: number;
}

// ========================
// WEB CRYPTO API E2EE (browser fallback)
// ========================

async function browserEncrypt(
  peerPublicKeyBase64: string,
  plaintext: string
): Promise<EncryptedMessage | null> {
  try {
    if (!browserKeyPair) return null;

    // Import peer's public key
    const peerPubKey = await crypto.subtle.importKey(
      "spki",
      base64ToArrayBuffer(peerPublicKeyBase64),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      []
    );

    // Derive shared secret
    const sharedBits = await crypto.subtle.deriveBits(
      { name: "ECDH", public: peerPubKey },
      browserKeyPair.privateKey,
      256
    );

    // Import as AES-256-GCM key
    const aesKey = await crypto.subtle.importKey(
      "raw",
      sharedBits,
      { name: "AES-GCM" },
      false,
      ["encrypt"]
    );

    // Encrypt
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      aesKey,
      encoded
    );

    // Sign the CANONICAL signed metadata (audit round 11): the native
    // contract (MeshWire.buildSignedData) covers the length-prefixed
    // ciphertext, iv AND every relay-invariant field — the browser fallback
    // previously signed only "ciphertext + iv", a scheme mismatch that
    // produced signatures no native verifier would accept and vice versa.
    const exportedPub = await crypto.subtle.exportKey("spki", browserKeyPair.publicKey);
    const messageId = generateId();
    const timestamp = Date.now();
    const nonce = Math.floor(Math.random() * 2 ** 31);
    const canonical = buildSignedData(
      new Uint8Array(ciphertext),
      new Uint8Array(iv),
      messageId,
      "report",
      0,
      browserEphemeralId,
      arrayBufferToBase64(exportedPub),
      timestamp,
      nonce,
      0,
      0
    );
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      browserKeyPair.privateKey,
      canonical
    );

    return {
      ciphertext: arrayBufferToBase64(ciphertext),
      iv: arrayBufferToBase64(iv.buffer),
      signature: arrayBufferToBase64(signature),
      ephemeralId: browserEphemeralId,
      senderPublicKey: arrayBufferToBase64(exportedPub),
      timestamp,
      lat: 0,
      lng: 0,
      nonce,
      messageId,
      type: "report",
      hopCount: 0,
    };
  } catch (err) {
    console.error("[MeshBridge] Browser encrypt failed:", err);
    return null;
  }
}

async function browserDecrypt(
  encrypted: EncryptedMessage,
  peerPublicKeyBase64?: string
): Promise<string | null> {
  try {
    if (!browserKeyPair) return null;

    const pubKeyB64 = peerPublicKeyBase64 || encrypted.senderPublicKey;

    // Import sender's public key
    const peerPubKey = await crypto.subtle.importKey(
      "spki",
      base64ToArrayBuffer(pubKeyB64),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      []
    );

    // Verify signature
    const ciphertext = base64ToArrayBuffer(encrypted.ciphertext);
    const iv = base64ToArrayBuffer(encrypted.iv);
    const signature = base64ToArrayBuffer(encrypted.signature);

    // Verify signature over the CANONICAL metadata (audit round 11): mirrors
    // the native MeshWire.buildSignedData — ciphertext + iv + every
    // relay-invariant field, length-prefixed. The old ciphertext+iv-only
    // verification would reject signatures produced by native peers.
    const canonical = buildSignedData(
      new Uint8Array(ciphertext),
      new Uint8Array(iv),
      encrypted.messageId || "",
      encrypted.type || "",
      0,
      encrypted.ephemeralId,
      encrypted.senderPublicKey,
      encrypted.timestamp,
      encrypted.nonce || 0,
      encrypted.lat || 0,
      encrypted.lng || 0
    );

    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      peerPubKey,
      signature,
      canonical
    );

    if (!valid) {
      console.warn("[MeshBridge] ECDSA signature verification failed!");
      return null;
    }

    // Derive shared secret
    const sharedBits = await crypto.subtle.deriveBits(
      { name: "ECDH", public: peerPubKey },
      browserKeyPair.privateKey,
      256
    );

    const aesKey = await crypto.subtle.importKey(
      "raw",
      sharedBits,
      { name: "AES-GCM" },
      false,
      ["decrypt"]
    );

    // Decrypt
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(iv) },
      aesKey,
      ciphertext
    );

    return new TextDecoder().decode(decrypted);
  } catch (err) {
    console.error("[MeshBridge] Browser decrypt failed:", err);
    return null;
  }
}

// ========================
// PEER MANAGEMENT
// ========================

export function getConnectedPeers(): PeerInfo[] {
  const bridge = getAndroidBridge();

  if (bridge) {
    try {
      const json = bridge.getConnectedPeers();
      return JSON.parse(json);
    } catch {
      return [];
    }
  }

  return [];
}

export function getPeerReputation(endpointId: string): number {
  const bridge = getAndroidBridge();
  if (bridge) return bridge.getPeerReputation(endpointId);
  return reputationCache.get(endpointId) || 0;
}

// ========================
// EVENT SUBSCRIPTION
// ========================

// A SINGLE shared poller serves every onPeersUpdate subscriber (one interval
// per hook instance would fire N polls per tick and drift them apart).
const PEER_POLL_MS = 5000;
let peerPollInterval: number | null = null;

export function onMeshMessage(handler: MeshMessageHandler): () => void {
  messageListeners.add(handler);

  const bridge = getAndroidBridge();
  if (bridge) {
    (window as any).onMeshMessage = (message: string) => {
      try {
        const parsed = JSON.parse(message);
        const peerId = parsed.peerId || "unknown";
        const reputation = bridge.getPeerReputation(peerId);
        handler(parsed.payload || message, peerId, reputation);
      } catch {
        handler(message, "unknown", 0);
      }
    };
  }

  return () => {
    messageListeners.delete(handler);
    if (bridge) delete (window as any).onMeshMessage;
  };
}

export function onPeersUpdate(handler: PeerUpdateHandler): () => void {
  peerListeners.add(handler);

  if (peerPollInterval === null && typeof window !== "undefined") {
    peerPollInterval = window.setInterval(() => {
      const peers = getConnectedPeers();
      // Always notify — including the empty list: a node counter that keeps
      // its last value when the room empties is a stale counter.
      peerListeners.forEach((h) => {
        try {
          h(peers);
        } catch {
          // a failing subscriber must not silence the others
        }
      });
    }, PEER_POLL_MS);
  }

  return () => {
    peerListeners.delete(handler);
    if (peerListeners.size === 0 && peerPollInterval !== null) {
      window.clearInterval(peerPollInterval);
      peerPollInterval = null;
    }
  };
}

export function onMeshReady(handler: (deviceId: string) => void): () => void {
  const handlerFn = (e: CustomEvent) => {
    handler(e.detail?.deviceId || "");
  };

  window.addEventListener("meshReady", handlerFn as EventListener);

  // Also check if bridge already exists
  const bridge = getAndroidBridge();
  if (bridge) {
    handler(bridge.getDeviceId());
  }

  return () => window.removeEventListener("meshReady", handlerFn as EventListener);
}

// ========================
// LIGHTWEIGHT PROOF-OF-WORK (browser fallback)
// ========================

export async function solvePoW(prefix: string, difficulty: number = 8): Promise<number> {
  const bridge = getAndroidBridge();
  if (bridge) return bridge.solvePoW(prefix, difficulty);

  // Browser fallback — MUST match CryptoEngine.kt / MeshWire.ProofOfWork
  // semantics exactly: length-prefixed challenge framing (the naive
  // "${prefix}${nonce}" concatenation was ambiguous across the prefix/nonce
  // boundary) and the top 8 hex chars (32 bits) compared against
  // 2^(32-difficulty). (Comparing 64 bits against a 256-bit target would
  // pass ~always.)
  const encoder = new TextEncoder();
  const MAX_ITERATIONS = 5_000_000;

  const solveTarget = difficultyTarget(difficulty);
  if (solveTarget === null) return -1; // out-of-band difficulty: unsolvable

  let nonce = 0;
  while (nonce < MAX_ITERATIONS) {
    const hash = await crypto.subtle.digest("SHA-256", encoder.encode(powChallenge(prefix, nonce)));
    const hashHex = Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const value = BigInt("0x" + hashHex.substring(0, 8));

    if (value < solveTarget) return nonce;
    nonce++;
  }
  return -1;
}

export async function verifyPoW(
  prefix: string,
  nonce: number,
  difficulty: number = 8
): Promise<boolean> {
  const bridge = getAndroidBridge();
  if (bridge) return bridge.verifyPoW(prefix, nonce, difficulty);

  const target = difficultyTarget(difficulty);
  if (target === null) return false;
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(powChallenge(prefix, nonce)));
  const hashHex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const value = BigInt("0x" + hashHex.substring(0, 8));
  return value < target;
}

/**
 * Canonical PoW challenge framing (audit round 11): matches
 * MeshWire.ProofOfWork.prefixValue — the naive "$prefix$nonce" let colliding
 * (prefix, nonce) pairs ("a", 12) vs ("a1", 2) hash identically; the
 * length-prefix makes each pair hash apart.
 */
function powChallenge(prefix: string, nonce: number): string {
  return `${prefix.length}:${prefix}:${nonce}`;
}

/** Difficulty target, or null when out of band (audit: no silent clamping). */
function difficultyTarget(difficulty: number): bigint | null {
  const d = Math.floor(difficulty);
  if (d < 1 || d > 31) return null;
  return BigInt(1) << BigInt(32 - d);
}

// ========================
// UTILITY
// ========================

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Canonical signed metadata — byte-identical to MeshWire.buildSignedData
 * (audit round 11): each field is emitted as a 4-byte big-endian length
 * prefix followed by the UTF-8 bytes. Order MUST stay in sync with the
 * Kotlin implementation.
 */
function buildSignedData(
  ciphertext: Uint8Array,
  iv: Uint8Array,
  messageId: string,
  type: string,
  hopCount: number,
  origEphemeralId: string,
  origPublicKey: string,
  timestamp: number,
  nonce: number,
  lat: number,
  lng: number
): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [
    ciphertext,
    iv,
    encoder.encode(messageId),
    encoder.encode(type),
    encoder.encode(String(hopCount)),
    encoder.encode(origEphemeralId),
    encoder.encode(origPublicKey),
    encoder.encode(String(timestamp)),
    encoder.encode(String(nonce)),
    encoder.encode(String(lat)),
    encoder.encode(String(lng)),
  ];
  const out: number[] = [];
  for (const part of parts) {
    out.push(
      (part.length >>> 24) & 0xff,
      (part.length >>> 16) & 0xff,
      (part.length >>> 8) & 0xff,
      part.length & 0xff
    );
    for (let i = 0; i < part.length; i++) out.push(part[i]);
  }
  return new Uint8Array(out);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 16 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

// ========================
// ANTI-REPLAY: track incoming message nonces
// ========================

export function checkAndRecordNonce(nonce: number): boolean {
  const now = Date.now();
  if (seenNonces.has(nonce) && seenNonces.get(nonce)! > now - ANTI_REPLAY_TTL_MS) {
    return false; // Already seen inside the replay window
  }
  seenNonces.set(nonce, now);
  if (seenNonces.size > 5000) {
    for (const [k, ts] of seenNonces) {
      if (ts <= now - ANTI_REPLAY_TTL_MS) seenNonces.delete(k);
    }
  }
  return true;
}

export function checkAndRecordMessageHash(hash: string): boolean {
  const now = Date.now();
  if (seenMessageHashes.has(hash) && seenMessageHashes.get(hash)! > now - ANTI_REPLAY_TTL_MS) {
    return false;
  }
  seenMessageHashes.set(hash, now);
  if (seenMessageHashes.size > 5000) {
    for (const [k, ts] of seenMessageHashes) {
      if (ts <= now - ANTI_REPLAY_TTL_MS) seenMessageHashes.delete(k);
    }
  }
  return true;
}
