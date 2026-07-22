const CACHE = "wildfire-obs-v1";
const ASSETS = ["/", "/offline"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;

  // Network-first for HTML (always get latest)
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).catch(() => caches.match("/"))
    );
    return;
  }

  // Cache-first for static assets (JS, CSS, images)
  if (req.url.includes("/assets/") || req.url.match(/\.(js|css|png|svg|woff2)$/)) {
    e.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(req, clone));
        }
        return res;
      }))
    );
    return;
  }

  // Network-first for API calls
  if (req.url.includes("/api/")) {
    e.respondWith(
      fetch(req).catch(() => new Response(JSON.stringify({ error: "offline" }), {
        status: 503,
        headers: { "Content-Type": "application/json" }
      }))
    );
    return;
  }

  // Default: network-first, cache fallback
  e.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});
