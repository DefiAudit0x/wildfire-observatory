// VIGIL - NASA FIRMS proxy worker
// Deploy on Cloudflare Workers (free tier: 100k requests/day, IP never changes)
//
// Endpoints:
//   GET /                       -> health check (JSON, unauthenticated)
//   GET /new-key?email=YOUR_EMAIL -> requests a fresh NASA FIRMS MAP_KEY bound to THIS worker's IP
//                                   (NASA sends the key to your email; add it as the NASA_FIRMS_KEY secret)
//   GET /{source}/{bbox}/{days} -> proxies FIRMS API (key stays server-side, never in URL)
//                                   e.g. /VIIRS_SNPP_NRT/-17,18,25,38/1
//
// Auth (M5 fix): all routes except the health check require the header
//   Authorization: Bearer <PROXY_SECRET>
// where PROXY_SECRET is a Worker secret, and the server sends the same
// value via FIRMS_PROXY_SECRET.

const FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov";

// ARC-M39 fix: hardening the authenticated proxy surface.
//  - Input caps: the upstream path segments were previously concatenated
//    verbatim into the FIRMS URL — an (authenticated) client could send
//    absurdly long bbox strings or a giant days value (upstream accepts up to
//    10) and burn the worker-bound MAP_KEY quota. Enforce the FIRMS contract
//    exactly: 4 comma-separated coordinates, sane ranges, days 1..10, and a
//    known source from the short allowlist.
//  - Cache: fire hotspots refresh on a satellite pass cadence, not per click —
//    cache upstream answers at the edge for 5 minutes so a chatty server
//    poll doesn't multiply upstream quota usage.
const ALLOWED_SOURCES = new Set(["VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "MODIS_NRT", "MODIS_SP"]);
const MAX_DAYS = 10;
const UPSTREAM_CACHE_SECONDS = 300;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.split("/").filter(Boolean);
    const email = url.searchParams.get("email");

    if (path.length === 0 || path[0] === "health") {
      return json({ ok: true, service: "vigil-firms-proxy" });
    }

    // M5 fix: everything beyond the health check requires a shared secret.
    // /new-key previously accepted any email (flooding the account owner's
    // inbox with NASA MAP_KEY issuance, risking suspension for abuse), and
    // the proxy path leaked the worker-bound MAP_KEY quota to strangers.
    const proxySecret = env.PROXY_SECRET;
    if (!proxySecret) {
      return json({ ok: false, error: "proxy not configured: set PROXY_SECRET" }, 500);
    }
    const auth = request.headers.get("Authorization") || "";
    if (auth !== `Bearer ${proxySecret}`) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    // ---- Request a brand-new MAP_KEY bound to this worker's IP ----
    if (path[0] === "new-key") {
      if (!email) {
        return json({ ok: false, error: "missing email param" }, 400);
      }
      // Basic sanity: a valid-looking email, bounded length — this value is
      // forwarded verbatim to a NASA form endpoint.
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        return json({ ok: false, error: "invalid email param" }, 400);
      }
      try {
        const form = new FormData();
        form.append("email", email);
        const resp = await fetch(FIRMS_BASE + "/api/map_key/", {
          method: "POST",
          body: form,
        });
        const text = await resp.text();
        return json({
          ok: resp.ok,
          status: resp.status,
          note: "NASA has emailed the new MAP_KEY. Put it in the NASA_FIRMS_KEY secret. It is bound to this worker IP (never changes).",
          detail: text.slice(0, 500),
        }, resp.ok ? 200 : resp.status);
      } catch (err) {
        console.error("FIRMS MAP_KEY request failed", err);
        return json({ ok: false, error: "Unable to request a new MAP_KEY" }, 502);
      }
    }

    // ---- Proxy FIRMS area API ----
    if (path.length < 3) {
      return json({ ok: false, error: "usage: /{source}/{minLng},{minLat},{maxLng},{maxLat}/{days}" }, 400);
    }

    const [source, bbox, daysRaw] = path;
    if (!ALLOWED_SOURCES.has(source)) {
      return json({ ok: false, error: "unknown source" }, 400);
    }
    const coords = String(bbox || "").split(",");
    if (coords.length !== 4 || coords.some((c) => !Number.isFinite(Number(c)))) {
      return json({ ok: false, error: "bbox must be minLng,minLat,maxLng,maxLat" }, 400);
    }
    const [minLng, minLat, maxLng, maxLat] = coords.map(Number);
    if (
      Math.abs(minLng) > 180 || Math.abs(maxLng) > 180 ||
      Math.abs(minLat) > 90 || Math.abs(maxLat) > 90 ||
      minLng >= maxLng || minLat >= maxLat ||
      maxLng - minLng > 40 || maxLat - minLat > 40
    ) {
      return json({ ok: false, error: "bbox out of range" }, 400);
    }
    const days = Number(daysRaw);
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
      return json({ ok: false, error: `days must be an integer 1..${MAX_DAYS}` }, 400);
    }

    const apiKey = env.NASA_FIRMS_KEY;
    if (!apiKey) {
      return json({ ok: false, error: "NASA_FIRMS_KEY secret missing" }, 500);
    }

    const target =
      FIRMS_BASE + "/api/area/csv/" + apiKey + "/" + [source, bbox, days].join("/");

    try {
      const upstream = await fetch(target, {
        headers: { "User-Agent": "VIGIL-Observatory-Proxy/1.0" },
        cf: { cacheTtl: UPSTREAM_CACHE_SECONDS, cacheEverything: true },
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "Content-Type": upstream.headers.get("Content-Type") || "text/plain",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": `s-maxage=${UPSTREAM_CACHE_SECONDS}`,
        },
      });
    } catch (err) {
      console.error("FIRMS upstream request failed", err);
      return new Response("Upstream error", { status: 502 });
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
