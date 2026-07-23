/**
 * Secure Mesh Bridge
 * 
 * Unified interface for Bluetooth Mesh networking.
 * When running inside the Android WebView, delegates to `window.AndroidBridge`.
 * When running in a browser, provides a no-op fallback.
 * 
 * Security layers:
 * - E2EE: AES-256-GCM via Web Crypto API (browser) or native (Android)
 * - ECDSA signatures via Web Crypto (browser) or SpongyCastle (Android)
 * - Anti-replay nonce tracking
 * - Reputation scoring
 * - Lightweight Proof-of-Work anti-spam
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

// Anti-replay cache
const seenNonces = new Set<number>();
const seenMessageHashes = new Set<string>();

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
  return (window as any).AndroidBridge || null;
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
  signData(dataBase64: string): string;
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

    // Add PoW metadata to message
    const enrichedMsg = JSON.stringify({
      payload: plaintext,
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

    // Sign with ephemeral key
    const exportedPub = await crypto.subtle.exportKey("spki", browserKeyPair.publicKey);
    const signData = new Uint8Array([...new Uint8Array(ciphertext), ...iv]);
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      browserKeyPair.privateKey,
      signData
    );

    return {
      ciphertext: arrayBufferToBase64(ciphertext),
      iv: arrayBufferToBase64(iv.buffer),
      signature: arrayBufferToBase64(signature),
      ephemeralId: browserEphemeralId,
      senderPublicKey: arrayBufferToBase64(exportedPub),
      timestamp: Date.now(),
      lat: 0,
      lng: 0,
      nonce: Math.floor(Math.random() * 2 ** 31),
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

    const signData = new Uint8Array([...new Uint8Array(ciphertext), ...new Uint8Array(iv)]);

    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      peerPubKey,
      signature,
      signData
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

  // Poll for peer updates every 5 seconds
  const interval = setInterval(() => {
    const peers = getConnectedPeers();
    if (peers.length > 0) handler(peers);
  }, 5000);

  return () => {
    peerListeners.delete(handler);
    clearInterval(interval);
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

  // Browser fallback
  let nonce = 0;
  const target = BigInt(1) << BigInt(256 - difficulty);
  const encoder = new TextEncoder();

  while (true) {
    const hash = await crypto.subtle.digest("SHA-256", encoder.encode(`${prefix}${nonce}`));
    const hashHex = Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const value = BigInt("0x" + hashHex.substring(0, 16));

    if (value < target) return nonce;
    nonce++;
  }
}

export async function verifyPoW(
  prefix: string,
  nonce: number,
  difficulty: number = 8
): Promise<boolean> {
  const bridge = getAndroidBridge();
  if (bridge) return bridge.verifyPoW(prefix, nonce, difficulty);

  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(`${prefix}${nonce}`));
  const hashHex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const value = BigInt("0x" + hashHex.substring(0, 16));
  const target = BigInt(1) << BigInt(256 - difficulty);
  return value < target;
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
  if (seenNonces.has(nonce)) return false; // Already seen
  seenNonces.add(nonce);
  // Auto-clean old nonces (older than 5 min)
  if (seenNonces.size > 10000) seenNonces.clear();
  return true;
}

export function checkAndRecordMessageHash(hash: string): boolean {
  if (seenMessageHashes.has(hash)) return false;
  seenMessageHashes.add(hash);
  if (seenMessageHashes.size > 5000) seenMessageHashes.clear();
  return true;
}
