/**
 * Device identity for authenticated device-scoped features (notifications,
 * report ownership, confirmations, SOS identity, mesh display labels).
 *
 * M15 unification: this module is the SINGLE source of device identity for
 * the whole client surface (web SPA and the Android WebView alike). Before,
 * parallel ids coexisted — `web_<uuid>` here and a separate `dev-<uuid>`
 * under localStorage["mesh_device_id"] in src/lib/mesh.ts, plus the native
 * Android SharedPreferences UUID behind window.AndroidBridge.getDeviceId().
 * One person could therefore carry three unrelated identifiers, which split
 * their notifications/SOS history from their mesh presence and defeated
 * dispatcher correlation.
 *
 * One-time migration (runs lazily on the first getDeviceId() of a page):
 *   1. An existing localStorage["device_id"] stays canonical — nothing
 *      changes for current users (notifications/SOS history keep working).
 *   2. Otherwise a legacy localStorage["mesh_device_id"] is ADOPTED as the
 *      canonical id and the old key is removed. The mesh hub treats deviceId
 *      as a display label only (the JWT subject is authoritative), so
 *      re-keying it carries no server-side migration.
 *   3. Otherwise, inside the Android shell, the native bridge id is adopted
 *      (first boot: the native UUID seeds the identity, JS persists it).
 *   4. Otherwise a fresh `web_<uuid>` is generated.
 *
 * Privacy semantics (kept explicit for the future privacy review):
 * - It is NOT a personal identifier: no name, email or phone is derived from
 *   it, and it carries no serial or hardware binding.
 * - It IS persistent: stored in localStorage, so it survives reloads — that is
 *   what keeps "your" notifications and unread state stable across tabs.
 * - It is rotated when the browser storage is cleared; clearing storage is
 *   the documented way to start fresh. Session storage mirrors it per tab.
 * - Server-side it appears only as a lookup key for per-device data and is
 *   never exposed in public DTOs (see the PII-safe public report/sos DTOs).
 * - Identity for SECURITY decisions is never this label: the server derives
 *   authority exclusively from its own signed cookies/tokens (public
 *   principal, staff session, team-member token). This id is a
 *   lookup/display key and must never be trusted as proof of ownership.
 */

const DEVICE_ID_KEY = "device_id";
const LEGACY_MESH_ID_KEY = "mesh_device_id";
/** What we are willing to store/send as a device id: opaque, bounded, no separators beyond - and _. */
const ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;

let memoryDeviceId: string | null = null;
let fallbackCounter = 0;

function newDeviceId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `web_${uuid}`;
  fallbackCounter += 1;
  return `web_${Date.now()}_${fallbackCounter}`;
}

function readStorage(store: Storage | undefined, key: string): string | null {
  try {
    const value = store?.getItem(key);
    return typeof value === "string" && ID_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Android WebView bridge id (MainActivity#stableDeviceId). Present only inside
 * the native shell, and only reachable through the trusted-origin JS bridge —
 * reading it here is adoption of a seed value, not a trust decision.
 */
function nativeBridgeId(): string | null {
  const bridge = (globalThis as any).window?.AndroidBridge;
  if (!bridge || typeof bridge.getDeviceId !== "function") return null;
  try {
    const value = bridge.getDeviceId();
    return typeof value === "string" && ID_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function getDeviceId(): string {
  if (memoryDeviceId) return memoryDeviceId;

  let session: Storage | undefined;
  let local: Storage | undefined;
  try {
    session = globalThis.sessionStorage;
    local = globalThis.localStorage;
  } catch {
    // Storage can be blocked entirely (hardened webviews); memory fallback below.
  }

  // Session mirror first — same precedence as before (per-tab stability).
  let id = readStorage(session, DEVICE_ID_KEY) || readStorage(local, DEVICE_ID_KEY);

  if (!id) {
    // One-time migration: adopt the legacy mesh id, then retire the old key.
    const legacy = readStorage(local, LEGACY_MESH_ID_KEY);
    if (legacy) {
      id = legacy;
      try {
        local?.removeItem(LEGACY_MESH_ID_KEY);
      } catch {
        // Best-effort cleanup; leaving it causes no further reads anywhere.
      }
    }
  }

  if (!id) id = nativeBridgeId();
  if (!id) id = newDeviceId();

  memoryDeviceId = id;
  try {
    session?.setItem(DEVICE_ID_KEY, id);
    local?.setItem(DEVICE_ID_KEY, id);
  } catch {
    // Storage unavailable — memoryDeviceId keeps the ID stable for this page.
  }

  return id;
}
