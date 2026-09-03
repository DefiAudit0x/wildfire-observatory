import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import supertest from "supertest";

const fetchMock = vi.hoisted(() => vi.fn(async (..._a: any[]) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ display_name: "Test Street, Annaba" }),
})));

vi.mock("../server/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import geoRouter from "../server/routes/geo.js";

function createApp() {
  const app = express();
  app.use("/api/geo", geoRouter);
  return app;
}

describe("GET /api/geo/reverse (W-H6: the only geocoding egress)", () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects missing or non-numeric coordinates", async () => {
    const app = createApp();
    const bad = await supertest(app).get("/api/geo/reverse").query({ lat: "abc", lng: 7.6 });
    expect(bad.status).toBe(400);
    const missing = await supertest(app).get("/api/geo/reverse");
    expect(missing.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gates requests outside the monitoring coverage", async () => {
    const app = createApp();
    const res = await supertest(app).get("/api/geo/reverse").query({ lat: 48.85, lng: 2.35 }); // Paris
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proxies Nominatim and mirrors the JSON shape", async () => {
    const app = createApp();
    const res = await supertest(app).get("/api/geo/reverse").query({ lat: 36.9, lng: 7.75 });
    expect(res.status).toBe(200);
    expect(res.headers["x-geo-cache"]).toBe("miss");
    expect(res.body.display_name).toContain("Test Street");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("nominatim.openstreetmap.org/reverse");
    expect(String(url)).toContain("lat=36.9");
    expect((init as any).headers["User-Agent"]).toContain("WildfireObservatory/");
  });

  it("serves repeat lookups of the same coordinate from the cache", async () => {
    const app = createApp();
    await supertest(app).get("/api/geo/reverse").query({ lat: 36.91, lng: 7.76 });
    const second = await supertest(app).get("/api/geo/reverse").query({ lat: 36.9101, lng: 7.7602 });
    expect(second.status).toBe(200);
    expect(second.headers["x-geo-cache"]).toBe("hit");
    // 3-decimal cache key → both calls collapsed to ONE upstream fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("502s honestly when the upstream is unreachable (never fabricates a place)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("upstream down"));
    const app = createApp();
    const res = await supertest(app).get("/api/geo/reverse").query({ lat: 36.92, lng: 7.77 });
    expect(res.status).toBe(502);
    expect(res.body.error).toBeTruthy();
  });
});
