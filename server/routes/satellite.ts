import { Request, Response, Router } from "express";
import { determineWilayaByCoords, isInKnownWilaya } from "../geo.js";
import { SatelliteHotspot } from "../../src/types.js";
import config from "../config.js";
import logger from "../logger.js";

const router = Router();

const NORTH_AFRICA_BBOX = { minLat: 18, maxLat: 38, minLng: -17, maxLng: 25 };
const CACHE_TTL_MS = 10 * 60 * 1000;
let cachedHotspots: SatelliteData | null = null;
let cacheTimestamp = 0;
// Fix 42 (SAT-2): empty results were never cached and there was no in-flight
// promise, so every poll cycle x 3 callers (GET /api/satellite, wilayas,
// history) did 2 upstream FIRMS calls each. An empty result is now cached
// for 60 s in a SEPARATE slot — never overwriting the healthy cache, so
// SAT-1's contract (only all-ok observations populate it; partial results
// are served as 503, never cached) is untouched. Concurrent callers share
// one in-flight fetch; the promise is cleared in `finally`, never stuck on
// rejection.
const EMPTY_CACHE_TTL_MS = 60 * 1000;
let cachedEmptyResult: SatelliteData | null = null;
let emptyCacheTimestamp = 0;
let inFlightFetch: Promise<SatelliteData> | null = null;

type SourceStatus = "ok" | "unavailable";
type SatelliteData = { hotspots: SatelliteHotspot[]; sources: Record<string, SourceStatus> };
const SATELLITE_UNAVAILABLE_MESSAGE = "Satellite data is currently unavailable";
export class SatelliteUnavailableError extends Error {
  constructor(readonly sources: Record<string, SourceStatus>) {
    super(SATELLITE_UNAVAILABLE_MESSAGE);
  }
}
type FirmsResult = { status: "ok"; data: SatelliteHotspot[] } | { status: "unavailable" };

async function fetchFirmsData(source: string): Promise<FirmsResult> {
  const apiKey = config.nasaFirmsKey;
  const isProxy = /workers\.dev|cloudflare/.test(config.firmsBaseUrl);
  if (!isProxy && (!apiKey || apiKey === "MY_NASA_FIRMS_KEY")) return { status: "unavailable" };

  const { minLat, maxLat, minLng, maxLng } = NORTH_AFRICA_BBOX;
  const days = 3;
  const url = isProxy
    ? `${config.firmsBaseUrl}/${source}/${minLng},${minLat},${maxLng},${maxLat}/${days}`
    : `${config.firmsBaseUrl}/${apiKey}/${source}/${minLng},${minLat},${maxLng},${maxLat}/${days}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    // M5 fix: when fetching through the Cloudflare worker proxy, present the
    // shared proxy secret — the worker rejects unauthenticated callers.
    const response = await fetch(url, {
      signal: controller.signal,
      ...(isProxy && config.firmsProxySecret
        ? { headers: { Authorization: `Bearer ${config.firmsProxySecret}` } }
        : {}),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logger.warn(
        { status: response.status, source, snippet: body.slice(0, 200) },
        "NASA FIRMS HTTP error — check MAP_KEY validity, area format, and IP authorization"
      );
      return { status: "unavailable" };
    }

    const text = await response.text();
    const lines = text.trim().split("\n");
    const header = lines[0].split(",").map((name) => name.trim().toLowerCase());
    const columns = {
      lat: header.indexOf("latitude"), lng: header.indexOf("longitude"),
      brightness: header.includes("brightness") ? header.indexOf("brightness") : header.indexOf("bright_ti4"),
      scanDate: header.indexOf("acq_date"), scanTime: header.indexOf("acq_time"),
      satellite: header.indexOf("satellite"), instrument: header.indexOf("instrument"),
      confidence: header.indexOf("confidence"),
    };
    if (Object.values(columns).some((index) => index < 0)) return { status: "unavailable" };

    const hotspots: SatelliteHotspot[] = [];
    for (let i = 1; i < lines.length; i++) {
      try {
        const cols = lines[i].split(",").map((value) => value.trim());
        if (Object.values(columns).some((index) => !cols[index])) continue;
        const lat = Number(cols[columns.lat]);
        const lng = Number(cols[columns.lng]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const brightness = parseFloat(cols[columns.brightness]);
        const scanDate = cols[columns.scanDate];
        const scanTimeRaw = cols[columns.scanTime].padStart(4, "0");
        const spacecraft = cols[columns.satellite];
        const satType = ["Terra", "Aqua", "T", "A"].includes(spacecraft) ? "MODIS" : ["N", "N20", "N21"].includes(spacecraft) ? "VIIRS" : null;
        if (!satType || cols[columns.instrument] !== satType) continue;
        const confidenceStr = cols[columns.confidence].toLowerCase();
        const numericConfidence = Number(confidenceStr);
        const confidence = satType === "MODIS"
          ? (Number.isFinite(numericConfidence) && numericConfidence >= 0 && numericConfidence <= 100 ? numericConfidence : 80)
          : (confidenceStr === "h" || confidenceStr === "high" ? 95 : confidenceStr === "l" || confidenceStr === "low" ? 45 : 80);
        if (lat >= NORTH_AFRICA_BBOX.minLat && lat <= NORTH_AFRICA_BBOX.maxLat &&
            lng >= NORTH_AFRICA_BBOX.minLng && lng <= NORTH_AFRICA_BBOX.maxLng &&
            isInKnownWilaya(lat, lng)) {
          hotspots.push({
            id: `sat-live-${source}-${i}`, lat, lng, brightness, confidence,
            scanTime: `${scanDate}T${scanTimeRaw.substring(0, 2)}:${scanTimeRaw.substring(2, 4)}:00Z`,
            satellite: satType, wilaya: determineWilayaByCoords(lat, lng),
          });
        }
      } catch {
        // skip malformed CSV line
      }
    }
    return { status: "ok", data: hotspots };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { source, msg },
      "NASA FIRMS fetch failed — if 'ETIMEDOUT', the server IP is likely not authorized on the FIRMS account; whitelist it or set FIRMS_BASE_URL to a Cloudflare Worker proxy"
    );
    return { status: "unavailable" };
  } finally {
    clearTimeout(timeout);
  }
}

export async function getLiveSatelliteData(): Promise<SatelliteData> {
  const now = Date.now();
  if (cachedHotspots && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedHotspots;
  }
  // Fix 42 (SAT-2): a fresh empty result is served from its own 60 s slot
  // instead of re-fetching upstream on every poll cycle.
  if (cachedEmptyResult && now - emptyCacheTimestamp < EMPTY_CACHE_TTL_MS) {
    return cachedEmptyResult;
  }
  // Fix 42 (SAT-2): concurrent callers share one in-flight fetch.
  if (inFlightFetch) return inFlightFetch;
  inFlightFetch = (async (): Promise<SatelliteData> => {
    const sources = ["VIIRS_SNPP_NRT", "MODIS_NRT"];
    let hotspots: SatelliteHotspot[] = [];

    const sourceStatuses: Record<string, SourceStatus> = {};
    for (const source of sources) {
      const result = await fetchFirmsData(source);
      sourceStatuses[source] = result.status;
      if (result.status === "ok") hotspots = hotspots.concat(result.data);
    }
    if (Object.values(sourceStatuses).every((status) => status === "unavailable")) {
      throw new SatelliteUnavailableError(sourceStatuses);
    }

    if (hotspots.length > 0) {
      // Deduplicate: the same burning area often appears in both VIIRS and MODIS
      const unique: SatelliteHotspot[] = [];
      for (const h of hotspots) {
        const existing = unique.find(
          (u) => Math.abs(u.lat - h.lat) < 0.05 && Math.abs(u.lng - h.lng) < 0.05
        );
        if (!existing) {
          unique.push(h);
        } else if (h.confidence > existing.confidence) {
          existing.confidence = h.confidence;
          existing.brightness = h.brightness;
          existing.satellite = `${existing.satellite}/${h.satellite}` as SatelliteHotspot["satellite"];
        }
      }
      const data = { hotspots: unique, sources: sourceStatuses };
      // An incomplete observation must not replace a previously healthy dataset.
      if (Object.values(sourceStatuses).every((status) => status === "ok")) {
        cachedHotspots = data;
        cacheTimestamp = now;
      }
      return data;
    }

    const emptyData = { hotspots: [], sources: sourceStatuses };
    cachedEmptyResult = emptyData;
    emptyCacheTimestamp = now;
    return emptyData;
  })();
  try {
    return await inFlightFetch;
  } finally {
    // Cleared on success AND on rejection, so a failed fetch never wedges
    // the next call — it re-fetches.
    inFlightFetch = null;
  }
}

router.get("/", async (_req: Request, res: Response) => {
  try {
    const { hotspots, sources } = await getLiveSatelliteData();
    if (Object.values(sources).some((status) => status !== "ok")) {
      return res.status(503).json({ error: SATELLITE_UNAVAILABLE_MESSAGE, sources, hotspots });
    }
    res.json(hotspots);
  } catch (err) {
    if (!(err instanceof SatelliteUnavailableError)) throw err;
    res.status(503).json({ error: err.message, sources: err.sources });
  }
});

export default router;
