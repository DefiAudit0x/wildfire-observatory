import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Router } from "express";
import supertest from "supertest";

const unavailable = () => new Response("offline", { status: 503 });
const empty = () => new Response("lat,lng\n");
const scanTime = new Date();

function detection() {
  const [date, time] = scanTime.toISOString().split("T");
  return new Response(
    "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,confidence,version\n" +
      "36.8,7.8,340,1,1," + date + "," + time.slice(0, 5).replace(":", "") + ",T,h,6.1NRT"
  );
}

function request(router: Router) {
  return supertest(express().use(router));
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NASA_FIRMS_KEY", "test-key");
  vi.stubEnv("FIRMS_BASE_URL", "https://firms.example.test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("partial satellite outages", () => {
  it("throws on total outage, returns partial detections, and caches only after recovery", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(detection())
      .mockResolvedValueOnce(empty()).mockResolvedValueOnce(detection());
    vi.stubGlobal("fetch", fetch);
    const { getLiveSatelliteData, SatelliteUnavailableError } = await import("../server/routes/satellite");

    await expect(getLiveSatelliteData()).rejects.toBeInstanceOf(SatelliteUnavailableError);
    const partial = await getLiveSatelliteData();
    expect(partial).toEqual({
      hotspots: [expect.objectContaining({ satellite: "MODIS", confidence: 95 })],
      sources: { VIIRS_SNPP_NRT: "unavailable", MODIS_NRT: "ok" },
    });
    const recovered = await getLiveSatelliteData();
    expect(recovered).toEqual({
      hotspots: partial.hotspots,
      sources: { VIIRS_SNPP_NRT: "ok", MODIS_NRT: "ok" },
    });
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(await getLiveSatelliteData()).toEqual(recovered);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("raises a satellite-only wilaya and marks fresh and cached responses as partial", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(detection());
    vi.stubGlobal("fetch", fetch);
    const app = request((await import("../server/routes/wilayas")).default);

    for (let i = 0; i < 2; i++) {
      const res = await app.get("/");
      expect(res.status).toBe(200);
      const annaba = res.body.find((wilaya: { nameFr: string }) => wilaya.nameFr === "Algérie - Annaba");
      expect(annaba).toMatchObject({ activeFires: 0, satelliteHotspots: 1, severity: "low" });
      expect(res.headers["x-satellite-partial"]).toBe("true");
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("counts the healthy feed in history without marking hotspots unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(detection()));
    const res = await request((await import("../server/routes/history")).default).get("/?days=7");

    expect(res.status).toBe(200);
    expect(res.body.buckets).toContainEqual(expect.objectContaining({
      date: scanTime.toISOString().slice(0, 10), hotspots: 1,
    }));
    expect(res.body.hotspotsPartial).toBe(true);
    expect(res.body).not.toHaveProperty("hotspotsUnavailable");
  });
});


describe("Fix 12e FIRMS wire columns", () => {
  it.each([
    ["T", "0", "MODIS", 0], ["A", "100", "MODIS", 100],
    ["N", "high", "VIIRS", 95], ["N20", "low", "VIIRS", 45],
    ["N21", "nominal", "VIIRS", 80], ["T", "h", "MODIS", 95],
    ["A", "l", "MODIS", 45], ["T", "72.5", "MODIS", 72.5],
    ["T", "101", "MODIS", 80], ["T", "-1", "MODIS", 80],
  ])("parses satellite %s with confidence %s from the official columns", async (satellite, confidence, type, expected) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(
      "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,confidence,version\n" +
      `36.8,7.8,340,1,1,2026-11-21,1200,${satellite},${confidence},6.1NRT`
    )).mockResolvedValueOnce(empty()));
    const { getLiveSatelliteData } = await import("../server/routes/satellite");
    expect((await getLiveSatelliteData()).hotspots).toEqual([
      expect.objectContaining({ satellite: type, confidence: expected, lat: 36.8, lng: 7.8, scanTime: "2026-11-21T12:00:00Z" }),
    ]);
  });

  it("rejects the old invented instrument-column fixture and unknown satellites", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(
      "lat,lng,bright,scan,track,date,time,sat,instrument,confidence\n36.8,7.8,340,1,1,2026-11-21,1200,T,MODIS_NRT,h"
    )).mockResolvedValueOnce(new Response(
      "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,confidence,version\n36.8,7.8,340,1,1,2026-11-21,1200,UNKNOWN,high,1.0NRT"
    )));
    const { getLiveSatelliteData } = await import("../server/routes/satellite");
    expect((await getLiveSatelliteData()).hotspots).toEqual([]);
  });

  it.each([false, true])("marks partial history even when the healthy feed is empty=%s", async (isEmpty) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(isEmpty ? empty() : detection()));
    const res = await request((await import("../server/routes/history")).default).get("/?days=7");
    expect(res.body.hotspotsPartial).toBe(true);
    expect(res.body).not.toHaveProperty("hotspotsUnavailable");
    expect(res.body.buckets.reduce((n: number, b: { hotspots: number }) => n + b.hotspots, 0)).toBe(isEmpty ? 0 : 1);
  });

  it.each([false, true])("omits history partial on total outage=%s", async (total) => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => total ? unavailable() : empty()));
    const res = await request((await import("../server/routes/history")).default).get("/?days=7");
    expect(res.body).not.toHaveProperty("hotspotsPartial");
    expect(res.body.hotspotsUnavailable).toBe(total ? true : undefined);
  });

  it("returns retained empty detections on a partial 503", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(empty()));
    const res = await request((await import("../server/routes/satellite")).default).get("/");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ hotspots: [], sources: { VIIRS_SNPP_NRT: "unavailable", MODIS_NRT: "ok" } });
  });
});
