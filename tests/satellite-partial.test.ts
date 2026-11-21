import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Router } from "express";
import supertest from "supertest";

const unavailable = () => new Response("offline", { status: 503 });
const empty = () => new Response("lat,lng\n");
const scanTime = new Date();

function detection() {
  const [date, time] = scanTime.toISOString().split("T");
  return new Response(
    "lat,lng,bright,scan,track,date,time,sat,instrument,confidence\n" +
      "36.8,7.8,340,1,1," + date + "," + time.slice(0, 5).replace(":", "") + ",T,MODIS_NRT,h"
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
    expect(res.body).not.toHaveProperty("hotspotsUnavailable");
  });
});
