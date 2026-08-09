import { describe, it, expect } from "vitest";
import express from "express";
import supertest from "supertest";
import historyRouter from "../server/routes/history";

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
});