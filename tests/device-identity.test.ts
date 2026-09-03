import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * M15 — unified device identity (src/utils/device.ts).
 *
 * Every test file in this repo runs under BOTH node and jsdom (ARC-L26), so
 * the suite must not assume Web Storage exists: in node the storage globals
 * are undefined and the module must fall back to a memory id. jsdom provides
 * real localStorage/sessionStorage, which is where the migration matrix is
 * exercised. Environment-dependent blocks below self-skip in node.
 */

const hasWebStorage = typeof localStorage !== "undefined";

function resetDeviceModule() {
  vi.resetModules();
}

async function loadDevice() {
  const mod = await import("../src/utils/device.js");
  return mod;
}

beforeEach(() => {
  resetDeviceModule();
  if (hasWebStorage) {
    localStorage.clear();
    sessionStorage.clear();
  }
  // The native bridge must not leak between tests.
  delete (globalThis as any).window?.AndroidBridge;
  if (typeof window !== "undefined") delete (window as any).AndroidBridge;
});

describe("getDeviceId — canonical identity and one-time migration", () => {
  it("generates a web_ id when nothing is stored", async () => {
    const { getDeviceId } = await loadDevice();
    const id = getDeviceId();
    expect(id).toMatch(/^web_[0-9a-f-]{36}$/);
  });

  it("is stable across repeated calls in the same page", async () => {
    const { getDeviceId } = await loadDevice();
    const first = getDeviceId();
    expect(getDeviceId()).toBe(first);
    expect(getDeviceId()).toBe(first);
  });

  if (hasWebStorage) {
    it("keeps an existing canonical device_id untouched (notification/SOS continuity)", async () => {
      localStorage.setItem("device_id", "web_existing-identity");
      const { getDeviceId } = await loadDevice();
      expect(getDeviceId()).toBe("web_existing-identity");
      expect(localStorage.getItem("device_id")).toBe("web_existing-identity");
      expect(sessionStorage.getItem("device_id")).toBe("web_existing-identity");
    });

    it("prefers the session mirror over localStorage (same precedence as before)", async () => {
      sessionStorage.setItem("device_id", "web_session-copy");
      localStorage.setItem("device_id", "web_stored-copy");
      const { getDeviceId } = await loadDevice();
      expect(getDeviceId()).toBe("web_session-copy");
    });

    it("MIGRATES a legacy mesh_device_id into the canonical key and retires it", async () => {
      localStorage.setItem("mesh_device_id", "dev-legacy-mesh-uuid");
      const { getDeviceId } = await loadDevice();
      expect(getDeviceId()).toBe("dev-legacy-mesh-uuid");
      expect(localStorage.getItem("device_id")).toBe("dev-legacy-mesh-uuid");
      expect(localStorage.getItem("mesh_device_id")).toBeNull();
    });

    it("keeps the canonical id when BOTH keys exist (migration never downgrades)", async () => {
      localStorage.setItem("device_id", "web_canonical");
      localStorage.setItem("mesh_device_id", "dev-old-mesh");
      const { getDeviceId } = await loadDevice();
      expect(getDeviceId()).toBe("web_canonical");
    });

    it("adopts the native bridge id only when no stored id exists (Android first boot)", async () => {
      (window as any).AndroidBridge = { getDeviceId: () => "native-prefs-uuid-123" };
      const { getDeviceId } = await loadDevice();
      expect(getDeviceId()).toBe("native-prefs-uuid-123");
      expect(localStorage.getItem("device_id")).toBe("native-prefs-uuid-123");
    });

    it("ignores the bridge when a canonical id already exists (upgrade path)", async () => {
      localStorage.setItem("device_id", "web_canonical");
      (window as any).AndroidBridge = { getDeviceId: () => "native-prefs-uuid-123" };
      const { getDeviceId } = await loadDevice();
      expect(getDeviceId()).toBe("web_canonical");
    });

    it("rejects garbage bridge values and generates instead", async () => {
      (window as any).AndroidBridge = { getDeviceId: () => "" };
      const { getDeviceId } = await loadDevice();
      const id = getDeviceId();
      expect(id).toMatch(/^web_/);
    });

    it("tolerates a throwing bridge", async () => {
      (window as any).AndroidBridge = { getDeviceId: () => { throw new Error("bridge gone"); } };
      const { getDeviceId } = await loadDevice();
      expect(getDeviceId()).toMatch(/^web_/);
    });

    it("sanity-checks stored values and ignores malformed ones", async () => {
      localStorage.setItem("device_id", "not a valid id!!!");
      const { getDeviceId } = await loadDevice();
      expect(getDeviceId()).toMatch(/^web_/);
    });

    // W10: the retirement must not ride inside the adoption branch — a
    // pattern-failing legacy value used to sit in storage forever.
    it("W10: retires a CORRUPT legacy mesh_device_id instead of keeping it forever", async () => {
      localStorage.setItem("mesh_device_id", "garbage legacy value!!!");
      const { getDeviceId } = await loadDevice();
      expect(getDeviceId()).toMatch(/^web_/);
      expect(localStorage.getItem("mesh_device_id")).toBeNull();
      // And the fresh identity persists as the canonical one.
      expect(localStorage.getItem("device_id")).toBe(getDeviceId());
    });

    // W11: simulate the other tab's write landing here as a storage event —
    // both sides adopt the lexicographically smaller id, deterministically.
    it("W11: converges to the SMALLER rival id when the other tab wins the race", async () => {
      const { getDeviceId } = await loadDevice();
      const mine = getDeviceId();
      // Strictly smaller than any v4-uuid id (the 13th uuid char is '4', so
      // an all-zero id can never be generated by randomUUID itself).
      const rival = `web_${"0".repeat(36)}`;
      expect(rival < mine).toBe(true);
      window.dispatchEvent(new StorageEvent("storage", {
        key: "device_id",
        newValue: rival,
        storageArea: localStorage,
      }));
      expect(getDeviceId()).toBe(rival);
      expect(localStorage.getItem("device_id")).toBe(rival);
      expect(sessionStorage.getItem("device_id")).toBe(rival);
    });

    it("W11: re-asserts OUR id when the rival is larger (both tabs converge on one)", async () => {
      const { getDeviceId } = await loadDevice();
      const mine = getDeviceId();
      // Strictly larger than any hex-based id ('z' > any hex digit).
      const rival = `web_${"z".repeat(36)}`;
      expect(rival > mine).toBe(true);
      window.dispatchEvent(new StorageEvent("storage", {
        key: "device_id",
        newValue: rival,
        storageArea: localStorage,
      }));
      expect(getDeviceId()).toBe(mine);
      // The re-assert rewrote the shared key back to ours.
      expect(localStorage.getItem("device_id")).toBe(mine);
    });

    it("W11: ignores malformed/garbage storage events", async () => {
      const { getDeviceId } = await loadDevice();
      const mine = getDeviceId();
      window.dispatchEvent(new StorageEvent("storage", {
        key: "device_id",
        newValue: "not a valid id!!!",
        storageArea: localStorage,
      }));
      window.dispatchEvent(new StorageEvent("storage", {
        key: "something_else",
        newValue: `web_${"0".repeat(36)}`,
        storageArea: localStorage,
      }));
      expect(getDeviceId()).toBe(mine);
      expect(localStorage.getItem("device_id")).toBe(mine);
    });
  }
});

describe("getDeviceId — node fallback (no Web Storage)", () => {
  it("returns a memory id in non-DOM environments", async () => {
    // In node there is no localStorage at all; the module must not throw.
    const { getDeviceId } = await loadDevice();
    expect(getDeviceId()).toMatch(/^web_/);
  });
});
