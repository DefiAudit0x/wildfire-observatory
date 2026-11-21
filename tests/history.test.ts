import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import historyRouter from "../server/routes/history";

vi.mock("../server/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/config.js")>();
  return { default: { ...actual.default, nasaFirmsKey: "test-key" } };
});

// History's successful bucket contract requires successful satellite observations.
// Mock the HTTP backend, keeping the real satellite and history handlers.
beforeEach(() => {
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
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response("error", { status: 500 })));
    const res = await supertest(createTestApp()).get("/api/history?days=7");
    expect(res.status).toBe(200);
    expect(res.body.buckets).toHaveLength(7);
    expect(res.body.hotspotsUnavailable).toBe(true);
    for (const bucket of res.body.buckets) {
      expect(bucket.hotspots).toBe(0);
    }
  });
});