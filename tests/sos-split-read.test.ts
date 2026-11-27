import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import cookieParser from "cookie-parser";

// Split-read tests live in their own file on purpose: server/routes/sos.ts
// keeps module-level memorySos, and sos.test.ts posts + resolves SOSes into
// it — seeding exact active/resolved counts here needs a clean slate.
const fsMock = vi.hoisted(() => ({
  collectionGet: vi.fn(async (..._a: any[]) => [] as any),
  docGet: vi.fn(async (..._a: any[]) => null as any),
  docSet: vi.fn(async (..._a: any[]) => true as any),
  docUpdate: vi.fn(async (..._a: any[]) => true as any),
  createSosWithAdmission: vi.fn(async (..._a: any[]) => "created" as any),
  appendSosDispatch: vi.fn(async (..._a: any[]) => "ok" as any),
  clearTeamMissionsForSos: vi.fn(async (..._a: any[]) => true as any),
  resolveSosAtomically: vi.fn(async (..._a: any[]) => ({ status: "resolved", missionsCleared: 1 }) as any),
}));

vi.mock("../server/fs.js", () => fsMock);

import sosRouter from "../server/routes/sos.js";

function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(cookieParser());
  app.use(express.json({ limit: "10mb" }));
  app.use("/api/sos", sosRouter);
  return app;
}

beforeEach(() => {
  fsMock.collectionGet.mockReset();
  fsMock.collectionGet.mockResolvedValue([]);
});

function sosRow(id: string, status: "active" | "resolved", minutesAgo: number) {
  return {
    id,
    deviceId: `dev-${id}`,
    lat: 36.75,
    lng: 7.6,
    name: "مختبر",
    status,
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  };
}

describe("GET /api/sos — split active/resolved reads (CodeRabbit on PR #213)", () => {
  it("reads all active SOS plus the resolved among the 100 newest overall — a shared limit never omits an active SOS", async () => {
    const app = createApp();
    const active = [
      sosRow("sos-active-1", "active", 1),
      sosRow("sos-active-2", "active", 2),
      // CodeRabbit on PR #213 (test nitpick): every active fixture used to
      // be newer than every resolved one, so the newest-100 query returned
      // every active SOS on its own and an implementation ignoring the
      // active result still passed. This one is OLDER than all 150 resolved
      // records, so only the active query can surface it.
      sosRow("sos-active-3", "active", 200),
    ];
    const resolved = Array.from({ length: 150 }, (_, i) =>
      sosRow(`sos-resolved-${String(i).padStart(3, "0")}`, "resolved", i + 10)
    );
    // Fake backend models the real Firestore shape: the filtered query has
    // NO orderBy (single-field index only) and returns rows unsorted; the
    // ordered query has NO where filter and returns the 100 newest overall.
    fsMock.collectionGet.mockImplementation(async (...args: any[]) => {
      const where = args[4];
      if (where?.value === "active") return [...active].reverse();
      const all = [...active, ...resolved].sort(
        (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)
      );
      return all.slice(0, 100);
    });

    const list = await supertest(app).get("/api/sos");
    expect(list.status).toBe(200);
    expect(list.headers["x-sos-source"]).toBe("firestore");
    const ids = new Set(list.body.map((s: any) => s.id));
    // Every active SOS is present, even with 150 resolved behind them.
    for (const a of active) expect(ids.has(a.id)).toBe(true);
    // The 2 young active SOS occupy slots in the newest-100 window, so
    // only the 98 newest resolved are shown (minutesAgo 10..107); the cap
    // is a maximum, not a guarantee. The 200-minute-old active SOS is
    // present only because the active query returned it.
    const presentResolved = resolved.filter((r) => ids.has(r.id));
    expect(presentResolved).toHaveLength(98);
    expect(ids.has("sos-resolved-000")).toBe(true);
    expect(ids.has("sos-resolved-097")).toBe(true);
    expect(ids.has("sos-resolved-098")).toBe(false);
    expect(ids.has("sos-resolved-149")).toBe(false);
    // The two reads use single-field indexes only: filtered query without
    // orderBy, ordered query without a where filter — no composite index.
    expect(fsMock.collectionGet).toHaveBeenCalledWith(
      "trappedSos", undefined, undefined, false,
      { field: "status", op: "==", value: "active" }
    );
    expect(fsMock.collectionGet).toHaveBeenCalledWith(
      "trappedSos", "timestamp", 100, false
    );
    expect(fsMock.collectionGet).toHaveBeenCalledTimes(2);
  });

  it("falls back to the memory list when the active read fails", async () => {
    const app = createApp();
    fsMock.collectionGet.mockResolvedValueOnce(null as any);
    const list = await supertest(app).get("/api/sos");
    expect(list.status).toBe(200);
    expect(list.headers["x-sos-source"]).toBe("memory_fallback");
  });

  it("falls back to the memory list when the resolved read fails", async () => {
    const app = createApp();
    fsMock.collectionGet
      .mockResolvedValueOnce([sosRow("sos-active-1", "active", 1)])
      .mockResolvedValueOnce(null as any);
    const list = await supertest(app).get("/api/sos");
    expect(list.status).toBe(200);
    expect(list.headers["x-sos-source"]).toBe("memory_fallback");
    // CodeRabbit on PR #213: only the history read failed — the active SOS
    // the first read returned must survive instead of being discarded.
    expect(list.body.map((s: any) => s.id)).toContain("sos-active-1");
  });

  it("dedups an SOS that a resolve between the two reads put in both lists, resolved version winning", async () => {
    const app = createApp();
    const activeVersion = sosRow("sos-dup-1", "active", 1);
    const resolvedVersion = sosRow("sos-dup-1", "resolved", 1);
    fsMock.collectionGet.mockImplementation(async (...args: any[]) => {
      const where = args[4];
      if (where?.value === "active") return [activeVersion];
      return [resolvedVersion];
    });
    const list = await supertest(app).get("/api/sos");
    expect(list.status).toBe(200);
    expect(list.headers["x-sos-source"]).toBe("firestore");
    const dupes = list.body.filter((s: any) => s.id === "sos-dup-1");
    expect(dupes).toHaveLength(1);
    expect(dupes[0].status).toBe("resolved");
  });
});
