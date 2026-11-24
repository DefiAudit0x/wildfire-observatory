import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Router } from "express";
import supertest from "supertest";

const unavailable = () => new Response("offline", { status: 503 });
const modisHeader = "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight";
const viirsHeader = modisHeader.replace("brightness", "bright_ti4").replace("bright_t31", "bright_ti5");
const empty = () => new Response(viirsHeader + "\n");
const scanTime = new Date();

function detection() {
  const [date, time] = scanTime.toISOString().split("T");
  return new Response(
    modisHeader + "\n" +
      "36.8,7.8,340,1,1," + date + "," + time.slice(0, 5).replace(":", "") + ",Terra,MODIS,83,6.1NRT,292.65,10.58,N"
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
      hotspots: [expect.objectContaining({ satellite: "MODIS", confidence: 83 })],
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

  it("Fix 42 (SAT-2): concurrent callers share one in-flight fetch", async () => {
    // Old code: each of the 3 callers did its own 2 upstream FIRMS calls —
    // two concurrent calls cost 4 fetches. The shared in-flight promise
    // costs 2, and both callers get the same (deduplicated) data.
    const fetch = vi.fn().mockImplementation(async () => detection());
    vi.stubGlobal("fetch", fetch);
    const { getLiveSatelliteData } = await import("../server/routes/satellite");
    const [a, b] = await Promise.all([getLiveSatelliteData(), getLiveSatelliteData()]);
    expect(a).toEqual(b);
    expect(a.hotspots).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("Fix 42 (SAT-2): concurrent callers share one in-flight outage, and the next call re-fetches", async () => {
    // The in-flight promise is cleared in `finally`, so a failed fetch
    // never wedges the next call — it re-fetches instead of re-throwing a
    // stale rejection. Old code: 4 fetches for the pair, 6 after the third.
    const fetch = vi.fn().mockImplementation(async () => unavailable());
    vi.stubGlobal("fetch", fetch);
    const { getLiveSatelliteData, SatelliteUnavailableError } = await import("../server/routes/satellite");
    const p1 = getLiveSatelliteData();
    const p2 = getLiveSatelliteData();
    await expect(p1).rejects.toBeInstanceOf(SatelliteUnavailableError);
    await expect(p2).rejects.toBeInstanceOf(SatelliteUnavailableError);
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(getLiveSatelliteData()).rejects.toBeInstanceOf(SatelliteUnavailableError);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("Fix 42 (SAT-2): a sequential empty result is served from the 60 s slot without re-fetching", async () => {
    // Old code: the second call re-fetched upstream (4 fetches total).
    // The empty result is cached in its own slot — never overwriting the
    // healthy cache — so the second call costs no new fetches.
    const fetch = vi.fn().mockImplementation(async () => empty());
    vi.stubGlobal("fetch", fetch);
    const { getLiveSatelliteData } = await import("../server/routes/satellite");
    expect(await getLiveSatelliteData()).toEqual({ hotspots: [], sources: { VIIRS_SNPP_NRT: "ok", MODIS_NRT: "ok" } });
    expect(await getLiveSatelliteData()).toEqual({ hotspots: [], sources: { VIIRS_SNPP_NRT: "ok", MODIS_NRT: "ok" } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("Fix 42b: a partial empty result is never cached — a recovered source's detection is not masked", async () => {
    // CodeRabbit review 6038843615: Fix 42 cached the empty result
    // unconditionally, so a VIIRS-ok/MODIS-down empty poll masked a MODIS
    // recovery for 60 s. Old code: the second call returns the cached
    // partial empty result (0 hotspots, 2 fetches). Fixed code: it
    // re-fetches and returns the detection (4 fetches).
    const fetch = vi.fn()
      .mockResolvedValueOnce(empty()).mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce(empty()).mockResolvedValueOnce(detection());
    vi.stubGlobal("fetch", fetch);
    const { getLiveSatelliteData } = await import("../server/routes/satellite");
    expect(await getLiveSatelliteData()).toEqual({ hotspots: [], sources: { VIIRS_SNPP_NRT: "ok", MODIS_NRT: "unavailable" } });
    const recovered = await getLiveSatelliteData();
    expect(recovered.hotspots).toHaveLength(1);
    expect(recovered.sources).toEqual({ VIIRS_SNPP_NRT: "ok", MODIS_NRT: "ok" });
    expect(fetch).toHaveBeenCalledTimes(4);
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


describe("Fix 12f FIRMS wire columns", () => {
  it.each([
    ["Terra", "0", "MODIS", 0], ["Aqua", "100", "MODIS", 100],
    ["N", "h", "VIIRS", 95], ["N20", "l", "VIIRS", 45],
    ["N21", "n", "VIIRS", 80], ["N", "high", "VIIRS", 95],
    ["N20", "low", "VIIRS", 45], ["N21", "nominal", "VIIRS", 80],
    ["Terra", "72.5", "MODIS", 72.5], ["Aqua", "101", "MODIS", 80],
    ["Terra", "-1", "MODIS", 80], ["T", "83", "MODIS", 83],
    ["A", "83", "MODIS", 83], ["N20", "unknown", "VIIRS", 80],
    ["N20", "100", "VIIRS", 80],
  ])("parses satellite %s with confidence %s from the real columns", async (satellite, confidence, type, expected) => {
    const header = type === "MODIS" ? modisHeader : viirsHeader;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(
      header + "\n" + `36.8,7.8,340,1,1,2026-11-21,1,${satellite},${type},${confidence},${type === "MODIS" ? "6.1NRT" : "2.0NRT"},284.11,1.17,N`
    )).mockResolvedValueOnce(empty()));
    const { getLiveSatelliteData } = await import("../server/routes/satellite");
    expect((await getLiveSatelliteData()).hotspots).toEqual([
      expect.objectContaining({ satellite: type, confidence: expected, brightness: 340, lat: 36.8, lng: 7.8, scanTime: "2026-11-21T00:01:00Z" }),
    ]);
  });

  it("resolves reordered, trimmed, case-insensitive country columns by name", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(
      " country_id , INSTRUMENT ,longitude,acq_time,confidence,satellite,acq_date,brightness,latitude,scan,track,version,bright_t31,frp,daynight\n" +
      "DZA,MODIS,7.8,236,83,Terra,2026-11-21,311.65,36.8,1.03,1.02,6.1NRT,292.65,10.58,N"
    )).mockResolvedValueOnce(empty()));
    const { getLiveSatelliteData } = await import("../server/routes/satellite");
    expect((await getLiveSatelliteData()).hotspots).toEqual([
      expect.objectContaining({ satellite: "MODIS", brightness: 311.65, confidence: 83, lat: 36.8, lng: 7.8, scanTime: "2026-11-21T02:36:00Z" }),
    ]);
  });

  it.each([
    ["instrument mismatch", "36.8,7.8,340,1,1,2026-11-21,1200,Terra,VIIRS,83,6.1NRT,292.65,10.58,N"],
    ["VIIRS instrument mismatch", "36.8,7.8,340,1,1,2026-11-21,1200,N20,MODIS,n,2.0NRT,284.11,1.17,N"],
    ["unknown satellite", "36.8,7.8,340,1,1,2026-11-21,1200,UNKNOWN,MODIS,83,6.1NRT,292.65,10.58,N"],
    ["invalid latitude", "oops,7.8,340,1,1,2026-11-21,1200,Terra,MODIS,83,6.1NRT,292.65,10.58,N"],
    ["invalid longitude", "36.8,7.8oops,340,1,1,2026-11-21,1200,Terra,MODIS,83,6.1NRT,292.65,10.58,N"],
    ["missing value", "36.8,7.8,340,1,1,2026-11-21,,Terra,MODIS,83,6.1NRT,292.65,10.58,N"],
    ["truncated row", "36.8,7.8,340,1,1,2026-11-21,1200,Terra"],
  ])("drops %s while retaining the healthy detection", async (_label, row) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(modisHeader + "\n" + row))
      .mockResolvedValueOnce(detection()));
    const { getLiveSatelliteData } = await import("../server/routes/satellite");
    const data = await getLiveSatelliteData();
    expect(data.sources).toEqual({ VIIRS_SNPP_NRT: "ok", MODIS_NRT: "ok" });
    expect(data.hotspots).toEqual([expect.objectContaining({ id: "sat-live-MODIS_NRT-1", satellite: "MODIS", confidence: 83 })]);
  });

  it("accepts header-only CSV as empty and fetches subsequent detections", async () => {
    // Fix 42 (SAT-2): the empty result is now cached for 60 s, so the
    // subsequent detection is fetched only after the slot expires — the
    // fake clock is advanced past the TTL between the two calls.
    vi.useFakeTimers();
    try {
      const fetch = vi.fn().mockResolvedValueOnce(empty()).mockResolvedValueOnce(empty())
        .mockResolvedValueOnce(empty()).mockResolvedValueOnce(detection());
      vi.stubGlobal("fetch", fetch);
      const { getLiveSatelliteData } = await import("../server/routes/satellite");
      expect(await getLiveSatelliteData()).toEqual({ hotspots: [], sources: { VIIRS_SNPP_NRT: "ok", MODIS_NRT: "ok" } });
      await vi.advanceTimersByTimeAsync(61_000);
      expect((await getLiveSatelliteData()).hotspots).toHaveLength(1);
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["HTML error", "<html><body>Service unavailable</body></html>"],
    ["error sentence", "Request failed: invalid key"], ["empty body", ""],
    ["invented format without instrument", "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,confidence,version\n36.8,7.8,340,1,1,2026-11-21,1200,T,83,6.1NRT"],
    ...["latitude", "longitude", "brightness", "acq_date", "acq_time", "satellite", "instrument", "confidence"].map((name) => [
      `missing ${name}`, modisHeader.split(",").filter((column) => column !== name).join(","),
    ]),
  ])("marks %s unavailable in the route and history", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(body)));
    const res = await request((await import("../server/routes/satellite")).default).get("/");
    expect(res.status).toBe(503);
    expect(res.body.sources).toEqual({ VIIRS_SNPP_NRT: "unavailable", MODIS_NRT: "unavailable" });
    const history = await request((await import("../server/routes/history")).default).get("/?days=7");
    expect(history.status).toBe(200);
    expect(history.body.hotspotsUnavailable).toBe(true);
    expect(history.body).not.toHaveProperty("hotspotsPartial");
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
