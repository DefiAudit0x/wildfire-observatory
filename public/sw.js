/// <reference lib="webworker" />
const CACHE_NAME = "observatory-v6";
const API_CACHE = "observatory-api-v6";
const STATIC_FILES = ["/", "/index.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME && k !== API_CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/")) {
    const liveEndpoints = ["/api/reports", "/api/wilayas", "/api/satellite-data"];
    if (liveEndpoints.some((endpoint) => url.pathname.startsWith(endpoint))) {
      event.respondWith(
        fetch(event.request, { cache: "no-store" }).catch(() =>
          caches.open(API_CACHE).then((cache) => cache.match(event.request))
        )
      );
      return;
    }
    event.respondWith(
      caches.open(API_CACHE).then((cache) =>
        fetch(event.request, { cache: "no-store" })
          .then((response) => {
            if (!response.ok) return response;
            const headers = new Headers(response.headers);
            headers.set("cache-control", "max-age=120");
            const cachedResponse = new Response(response.clone().body, {
              status: response.status,
              statusText: response.statusText,
              headers,
            });
            cache.put(event.request, cachedResponse);
            return response;
          })
          .catch(() => cache.match(event.request))
      )
    );
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    event.respondWith(
      fetch(event.request, { cache: "no-store" })
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        fetch(event.request, { cache: "no-store" })
          .then((response) => {
            if (response.ok) {
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
            }
          })
          .catch(() => {});
        return cached;
      }
      return fetch(event.request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      });
    })
  );
});
