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

    const apiKey = env.NASA_FIRMS_KEY;
    if (!apiKey) {
      return json({ ok: false, error: "NASA_FIRMS_KEY secret missing" }, 500);
    }

    const target =
      FIRMS_BASE + "/api/area/csv/" + apiKey + "/" + path.join("/");

    try {
      const resp = await fetch(target, {
        headers: { "User-Agent": "VIGIL-Observatory-Proxy/1.0" },
      });
      return new Response(resp.body, {
        status: resp.status,
        headers: {
          "Content-Type": resp.headers.get("Content-Type") || "text/plain",
          "Access-Control-Allow-Origin": "*",
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
