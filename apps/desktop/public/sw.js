// Guild PWA service worker: installability + app-shell offline fallback.
// API routes (including SSE streaming) always pass through untouched.
const CACHE = "guild-shell-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        if (res.ok) {
          const cache = await caches.open(CACHE);
          cache.put(req, res.clone());
        }
        return res;
      } catch {
        const cached = await caches.match(req);
        if (cached) return cached;
        return new Response("offline", { status: 503, statusText: "offline" });
      }
    })(),
  );
});
