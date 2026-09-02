// v2.1.1 — the CARTO basemap key is public-by-design (it rides in every tile
// URL the browser fires), but it must never be committed to the repo. The
// server serves it from its own environment (Render env var
// CARTO_BASEMAP_KEY → GET /api/config), and this module caches exactly one
// lookup per page load. ANY failure — server down, no key configured, quota
// response, offline — resolves to null and the console keeps the keyless OSM
// basemaps: the "API KEY REQUIRED" watermark disaster can never return by
// default, with or without a key.

let cached: string | null | undefined;

export async function getCartoKey(): Promise<string | null> {
  if (cached !== undefined) return cached;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch("/api/config", { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { cartoKey?: unknown };
    cached =
      typeof data.cartoKey === "string" && data.cartoKey.trim().length > 0
        ? data.cartoKey.trim()
        : null;
  } catch {
    cached = null;
  }
  return cached;
}

export function cartoUrl(
  style: "light_all" | "dark_all" | "voyager",
  key: string
): string {
  // voyager's documented raster path is /rastertiles/voyager/ — a bare
  // /voyager/ prefix 404s every tile (the v2.1.1 "empty squares" bug).
  // light_all / dark_all live at the root, no rastertiles segment.
  const path = style === "voyager" ? "rastertiles/voyager" : style;
  return `https://{s}.basemaps.cartocdn.com/${path}/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(key)}`;
}
