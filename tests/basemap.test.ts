import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cartoUrl } from "../src/lib/basemap.js";

// getCartoKey caches per page-load, so every case re-imports the module
// fresh (vi.resetModules + dynamic import).
function mockFetchOnce(payload: unknown, ok = true) {
  const fn = vi.fn(async () =>
    ({ ok, status: ok ? 200 : 500, json: async () => payload }) as unknown as Response
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("getCartoKey", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the key when the server serves one", async () => {
    mockFetchOnce({ cartoKey: "k-test-1" });
    const { getCartoKey } = await import("../src/lib/basemap.js");
    expect(await getCartoKey()).toBe("k-test-1");
  });

  it("returns null when the server has no key configured", async () => {
    mockFetchOnce({ cartoKey: null });
    const { getCartoKey } = await import("../src/lib/basemap.js");
    expect(await getCartoKey()).toBeNull();
  });

  it("treats blank keys as no key", async () => {
    mockFetchOnce({ cartoKey: "   " });
    const { getCartoKey } = await import("../src/lib/basemap.js");
    expect(await getCartoKey()).toBeNull();
  });

  it("returns null when fetch throws (offline console keeps keyless OSM)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      })
    );
    const { getCartoKey } = await import("../src/lib/basemap.js");
    expect(await getCartoKey()).toBeNull();
  });

  it("returns null on non-2xx answers", async () => {
    mockFetchOnce({}, false);
    const { getCartoKey } = await import("../src/lib/basemap.js");
    expect(await getCartoKey()).toBeNull();
  });

  it("caches exactly one config fetch per page load", async () => {
    const fn = mockFetchOnce({ cartoKey: "k-test-2" });
    const { getCartoKey } = await import("../src/lib/basemap.js");
    await getCartoKey();
    await getCartoKey();
    await getCartoKey();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("cartoUrl", () => {
  it("builds the keyed raster URL with the param CARTO actually honors", () => {
    expect(cartoUrl("dark_all", "k1")).toBe(
      "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=k1"
    );
  });

  it("keeps light_all at the documented root path", () => {
    expect(cartoUrl("light_all", "k2")).toBe(
      "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=k2"
    );
  });

  it("routes voyager through /rastertiles/voyager/ (bare /voyager/ 404s every tile)", () => {
    expect(cartoUrl("voyager", "k3")).toBe(
      "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=k3"
    );
  });
});
