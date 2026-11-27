import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import historyRouter from "../server/routes/history";

const reportStore = vi.hoisted(() => ({ result: { status: "empty" } as { status: string; reports?: unknown[] } }));
vi.mock("../server/db.js", () => ({ getReportsDbResult: async () => reportStore.result }));

vi.mock("../server/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/config.js")>();
  return { default: { ...actual.default, nasaFirmsKey: "test-key" } };
});

// History's successful bucket contract requires successful satellite observations.
// Mock the HTTP backend, keeping the real satellite and history handlers.
beforeEach(() => {
  reportStore.result = { status: "empty" };
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response("latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight\n")));
});
afterEach(() => vi.unstubAllGlobals());

function createTestApp() {
  const app = express();
  app.use("/api/history", historyRouter);
  return app;
}

describe("GET /api/history", () => {
  it("returns 30 daily buckets by default", async () => {
    const res = await supertest(createTestApp()).get("/api/history");
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(30);
    expect(res.body.buckets).toHaveLength(30);
    expect(res.body.buckets[0]).toHaveProperty("date");
    expect(res.body.buckets[0]).toHaveProperty("reports");
    expect(res.body.buckets[0]).toHaveProperty("verified");
    expect(res.body.buckets[0]).toHaveProperty("sos");
    expect(res.body.buckets[0]).toHaveProperty("hotspots");
  });

  it("honors the days parameter", async () => {
    const res = await supertest(createTestApp()).get("/api/history?days=7");
    expect(res.status).toBe(200);
    expect(res.body.buckets).toHaveLength(7);
  });

  it("falls back to the default when days is out of range", async () => {
    const res = await supertest(createTestApp()).get("/api/history?days=500");
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(30);
  });

  it("buckets are sorted chronologically", async () => {
    const res = await supertest(createTestApp()).get("/api/history?days=10");
    const dates = res.body.buckets.map((b: { date: string }) => b.date);
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
    // One distinct date per day: a duplicated date is already sorted,
    // so sortedness alone cannot catch a collapsed series.
    expect(new Set(dates).size).toBe(dates.length);
    // And no day may be missing: each bucket must follow the previous
    // by exactly one day.
    for (let i = 1; i < dates.length; i++) {
      expect(Date.parse(dates[i]) - Date.parse(dates[i - 1])).toBe(24 * 60 * 60 * 1000);
    }
  });

  it("counts non-negative numbers", async () => {
    const res = await supertest(createTestApp()).get("/api/history?days=10");
    for (const bucket of res.body.buckets) {
      expect(bucket.reports).toBeGreaterThanOrEqual(0);
      expect(bucket.verified).toBeGreaterThanOrEqual(0);
      expect(bucket.sos).toBeGreaterThanOrEqual(0);
      expect(bucket.hotspots).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns the buckets with hotspots marked unavailable when FIRMS fails", async () => {
    // Fix 12b: both satellite sources failing must not fail the whole endpoint.
    // Fix 42 (SAT-2): the earlier tests in this file populate the satellite
    // module's 60 s empty-result cache (their fetch returns header-only CSV),
    // so this outage test needs a FRESH satellite module — otherwise the
    // cached empty observation masks the outage for the rest of the window.
    // (The same staleness already exists for the 10-min healthy cache.)
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response("error", { status: 500 })));
    const { default: freshHistoryRouter } = await import("../server/routes/history");
    const app = express();
    app.use("/api/history", freshHistoryRouter);
    const res = await supertest(app).get("/api/history?days=7");
    expect(res.status).toBe(200);
    expect(res.body.buckets).toHaveLength(7);
    expect(res.body.hotspotsUnavailable).toBe(true);
    for (const bucket of res.body.buckets) {
      expect(bucket.hotspots).toBe(0);
    }
  });
});

describe("Round 2 history availability and coverage", () => {
  it.each(["error", "no-db"])("reports %s as unavailable instead of zero history", async (status) => {
    reportStore.result = { status };
    const res = await supertest(createTestApp()).get("/api/history");
    expect(res.status).toBe(503);
    expect(res.body.reportsUnavailable).toBe(true);
    expect(res.body.buckets).toBeUndefined();
  });
  it("labels all current snapshots as incomplete historical coverage", async () => {
    const res = await supertest(createTestApp()).get("/api/history?days=180");
    expect(res.status).toBe(200);
    expect(res.body.partial).toBe(true);
    expect(res.body.coverage.hotspots).toContain("24 hours");
  });
});
