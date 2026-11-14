/* nsp service worker */
const CACHE = "nsp-static-v12";
const PRECACHE_CONCURRENCY = 3;
/* Only the app shell — never the full site list (that caused network spam). */
const SHELL = [
  "./index.html",
  "./assets/nsp-runtime.js",
  "./manifest.webmanifest",
  "./assets/nsp-icon.svg",
];

async function mapPool(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, Math.max(list.length, 1)) }, async () => {
    while (i < list.length) {
      const idx = i++;
      try { await fn(list[idx], idx); } catch (_) {}
    }
  });
  await Promise.all(workers);
}

async function cacheUrls(urls, opts) {
  const cache = await caches.open(CACHE);
  const mode = (opts && opts.reload) ? "reload" : "default";
  const force = !!(opts && opts.reload);
  await mapPool(urls, PRECACHE_CONCURRENCY, async (url) => {
    if (!url || typeof url !== "string") return;
    try {
      // Never pull third-party analytics through the SW
      if (/googletagmanager|google-analytics|doubleclick|ads-twitter|facebook\.net|facebook\.com\/tr|aif\.notion\.so/i.test(url)) {
        return;
      }
      // Skip already-cached URLs unless install explicitly reloads
      if (!force) {
        const hit = await cache.match(url, { ignoreSearch: true });
        if (hit) return;
      }
      const r = await fetch(url, { cache: mode });
      if (r && r.ok) await cache.put(url, r);
    } catch (_) {}
  });
}

function isShellRequest(req, url) {
  if (req.mode === "navigate") return true;
  const p = url.pathname;
  return (
    /\/sw\.js$/i.test(p) ||
    /nsp-runtime\.js$/i.test(p) ||
    /nsp-precache\.json$/i.test(p) ||
    /manifest\.webmanifest$/i.test(p) ||
    /\.html$/i.test(p)
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    // Precache shell only — page assets are cached on demand as the user visits
    await cacheUrls(SHELL, { reload: true });
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

  // HTML + runtime + SW + manifest: network-first so deploys are not stuck in cache
  if (isShellRequest(req, url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await fetch(req, { cache: "no-cache" });
        if (fresh && fresh.ok) {
          cache.put(req, fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch (err) {
        const cached = await cache.match(req, { ignoreSearch: true });
        if (cached) return cached;
        if (req.mode === "navigate") {
          const index = await cache.match("./index.html");
          if (index) return index;
        }
        throw err;
      }
    })());
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
    event.waitUntil(cacheUrls(urls, { reload: false }));
  }
});
