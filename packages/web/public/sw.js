/* kclaw service worker: offline shell. Static assets are cache-first (the
 * SPA shell opens without a network); API and /ws requests always go to the
 * network and never hit the cache. */
const SHELL = ["/", "/index.html", "/manifest.webmanifest"]

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open("kclaw-shell-v1").then((c) => c.addAll(SHELL)))
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== "kclaw-shell-v1").map((k) => caches.delete(k)))),
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
