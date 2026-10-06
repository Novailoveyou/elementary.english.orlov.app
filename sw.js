/* nsp service worker */
const CACHE = "nsp-static-v9";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    try {
      const res = await fetch("./assets/nsp-precache.json", { cache: "no-cache" });
      const list = await res.json();
      const cache = await caches.open(CACHE);
      await Promise.all(
        list.map(async (url) => {
          try {
            const r = await fetch(url, { cache: "reload" });
            if (r.ok) await cache.put(url, r);
          } catch (_) {}
        }),
      );
    } catch (_) {}
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isMedia =
    /\.(mp3|m4a|ogg|wav|aac|mp4|webm|mov)(\?|$)/i.test(url.pathname) ||
    (req.headers.get("accept") || "").includes("audio/");
  // Range requests must hit the network — serving a full cached body breaks audio
  if (isMedia || req.headers.has("range")) {
    event.respondWith(
      fetch(req)
        .then((fresh) => {
          if (fresh && fresh.ok && !req.headers.has("range")) {
            const copy = fresh.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return fresh;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE);
          const cached = await cache.match(req, { ignoreSearch: true });
          if (cached) return cached;
          throw new Error("offline media miss");
        }),
    );
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) {
      // Revalidate in background
      event.waitUntil(
        fetch(req)
          .then((r) => {
            if (r && r.ok) return cache.put(req, r.clone());
          })
          .catch(() => {}),
      );
      return cached;
    }
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) {
        cache.put(req, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch (err) {
      // Offline fallback to index for navigations
      if (req.mode === "navigate") {
        const index = await cache.match("./index.html");
        if (index) return index;
      }
      throw err;
    }
  })());
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "NSP_CACHE_URLS") {
    const urls = event.data.urls || [];
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        urls.map(async (url) => {
          try {
            const r = await fetch(url, { cache: "reload" });
            if (r.ok) await cache.put(url, r);
          } catch (_) {}
        }),
      );
    })());
  }
});
