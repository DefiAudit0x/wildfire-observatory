import { Request, Response, Router } from "express";
import { satelliteHotspots } from "../data.js";
import { determineWilayaByCoords } from "../geo.js";
import config from "../config.js";

const router = Router();

async function getLiveSatelliteData() {
  const apiKey = config.nasaFirmsKey;
  if (apiKey && apiKey !== "MY_NASA_FIRMS_KEY") {
    try {
      const url = `https://firms.modaps.eosdis.nasa.gov/api/country/csv/${apiKey}/VIIRS_SNPP_NRT/DZA/1`;
      const response = await fetch(url);
      if (response.ok) {
        const text = await response.text();
        const lines = text.trim().split("\n");
        if (lines.length > 1) {
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
            if (lat >= 27.0 && lat <= 38.0 && lng >= -14.0 && lng <= 12.0) {
              hotspots.push({
                id: `sat-live-${i}`, lat, lng, brightness, confidence,
                scanTime: `${scanDate}T${scanTime.substring(0, 2)}:${scanTime.substring(2, 4)}:00Z`,
                satellite: satType, wilaya: determineWilayaByCoords(lat, lng),
              });
            }
          }
          if (hotspots.length > 0) return hotspots;
        }
      }
    } catch (err) {
      console.error("[NASA FIRMS] Fetch failed, falling back to dynamic presets:", err);
    }
  }

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
