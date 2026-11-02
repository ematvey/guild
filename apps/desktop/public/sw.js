// Guild service worker: Web Push delivery plus an app-shell fallback for
// offline launches. The shell is network-first, so an online launch always
// gets the current bundle; the cache only answers when the network is gone.
//
// The push payload is a hint: the click opens the thread and the app syncs.
// No message content is stored here.

const SHELL = "guild-shell-v2";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith("guild-shell") && key !== SHELL) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // API routes and streams pass through untouched.
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        if (res.ok) await (await caches.open(SHELL)).put(req, res.clone());
        return res;
      } catch {
        const cached = await caches.match(req);
        if (cached) return cached;
        return new Response("offline", { status: 503, statusText: "offline" });
      }
    })(),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Guild", body: event.data ? event.data.text() : "" };
  }
  const title = typeof data.title === "string" && data.title !== "" ? data.title : "Guild";
  const body = typeof data.body === "string" ? data.body : "";
  const url = typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/chats";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // One notification per thread: a second one replaces the first.
      tag: typeof data.tag === "string" ? data.tag : undefined,
      renotify: false,
      data: { url, chat_id: data.chat_id ?? null },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/chats";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        // Same origin: focus the open app instead of opening a second one.
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if ("navigate" in client) {
            try {
              await client.navigate(url);
            } catch {
              /* the client may be gone; opening a new one below covers it */
            }
          }
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
