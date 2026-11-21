import express from "express";
import supertest from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  reports: vi.fn(),
  legacyReports: vi.fn(),
  zones: vi.fn(),
  generate: vi.fn(),
  aiEnabled: false,
  config: { nasaFirmsKey: "test-key", firmsBaseUrl: "https://firms.example.test" },
}));
vi.mock("../server/db.js", () => ({
  getReportsDbResult: backend.reports,
  getReportsFromFirestore: backend.legacyReports,
}));
vi.mock("../server/fs.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../server/fs.js")>(), collectionGet: backend.zones,
}));
vi.mock("../server/ai.js", () => ({
  getAiClient: () => backend.aiEnabled ? { models: { generateContent: backend.generate } } : null,
  getAiModel: () => "test-model",
}));
vi.mock("../server/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/config.js")>();
  return { default: new Proxy(actual.default, { get: (target, key) =>
    key === "nasaFirmsKey" ? backend.config.nasaFirmsKey
      : key === "firmsBaseUrl" ? backend.config.firmsBaseUrl : Reflect.get(target, key),
  }) };
});

async function appFor(route: "ai" | "safezones" | "satellite") {
  const router = route === "ai" ? (await import("../server/routes/ai.js")).default
    : route === "safezones" ? (await import("../server/routes/safezones.js")).default
      : (await import("../server/routes/satellite.js")).default;
  const app = express();
  app.use(express.json());
  app.use("/", router);
  return app;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  backend.aiEnabled = false;
  backend.config.nasaFirmsKey = "test-key";
  backend.reports.mockResolvedValue({ status: "empty" });
  backend.legacyReports.mockResolvedValue([]);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const guidanceRequest = (app: express.Express) => supertest(app).post("/").send({ lat: 36.8, lng: 7.5, lang: "fr" });

describe("Fix 12 AIG-1 unavailable report context", () => {
  it.each(["error", "no-db"])("returns 503 for %s instead of an all-clear", async (status) => {
    backend.reports.mockResolvedValue({ status });
    backend.legacyReports.mockResolvedValue(null);
    const res = await guidanceRequest(await appFor("ai"));
    expect(res.status).toBe(503);
    expect(res.body.error).toContain("unavailable");
    expect(res.body.guidance).toBeUndefined();
  });
  it("returns 503 when context times out", async () => {
    backend.reports.mockImplementation(() => new Promise(() => {}));
    backend.legacyReports.mockImplementation(() => new Promise(() => {}));
    const res = await guidanceRequest(await appFor("ai"));
    expect(res.status).toBe(503);
    expect(res.body.guidance).toBeUndefined();
  }, 10000);
  it("returns 503 when the database read rejects", async () => {
    backend.reports.mockRejectedValue(new Error("backend offline"));
    backend.legacyReports.mockRejectedValue(new Error("backend offline"));
    const res = await guidanceRequest(await appFor("ai"));
    expect(res.status).toBe(503);
    expect(res.body.guidance).toBeUndefined();
  });
  it("keeps a confirmed empty dataset successful", async () => {
    const res = await guidanceRequest(await appFor("ai"));
    expect(res.status).toBe(200);
    expect(res.body.guidance).toContain("Aucun foyer");
  });
});

describe("Fix 12 AIG-2 guidance freshness", () => {
  it.each(["old", "future", "invalid"])("excludes %s critical reports from fallback and AI prompt", async (kind) => {
    const timestamp = kind === "old" ? new Date(Date.now() - 90 * 86400000).toISOString()
      : kind === "future" ? new Date(Date.now() + 10 * 60000).toISOString() : "invalid";
    const reports = [{ lat: 36.8, lng: 7.5, severity: "critical", status: "pending", timestamp }];
    backend.reports.mockResolvedValue({ status: "ok", reports });
    backend.legacyReports.mockResolvedValue(reports);
    const app = await appFor("ai");
    const fallback = await guidanceRequest(app);
    expect(fallback.status).toBe(200);
    expect(fallback.body.guidance).toContain("Aucun foyer");
    backend.aiEnabled = true;
    backend.generate.mockResolvedValue({ text: "provider response" });
    const live = await guidanceRequest(app);
    expect(live.body.guidance).toBe("provider response");
    expect(backend.generate.mock.calls[0][0].contents).toContain("Active reports: 0, High/Critical: 0");
  });
  it("keeps fresh critical reports and excludes resolved/rejected reports", async () => {
    const reports = ["pending", "resolved", "rejected"].map(status => ({
      lat: 36.8, lng: 7.5, severity: "critical", status, timestamp: new Date().toISOString(),
    }));
    backend.reports.mockResolvedValue({ status: "ok", reports });
    backend.legacyReports.mockResolvedValue(reports);
    const res = await guidanceRequest(await appFor("ai"));
    expect(res.status).toBe(200);
    expect(res.body.guidance).toContain("1 signalements graves");
  });
});

describe("Fix 12 SZM-2 bounded stale safe zones", () => {
  it("returns 503 past the absolute age bound after repeated refresh failures", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    backend.zones.mockResolvedValueOnce([{ id: "expired-zone", isActive: true }]).mockResolvedValue(null);
    const app = await appFor("safezones");
    expect((await supertest(app).get("/")).status).toBe(200);
    now += 120000;
    expect((await supertest(app).get("/")).status).toBe(200);
    now += 180001;
    const res = await supertest(app).get("/");
    expect(res.status).toBe(503);
    expect(res.body.error).toContain("unavailable");
  });
  it("marks stale lists and stops serving them after five minutes, without renewing their age", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const zones = [{ id: "zone-a", isActive: true }];
    backend.zones.mockResolvedValueOnce(zones).mockResolvedValue(null);
    const app = await appFor("safezones");
    const fresh = await supertest(app).get("/");
    expect(fresh.status).toBe(200);
    expect(fresh.body).toEqual(zones);
    expect(fresh.headers["x-data-stale"]).toBeUndefined();
    now += 60001;
    const stale = await supertest(app).get("/");
    expect(stale.status).toBe(200);
    expect(stale.body).toEqual(zones);
    expect(stale.headers["x-data-stale"]).toBe("true");
    expect(stale.headers["x-data-updated-at"]).toBe(new Date(now - 60001).toISOString());
    now += 240000;
    const expired = await supertest(app).get("/");
    expect(expired.status).toBe(503);
    expect(expired.body.error).toContain("unavailable");
  });
});

describe("Fix 12 SAT-1 visible satellite source failures", () => {
  it.each(["http", "transport", "timeout", "missing-key"])("returns 503 with both source statuses on %s failure", async (kind) => {
    if (kind === "missing-key") backend.config.nasaFirmsKey = "";
    vi.stubGlobal("fetch", kind === "http" ? vi.fn().mockResolvedValue(new Response("offline", { status: 503 }))
      : kind === "timeout" ? vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })) : vi.fn().mockRejectedValue(new Error("transport unavailable")));
    const res = await supertest(await appFor("satellite")).get("/");
    expect(res.status).toBe(503);
    expect(res.body.error).toContain("unavailable");
    expect(res.body.sources).toEqual({ VIIRS_SNPP_NRT: "unavailable", MODIS_NRT: "unavailable" });
    expect(res.body).not.toHaveProperty("hotspots");
  }, 35000);
  it("surfaces a single failed source even when the other has detections", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("offline", { status: 503 }))
      .mockResolvedValueOnce(new Response("latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,confidence,version\n36.8,7.5,340,1,1,2026-11-21,1200,T,h,6.1NRT")));
    const res = await supertest(await appFor("satellite")).get("/");
    expect(res.status).toBe(503);
    expect(res.body.sources).toEqual({ VIIRS_SNPP_NRT: "unavailable", MODIS_NRT: "ok" });
    expect(res.body.hotspots).toEqual([expect.objectContaining({ satellite: "MODIS", confidence: 95 })]);
  });
  it("preserves the healthy empty array contract", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response("lat,lng\n")));
    const res = await supertest(await appFor("satellite")).get("/");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
