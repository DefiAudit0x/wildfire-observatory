/// <reference lib="webworker" />
const CACHE_NAME = "observatory-v4";
const API_CACHE = "observatory-api-v4";
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
      caches.open(CACHE_NAME).then((cache) =>
        fetch(event.request, { cache: "no-store" })
          .then((response) => {
            cache.put(event.request, response.clone());
            return response;
          })
          .catch(() => cache.match(event.request))
      )
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
