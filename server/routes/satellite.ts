import { Request, Response, Router } from "express";
import { satelliteHotspots } from "../data.js";
import { determineWilayaByCoords } from "../geo.js";
import config from "../config.js";
import logger from "../logger.js";

const router = Router();

const NORTH_AFRICA_BBOX = { minLat: 18, maxLat: 38, minLng: -17, maxLng: 25 };

async function fetchFirmsData(source: string): Promise<any[]> {
  const apiKey = config.nasaFirmsKey;
  if (!apiKey || apiKey === "MY_NASA_FIRMS_KEY") return [];

  const { minLat, maxLat, minLng, maxLng } = NORTH_AFRICA_BBOX;
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${apiKey}/${source}/${minLat}/${maxLat}/${minLng}/${maxLng}/1`;

  const response = await fetch(url);
  if (!response.ok) return [];

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
}

async function getLiveSatelliteData() {
  const sources = ["VIIRS_SNPP_NRT", "MODIS_NRT"];
  let hotspots: any[] = [];

  for (const source of sources) {
    try {
      const data = await fetchFirmsData(source);
      hotspots = hotspots.concat(data);
    } catch (err) {
      logger.error({ err, source }, "NASA FIRMS fetch failed");
    }
  }

  if (hotspots.length > 0) return hotspots;

  return satelliteHotspots.map((sat: any) => {
    const now = new Date();
    const timePart = sat.scanTime.split("T")[1];
    const [hours, minutes] = timePart.split(":");
    now.setUTCHours(parseInt(hours, 10), parseInt(minutes, 10), 0, 0);
    return { ...sat, scanTime: now.toISOString() };
  });
}

router.get("/", async (_req: Request, res: Response) => {
  const data = await getLiveSatelliteData();
  res.json(data);
});

export default router;
