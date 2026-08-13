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
  publicKey: string;
  lastSeen: number;
  reputation: number;
}

// Anti-replay cache with a REAL time-to-live: entries are purged by age
// (5 minutes, matching the native service), never "when the set got big" —
// a burst of traffic must not wipe the whole replay window at once.
const ANTI_REPLAY_TTL_MS = 5 * 60 * 1000;
const seenNonces = new Map<number, number>();
const seenMessageHashes = new Map<string, number>();

// Ephemeral key pairs for E2EE (browser fallback). WebCrypto forbids
// mixing ECDH and ECDSA usages on one key, so the fallback mirrors the
// native design with TWO pairs: an ECDH pair (key agreement + AES-GCM) and
// an ECDSA pair (canonical-metadata signatures). The ECDH public key rides
// in senderPublicKey (a native wire frame would carry it the same way); the
// ECDSA public key rides in signatureKey so verification is self-consistent.
// NOTE: browser-fallback signatures verify ONLY against signatureKey — a
// native verifier checks senderPublicKey, so fallback messages are
// dev/test-only by design (the WebView path always uses the native bridge).
let browserKeyPair: CryptoKeyPair | null = null;
let browserSignKey: CryptoKeyPair | null = null;
let browserEphemeralId = "";
let browserPublicKeyBase64 = "";
let initMeshPromise: Promise<{ supported: boolean; deviceId: string }> | null = null;

// Retired private keys (audit round 12 — recipient-side rotation): a message
// encrypted to our previously-advertised key while we rotate stays
// decryptable; browserDecrypt tries the current private key first, then each
// retired one in retirement order. Rotation (re-initMesh) retires the old
// pair. Bound: 2 retained keys cover the whole message TTL window (10 min)
// against the 1h rotation period — see CryptoEngine.retiredEphemeralKeyPairs.
const retiredPrivateKeys: CryptoKey[] = [];

// Reputation cache
const reputationCache = new Map<string, number>();

// Listeners
const messageListeners = new Set<MeshMessageHandler>();
const peerListeners = new Set<PeerUpdateHandler>();

// ========================
// INITIALIZATION
// ========================

export async function initMesh(): Promise<{ supported: boolean; deviceId: string }> {
  if (initMeshPromise) return initMeshPromise;
  initMeshPromise = initMeshInternal();
  try {
    return await initMeshPromise;
  } finally {
    initMeshPromise = null;
  }
}

async function initMeshInternal(): Promise<{ supported: boolean; deviceId: string }> {
  const bridge = getAndroidBridge();

  if (bridge) {
    // Android native path
    try {
      const deviceId = bridge.getDeviceId();
      return typeof deviceId === "string" && deviceId.length > 0
        ? { supported: true, deviceId }
        : { supported: false, deviceId: "native-unavailable" };
    } catch {
      return { supported: false, deviceId: "native-unavailable" };
    }
  }

  // Browser fallback: generate ephemeral key pairs
  try {
    const previous = browserKeyPair;
    browserKeyPair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveKey", "deriveBits"]
    );
    browserSignKey = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    );
    // Retire the previous pair for in-transit decryption (audit round 12).
    if (previous) {
      retiredPrivateKeys.unshift(previous.privateKey);
      while (retiredPrivateKeys.length > 2) retiredPrivateKeys.pop();
    }

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
  if (!bridge || typeof bridge.isMeshSupported !== "function") return false;
  try {
    return bridge.isMeshSupported() === true;
  } catch {
    return false;
  }
}

export interface MeshServiceState {
  state: "unknown" | "starting" | "connected" | "disconnected" | "failed" | "unavailable";
  ready: boolean;
}

/**
 * Returns the latest native service snapshot without requiring a prior event
 * listener. The Android bridge also emits meshServiceState/meshReady events
 * for reactive consumers, but late subscribers can query this value directly.
 */
const MESH_SERVICE_STATES: readonly MeshServiceState["state"][] = [
  "unknown", "starting", "connected", "disconnected", "failed", "unavailable",
];

export function getMeshServiceState(): MeshServiceState {
  if (typeof window === "undefined") return { state: "unknown", ready: false };
  const state = (window as any).__meshServiceState;
  if (!state || !MESH_SERVICE_STATES.includes(state.state)) return { state: "unknown", ready: false };
  return {
    state: state.state,
    ready: state.ready === true,
  };
}

/**
 * Our own current ephemeral public key (SPKI base64). Mirror of the native
 * bridge's getPublicKey(); useful for test vectors and for addressing
 * ourselves where the bootstrap has not completed. Empty before initMesh.
 */
export function getLocalPublicKeyBase64(): string {
  const bridge = getAndroidBridge();
  if (bridge) {
    try {
      const key = bridge.getPublicKey();
      return typeof key === "string" ? key : "";
    } catch {
      return "";
    }
  }
  return browserPublicKeyBase64;
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
): boolean {
  const bridge = getAndroidBridge();

  if (bridge) {
    try {
      // Solve Proof-of-Work first (anti-spam)
      const prefix = `${Date.now()}-${bridge.getDeviceId()}`;
      const nonce = bridge.solvePoW(prefix, 8);

    // Audit A9/B6: -1 means the solver gave up (out-of-band difficulty or
    // iteration budget). Broadcasting anyway would enqueue a frame every
    // receiver drops (powNonce < 0), i.e. a silent guaranteed-failure send.
    // Fail locally, visibly, instead of poisoning the mesh queue.
    if (nonce < 0) {
      console.warn("[MeshBridge] PoW solve failed; message not broadcast");
      return false;
    }

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
      return true;
    } catch (err) {
      console.error("[MeshBridge] Native broadcast failed:", err);
      return false;
    }
  }

  // Browser fallback: no actual mesh, just log
  console.log("[MeshBridge] Browser broadcast (no-op):", {
    plaintext,
    type,
    lat,
    lng,
    ephemeralId: browserEphemeralId,
  });
  return false;
}

export function encryptForPeer(
  peerPublicKey: string,
  plaintext: string,
  lat: number = 0,
  lng: number = 0
): Promise<EncryptedMessage | null> {
  const bridge = getAndroidBridge();

  if (bridge) {
    try {
      const json = bridge.encryptForPeer(peerPublicKey, plaintext, lat, lng);
      const parsed = JSON.parse(json) as EncryptedMessage;
      return Promise.resolve(isEncryptedMessageShape(parsed) ? parsed : null);
    } catch {
      return Promise.resolve(null);
    }
  }

  // Browser fallback: Web Crypto API E2EE
  return browserEncrypt(peerPublicKey, plaintext, lat, lng);
}

export function decryptFromPeer(
  encrypted: EncryptedMessage,
  peerPublicKey?: string
): Promise<string | null> {
  const bridge = getAndroidBridge();

  if (bridge) {
    try {
      const result = bridge.decryptFromPeer(JSON.stringify(encrypted), peerPublicKey);
      return Promise.resolve(result || null);
    } catch {
      return Promise.resolve(null);
    }
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
  /** ECDSA public key (SPKI) — browser fallback only; see the keypairs note. */
  signatureKey?: string;
}

// ========================
// WEB CRYPTO API E2EE (browser fallback)
// ========================

async function browserEncrypt(
  peerPublicKeyBase64: string,
  plaintext: string,
  lat: number = 0,
  lng: number = 0,
  type: string = "report"
): Promise<EncryptedMessage | null> {
  try {
    if (!browserKeyPair || !browserSignKey) return null;

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
    const exportedSignPub = await crypto.subtle.exportKey("spki", browserSignKey.publicKey);
    const messageId = generateId();
    const timestamp = Date.now();
    const nonce = crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
    const canonical = buildSignedData(
      new Uint8Array(ciphertext),
      new Uint8Array(iv),
      messageId,
      type,
      0,
      browserEphemeralId,
      arrayBufferToBase64(exportedPub),
      timestamp,
      nonce,
      lat,
      lng
    );
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      browserSignKey.privateKey,
      canonical
    );

    return {
      ciphertext: arrayBufferToBase64(ciphertext),
      iv: arrayBufferToBase64(iv.buffer),
      signature: arrayBufferToBase64(signature),
      ephemeralId: browserEphemeralId,
      senderPublicKey: arrayBufferToBase64(exportedPub),
      timestamp,
      lat,
      lng,
      nonce,
      messageId,
      type,
      hopCount: 0,
      signatureKey: arrayBufferToBase64(exportedSignPub),
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

    if (!hasRequiredEncryptedMetadata(encrypted)) return null;
    if (typeof encrypted.signatureKey !== "string" || encrypted.signatureKey.length === 0) return null;
    if (peerPublicKeyBase64 && encrypted.senderPublicKey !== peerPublicKeyBase64) return null;

    // Signature verification uses the sender's ECDSA key carried in the
    // fallback envelope. The expected peer ECDH key, when supplied, is also
    // checked above so the envelope cannot silently decrypt as another peer.
    const verifyPubKeyB64 = encrypted.signatureKey;

    // Import sender's public key
    const peerPubKey = await crypto.subtle.importKey(
      "spki",
      base64ToArrayBuffer(verifyPubKeyB64),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
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
      encrypted.messageId!,
      encrypted.type!,
      0,
      encrypted.ephemeralId,
      encrypted.senderPublicKey,
      encrypted.timestamp,
      encrypted.nonce!,
      encrypted.lat,
      encrypted.lng
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

    // Key agreement uses the sender's ECDH public key (senderPublicKey).
    const senderEcdhPub = await crypto.subtle.importKey(
      "spki",
      base64ToArrayBuffer(encrypted.senderPublicKey),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      []
    );

    // Decrypt with the CURRENT private key first, then each RETIRED one
    // (audit round 12 — recipient-side rotation): a message encrypted to our
    // previously-advertised key — in transit across the moment we rotated —
    // stays decryptable. Wrong keys just fail ECDH/decrypt per attempt.
    const candidates: CryptoKey[] = browserKeyPair
      ? [browserKeyPair.privateKey, ...retiredPrivateKeys]
      : [];
    for (const candidate of candidates) {
      try {
        const sharedBits = await crypto.subtle.deriveBits(
          { name: "ECDH", public: senderEcdhPub },
          candidate,
          256
        );

        const aesKey = await crypto.subtle.importKey(
          "raw",
          sharedBits,
          { name: "AES-GCM" },
          false,
          ["decrypt"]
        );

        const decrypted = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: new Uint8Array(iv) },
          aesKey,
          ciphertext
        );

        // Record replay state only after authenticated ciphertext has been
        // successfully decrypted. A signed frame that cannot be decrypted
        // must remain retryable while key rotation or state catches up.
        if (!checkAndRecordMessageNonce(encrypted.messageId!, encrypted.nonce!)) {
          console.warn("[MeshBridge] Replay detected");
          return null;
        }

        return new TextDecoder().decode(decrypted);
      } catch {
        // wrong key candidate — try the next one
      }
    }
    console.warn("[MeshBridge] Decryption failed with all key candidates");
    return null;
  } catch (err) {
    console.error("[MeshBridge] Browser decrypt failed:", err);
    return null;
  }
}

// ========================
// PEER MANAGEMENT
// ========================

function parsePeer(value: unknown): PeerInfo | null {
  if (!value || typeof value !== "object") return null;
  const peer = value as Record<string, unknown>;
  return typeof peer.endpointId === "string" && peer.endpointId.length > 0 &&
    typeof peer.publicKey === "string" && peer.publicKey.length > 0 &&
    typeof peer.lastSeen === "number" && Number.isFinite(peer.lastSeen) &&
    typeof peer.reputation === "number" && Number.isFinite(peer.reputation)
    ? {
        endpointId: peer.endpointId,
        publicKey: peer.publicKey,
        lastSeen: peer.lastSeen,
        reputation: peer.reputation,
      }
    : null;
}

function parsePeers(value: unknown): PeerInfo[] {
  if (!Array.isArray(value)) return [];
  return value.map(parsePeer).filter((peer): peer is PeerInfo => peer !== null);
}

export function getConnectedPeers(): PeerInfo[] {
  const bridge = getAndroidBridge();

  if (bridge) {
    try {
      const json = bridge.getConnectedPeers();
      return parsePeers(JSON.parse(json));
    } catch {
      return [];
    }
  }

  return [];
}

export function getPeerReputation(endpointId: string): number {
  const bridge = getAndroidBridge();
  if (bridge) {
    try {
      const reputation = bridge.getPeerReputation(endpointId);
      return Number.isFinite(reputation) ? reputation : 0;
    } catch {
      return 0;
    }
  }
  return reputationCache.get(endpointId) || 0;
}

// ========================
// EVENT SUBSCRIPTION
// ========================

// A SINGLE shared poller serves every onPeersUpdate subscriber (one interval
// per hook instance would fire N polls per tick and drift them apart).
const PEER_POLL_MS = 5000;
let peerPollInterval: number | null = null;

function installNativeMessageHandler(): void {
  const bridge = getAndroidBridge();
  if (!bridge || messageListeners.size === 0 || typeof window === "undefined") return;
  if ((window as any).__meshNativeHandlerInstalled) return;

  (window as any).onMeshMessage = (message: string) => {
    let parsed: any;
    try {
      parsed = JSON.parse(message);
    } catch {
      messageListeners.forEach((listener) => {
        try {
          listener(message, "unknown", 0);
        } catch {
          // A malformed frame must not let one listener block the others.
        }
      });
      return;
    }
    const peerId = parsed.peerId ?? "unknown";
    const validPeerId = typeof peerId === "string" ? peerId : "unknown";
    let reputation = 0;
    try {
      reputation = bridge.getPeerReputation(validPeerId);
    } catch {
      // A stale bridge must not prevent delivery to web listeners.
    }
    const payload = parsed.payload ?? message;
    messageListeners.forEach((listener) => {
      try {
        listener(payload, validPeerId, reputation);
      } catch {
        // One listener must not block the remaining subscribers.
      }
    });
  };
  (window as any).__meshNativeHandlerInstalled = true;
}

export function onMeshMessage(handler: MeshMessageHandler): () => void {
  messageListeners.add(handler);
  installNativeMessageHandler();

  const onMeshReady = () => installNativeMessageHandler();
  if (typeof window !== "undefined") window.addEventListener("meshReady", onMeshReady);

  return () => {
    messageListeners.delete(handler);
    if (typeof window !== "undefined") window.removeEventListener("meshReady", onMeshReady);
    if (messageListeners.size === 0 && typeof window !== "undefined") {
      delete (window as any).onMeshMessage;
      delete (window as any).__meshNativeHandlerInstalled;
    }
  };
}

export function onPeersUpdate(handler: PeerUpdateHandler): () => void {
  peerListeners.add(handler);

  // Immediate snapshot so UI doesn't wait up to 5s for first poll.
  try {
    handler(getConnectedPeers());
  } catch {
    // ignore
  }

  if (peerPollInterval === null && typeof window !== "undefined") {
    peerPollInterval = window.setInterval(() => {
      const peers = getConnectedPeers();
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
  if (typeof window === "undefined") return () => undefined;
  let called = false;
  const handlerFn = (e: CustomEvent) => {
    if (called) return;
    called = true;
    handler(e.detail?.deviceId || "");
  };

  window.addEventListener("meshReady", handlerFn as EventListener);

  // Also check if bridge already exists
  const bridge = getAndroidBridge();
  if (bridge) {
    called = true;
    try {
      handler(bridge.getDeviceId());
    } catch {
      // A stale bridge is equivalent to not being ready yet.
      called = false;
    }
  }

  return () => {
    window.removeEventListener("meshReady", handlerFn as EventListener);
  };
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

function hasRequiredEncryptedMetadata(message: EncryptedMessage): boolean {
  return typeof message.messageId === "string" && message.messageId.length > 0 &&
    typeof message.type === "string" && message.type.length > 0 &&
    typeof message.nonce === "number" && Number.isInteger(message.nonce) && message.nonce >= 0 &&
    typeof message.lat === "number" && Number.isFinite(message.lat) && message.lat >= -90 && message.lat <= 90 &&
    typeof message.lng === "number" && Number.isFinite(message.lng) && message.lng >= -180 && message.lng <= 180;
}

function isEncryptedMessageShape(value: unknown): value is EncryptedMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<EncryptedMessage>;
  return typeof message.ciphertext === "string" && typeof message.iv === "string" &&
    typeof message.signature === "string" && typeof message.ephemeralId === "string" &&
    typeof message.senderPublicKey === "string" && hasRequiredEncryptedMetadata(message as EncryptedMessage);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function randomNonce(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/**
 * Canonical coordinate serialization — MUST be byte-identical to
 * MeshWire.canonicalLatLng (audit round 12): micro-degrees, i.e.
 * Math.round(value * 1e6), as a decimal string. Double.toString is NOT
 * runtime-stable (JS String(0) = "0" vs native 0.0.toString() = "0.0"), so a
 * browser-signed message would never verify on the native end. Math.round
 * behaves identically on both runtimes, and micro-degree rounding also
 * absorbs float accumulation noise (0.1+0.2 → 300000 on both).
 */
export function canonicalLatitude(value: number): string {
  if (!Number.isFinite(value) || value < -90 || value > 90) {
    throw new RangeError("latitude out of range");
  }
  return String(Math.round(value * 1_000_000));
}

export function canonicalLongitude(value: number): string {
  if (!Number.isFinite(value) || value < -180 || value > 180) {
    throw new RangeError("longitude out of range");
  }
  return String(Math.round(value * 1_000_000));
}

/** Backward-compatible latitude canonicalizer. */
export function canonicalLatLng(value: number): string {
  return canonicalLatitude(value);
}

/**
 * Canonical signed metadata — byte-identical to MeshWire.buildSignedData
 * (audit round 11): each field is emitted as a 4-byte big-endian length
 * prefix followed by the UTF-8 bytes. Order MUST stay in sync with the
 * Kotlin implementation. Exported for the cross-runtime verification tests
 * (tests that pin the exact byte vectors on BOTH sides).
 */
export function buildSignedData(
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
      encoder.encode(canonicalLatitude(lat)),
      encoder.encode(canonicalLongitude(lng)),
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

function base64ToArrayBuffer(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  // Pass the typed array itself to WebCrypto. In jsdom, its backing
  // ArrayBuffer can belong to a different realm and fail Node's brand check.
  return bytes;
}

function generateId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ========================
// ANTI-REPLAY: track incoming message nonces
// ========================

export function checkAndRecordNonce(nonce: number): boolean {
  // DEPRECATED: use checkAndRecordMessageNonce(messageId, nonce) instead.
  // Kept for backward compatibility but nonce-only replay protection is
  // weaker than the native messageId+nonce scheme.
  const now = Date.now();
  if (seenNonces.has(nonce) && seenNonces.get(nonce)! > now - ANTI_REPLAY_TTL_MS) {
    return false;
  }
  seenNonces.set(nonce, now);
  if (seenNonces.size > 5000) {
    for (const [k, ts] of seenNonces) {
      if (ts <= now - ANTI_REPLAY_TTL_MS) seenNonces.delete(k);
    }
  }
  return true;
}

/**
 * Browser fallback anti-replay using messageId+nonce (mirrors native
 * MeshWire.seenMessageHash). A message is a replay iff BOTH the messageId
 * and nonce match a previously seen pair within the TTL window.
 */
export function checkAndRecordMessageNonce(messageId: string, nonce: number): boolean {
  if (typeof messageId !== "string" || messageId.length === 0 || !Number.isInteger(nonce) || nonce < 0) return false;
  const now = Date.now();
  const key = `${messageId}:${nonce}`;
  if (seenMessageHashes.has(key) && seenMessageHashes.get(key)! > now - ANTI_REPLAY_TTL_MS) {
    return false;
  }
  seenMessageHashes.set(key, now);
  if (seenMessageHashes.size > 5000) {
    for (const [k, ts] of seenMessageHashes) {
      if (ts <= now - ANTI_REPLAY_TTL_MS) seenMessageHashes.delete(k);
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
