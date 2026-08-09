import { Request, Response, Router } from "express";
import { satelliteHotspots } from "../data.js";
import { determineWilayaByCoords, isInKnownWilaya } from "../geo.js";
import { SatelliteHotspot } from "../../src/types.js";
import config from "../config.js";
import logger from "../logger.js";

const router = Router();

const NORTH_AFRICA_BBOX = { minLat: 18, maxLat: 38, minLng: -17, maxLng: 25 };
const CACHE_TTL_MS = 10 * 60 * 1000;
let cachedHotspots: SatelliteHotspot[] | null = null;
let cacheTimestamp = 0;

async function fetchFirmsData(source: string): Promise<SatelliteHotspot[]> {
  const apiKey = config.nasaFirmsKey;
  const isProxy = /workers\.dev|cloudflare/.test(config.firmsBaseUrl);
  if (!isProxy && (!apiKey || apiKey === "MY_NASA_FIRMS_KEY")) return [];

  const { minLat, maxLat, minLng, maxLng } = NORTH_AFRICA_BBOX;
  const days = 3;
  const url = isProxy
    ? `${config.firmsBaseUrl}/${source}/${minLng},${minLat},${maxLng},${maxLat}/${days}`
    : `${config.firmsBaseUrl}/${apiKey}/${source}/${minLng},${minLat},${maxLng},${maxLat}/${days}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logger.warn(
        { status: response.status, source, snippet: body.slice(0, 200) },
        "NASA FIRMS HTTP error — check MAP_KEY validity, area format, and IP authorization"
      );
      return [];
    }

    const text = await response.text();
    const lines = text.trim().split("\n");
    if (lines.length <= 1) return [];

    const hotspots: SatelliteHotspot[] = [];
    for (let i = 1; i < lines.length; i++) {
      try {
        const cols = lines[i].split(",");
        if (cols.length < 10) continue;
        const lat = parseFloat(cols[0]);
        const lng = parseFloat(cols[1]);
        const brightness = parseFloat(cols[2]);
        const scanDate = cols[5];
        const scanTimeRaw = cols[6].padStart(4, "0");
        const satType = cols[8] === "MODIS_NRT" ? "MODIS" : cols[8] === "VIIRS_SNPP_NRT" ? "VIIRS" : null;
        if (!satType) continue;
        const confidenceStr = cols[9];
        const confidence = confidenceStr === "h" || confidenceStr === "high" ? 95 : (confidenceStr === "l" || confidenceStr === "low" ? 45 : 80);
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
    return hotspots;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { source, msg },
      "NASA FIRMS fetch failed — if 'ETIMEDOUT', the server IP is likely not authorized on the FIRMS account; whitelist it or set FIRMS_BASE_URL to a Cloudflare Worker proxy"
    );
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function getLiveSatelliteData() {
  const now = Date.now();
  if (cachedHotspots && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedHotspots;
  }

  const sources = ["VIIRS_SNPP_NRT", "MODIS_NRT"];
  let hotspots: SatelliteHotspot[] = [];

  for (const source of sources) {
    const data = await fetchFirmsData(source);
    hotspots = hotspots.concat(data);
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
    cachedHotspots = unique;
    cacheTimestamp = now;
    return unique;
  }

  const fallback = satelliteHotspots.map((sat) => {
    const nowD = new Date();
    const timePart = sat.scanTime.split("T")[1];
    const [hours, minutes] = timePart.split(":");
    nowD.setUTCHours(parseInt(hours, 10), parseInt(minutes, 10), 0, 0);
    return { ...sat, scanTime: nowD.toISOString(), isFallback: true };
  });
  // Cache the fallback too: avoids hammering the upstream on every request
  // when FIRMS is unreachable (same 10-min window as live data).
  cachedHotspots = fallback;
  cacheTimestamp = now;
  return fallback;
}

router.get("/", async (_req: Request, res: Response) => {
  const data = await getLiveSatelliteData();
  res.json(data);
});

export default router;
