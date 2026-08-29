/* kclaw service worker: offline shell. Static assets are cache-first (the
 * SPA shell opens without a network); API and /ws requests always go to the
 * network and never hit the cache.
 *
 * The cache name carries a build fingerprint: `__BUILD_ID__` below is
 * replaced by a hash of dist/index.html at build time (scripts/inject-sw-hash.mjs).
 * Any shell change rebuilds index.html → new fingerprint → browsers see a
 * byte-different sw.js → reinstall with a NEW cache and drop the old one in
 * activate. A hardcoded name would serve the first-ever cached shell forever. */
const CACHE = "kclaw-shell-__BUILD_ID__"
const SHELL = ["/", "/index.html", "/manifest.webmanifest"]

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)))
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  )
  self.clients.claim()
})

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url)
  if (url.pathname.startsWith("/ws") || url.pathname.startsWith("/api")) return // network only
  if (event.request.method !== "GET") return
  event.respondWith(
    caches.match(event.request).then((hit) => hit || fetch(event.request)),
  )
})
