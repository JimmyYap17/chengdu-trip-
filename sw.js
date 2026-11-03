// Offline support for the trip planner: keeps the app, the encrypted plan and the
// Firebase SDK cached so it opens with no signal. Tickets and everything you add
// are cached by Firestore's own offline cache, not here.
const CACHE = "trip-v2";
const SHELL = ["./", "index.html", "styles.css", "app.js", "plan.enc.json", "firebase-config.js", "manifest.webmanifest", "icons/icon-192.png", "icons/apple-touch-icon.png"];
const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all([
    c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))),
    // pre-cache the SDK so a first open on hotel Wi-Fi still works later offline
    c.addAll(["firebase-app.js", "firebase-auth.js", "firebase-firestore.js"].map((f) => SDK + f)).catch(() => {}),
  ])).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("trip-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const staticCdn = ["www.gstatic.com", "fonts.googleapis.com", "fonts.gstatic.com", "cdnjs.cloudflare.com"].includes(url.hostname);
  if (!sameOrigin && !staticCdn) return; // never touch Firestore / Auth traffic
  if (staticCdn) {
    e.respondWith(caches.open(CACHE).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === "opaque") c.put(req, res.clone());
      return res;
    }))));
    return;
  }
  // own files: network first so plan updates show up, cache when offline
  e.respondWith(fetch(req.url, { cache: "no-cache", credentials: "same-origin" }).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req.url, copy)); }
    return res;
  }).catch(() => caches.open(CACHE).then((c) => c.match(req.url, { ignoreSearch: true }).then((hit) => hit || c.match("index.html")))));
});
