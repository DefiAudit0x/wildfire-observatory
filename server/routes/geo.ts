import { Request, Response, Router } from "express";
import rateLimit from "express-rate-limit";
import logger from "../logger.js";
import { NA_BOUNDS } from "../geo.js";

const router = Router();

/**
 * W-H6: GPS coordinates used to travel to nominatim.openstreetmap.org
 * DIRECTLY from the browser (ReportForm reverse geocoding) and from the
 * Android app (ReportFragment) — an external party received exact field
 * positions with no consent gate, while the project deliberately keeps the
 * internal location pulse private. This server-side proxy is now the ONLY
 * egress for reverse geocoding:
 *   - the client never talks to a third party (same-origin only);
 *   - the server attaches the identifying User-Agent Nominatim's policy
 *     requires (the keyless public API rejects/blocks clients without one —
 *     the Android direct calls were also a policy violation, F6);
 *   - a bounded cache absorbs coordinate churn (map dragging) instead of
 *     hammering the free service;
 *   - requests are gated to the monitoring coverage, so the endpoint cannot
 *     be abused as a general-purpose geocoding relay.
 * The response body mirrors Nominatim's JSON shape (name/display_name), so
 * existing parsers (web + Android) need no changes.
 */

const REVERSE_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

const reverseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many geocoding requests." },
});

const reverseCache = new Map<string, { at: number; body: string }>();

function cacheKey(lat: number, lng: number, lang: string): string {
  // 3 decimal places ≈ 110 m — same place for map-drag churn.
  return `${lat.toFixed(3)}:${lng.toFixed(3)}:${lang}`;
}

function cacheGet(key: string): string | null {
  const hit = reverseCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    reverseCache.delete(key);
    return null;
  }
  return hit.body;
}

function cachePut(key: string, body: string): void {
  if (reverseCache.size >= CACHE_MAX_ENTRIES) {
    // Drop the oldest half — coarse but bounded and allocation-free.
    const keys = [...reverseCache.keys()].slice(0, Math.floor(CACHE_MAX_ENTRIES / 2));
    for (const k of keys) reverseCache.delete(k);
  }
  reverseCache.set(key, { at: Date.now(), body });
}

router.get("/reverse", reverseLimiter, async (req: Request, res: Response) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    res.status(400).json({ error: "lat and lng are required numbers" });
    return;
  }
  if (lat < NA_BOUNDS.minLat || lat > NA_BOUNDS.maxLat || lng < NA_BOUNDS.minLng || lng > NA_BOUNDS.maxLng) {
    res.status(400).json({ error: "Coordinates are outside the coverage area" });
    return;
  }
  const lang = req.query.lang === "fr" ? "fr" : "ar";

  const key = cacheKey(lat, lng, lang);
  const cached = cacheGet(key);
  if (cached) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Geo-Cache", "hit");
    res.send(cached);
    return;
  }

  const url =
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14` +
    `&lat=${lat}&lon=${lng}&accept-language=${lang}`;
  try {
    const upstream = await fetch(url, {
      headers: {
        // Nominatim usage policy: an identifying User-Agent is REQUIRED.
        "User-Agent": "WildfireObservatory/2.7 (wildfire civilian protection; contact: ops@wildfire-observatory)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(REVERSE_TIMEOUT_MS),
    });
    if (!upstream.ok) {
      logger.warn({ status: upstream.status }, "Nominatim reverse lookup failed upstream");
      res.status(502).json({ error: "Geocoding upstream unavailable" });
      return;
    }
    const body = await upstream.text();
    cachePut(key, body);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Geo-Cache", "miss");
    res.send(body);
  } catch (err) {
    logger.warn({ err }, "Nominatim reverse lookup unreachable");
    res.status(502).json({ error: "Geocoding upstream unavailable" });
  }
});

export default router;
