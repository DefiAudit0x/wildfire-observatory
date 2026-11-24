// Fix 48 — NVITE-2: the manualChunks branches for react-leaflet and
// firebase are dead (no such module can reach the Vite client build).
// No jsdom directive: the config imports Vite plugins but needs no DOM,
// so this runs as a plain node-environment test file under both configs.
import { describe, it, expect } from "vitest";
import config from "../vite.config";

type ManualChunks = (id: string) => string | undefined;

function manualChunks(): ManualChunks {
  const resolved = typeof config === "function" ? config({} as never) : config;
  const rawOutput = resolved.build?.rollupOptions?.output;
  const output = Array.isArray(rawOutput) ? rawOutput[0] : rawOutput;
  const chunks = (output as { manualChunks?: ManualChunks } | undefined)?.manualChunks;
  if (typeof chunks !== "function") throw new Error("manualChunks not found in vite config");
  return chunks;
}

describe("vite manualChunks (Fix 48 — NVITE-2)", () => {
  it("no longer gives a react-leaflet module the leaflet chunk (finding)", () => {
    expect(manualChunks()("node_modules/react-leaflet/lib/MapContainer.js")).toBe("vendor");
  });

  it("no longer gives a firebase module the firebase chunk (finding)", () => {
    const fn = manualChunks();
    expect(fn("node_modules/firebase/app/dist/index.js")).toBe("vendor");
    expect(fn("node_modules/firebase/firestore/dist/index.js")).toBe("vendor");
  });

  it("still gives leaflet its chunk (control)", () => {
    expect(manualChunks()("node_modules/leaflet/dist/leaflet.js")).toBe("leaflet");
  });

  it("still gives sentry its chunk (control)", () => {
    expect(manualChunks()("node_modules/@sentry/react/build/index.js")).toBe("sentry");
  });

  it("still falls other node_modules to vendor (control)", () => {
    expect(manualChunks()("node_modules/react/index.js")).toBe("vendor");
  });

  it("still gives app code no chunk (control)", () => {
    expect(manualChunks()("src/components/InteractiveMap.tsx")).toBeUndefined();
  });
});
