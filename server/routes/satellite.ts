import { Request, Response, Router } from "express";
import { satelliteHotspots } from "../data.js";
import { determineWilayaByCoords } from "../geo.js";
import config from "../config.js";
import logger from "../logger.js";

const router = Router();

const NORTH_AFRICA_BBOX = { minLat: 18, maxLat: 38, minLng: -17, maxLng: 25 };
const CACHE_TTL_MS = 10 * 60 * 1000;
let cachedHotspots: any[] | null = null;
let cacheTimestamp = 0;

async function fetchFirmsData(source: string): Promise<any[]> {
  const apiKey = config.nasaFirmsKey;
  if (!apiKey || apiKey === "MY_NASA_FIRMS_KEY") return [];

  const { minLat, maxLat, minLng, maxLng } = NORTH_AFRICA_BBOX;
  const isProxy = /workers\.dev|cloudflare/.test(config.firmsBaseUrl);
  const url = isProxy
    ? `${config.firmsBaseUrl}/${source}/${minLng},${minLat},${maxLng},${maxLat}/1`
    : `${config.firmsBaseUrl}/${apiKey}/${source}/${minLng},${minLat},${maxLng},${maxLat}/1`;

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

    const hotspots: any[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      if (cols.length < 8) continue;
      const lat = parseFloat(cols[1]);
      const lng = parseFloat(cols[2]);
      const brightness = parseFloat(cols[3]);
      const scanDate = cols[4];
      const scanTime = cols[5];
      const satType = cols[6] === "N" ? "VIIRS" : "MODIS";
      const confidenceStr = cols[7];
      const confidence = confidenceStr === "h" || confidenceStr === "high" ? 95 : (confidenceStr === "l" || confidenceStr === "low" ? 45 : 80);
      if (lat >= NORTH_AFRICA_BBOX.minLat && lat <= NORTH_AFRICA_BBOX.maxLat &&
          lng >= NORTH_AFRICA_BBOX.minLng && lng <= NORTH_AFRICA_BBOX.maxLng) {
        hotspots.push({
          id: `sat-live-${source}-${i}`, lat, lng, brightness, confidence,
          scanTime: `${scanDate}T${scanTime.substring(0, 2)}:${scanTime.substring(2, 4)}:00Z`,
          satellite: satType, wilaya: determineWilayaByCoords(lat, lng),
        });
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
  let hotspots: any[] = [];

  for (const source of sources) {
    const data = await fetchFirmsData(source);
    hotspots = hotspots.concat(data);
  }

  if (hotspots.length > 0) {
    cachedHotspots = hotspots;
    cacheTimestamp = now;
    return hotspots;
  }

  return satelliteHotspots.map((sat: any) => {
    const nowD = new Date();
    const timePart = sat.scanTime.split("T")[1];
    const [hours, minutes] = timePart.split(":");
    nowD.setUTCHours(parseInt(hours, 10), parseInt(minutes, 10), 0, 0);
    return { ...sat, scanTime: nowD.toISOString() };
  });
}

router.get("/", async (_req: Request, res: Response) => {
  const data = await getLiveSatelliteData();
  res.json(data);
});

export default router;
