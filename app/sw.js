// Service worker: permite instalar o app e abri-lo sem internet.
// Estratégia "rede primeiro": com internet, sempre pega a versão mais nova.
const CACHE = "financas-v1";
const BASICO = ["./", "index.html", "estilo.css", "app.js", "scanner.js", "config.js", "manifest.webmanifest", "icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(BASICO)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  const mesmaOrigem = url.origin === self.location.origin;
  const biblioteca = url.hostname === "cdn.jsdelivr.net";
  if (!mesmaOrigem && !biblioteca) return; // dados (Supabase) nunca vão para o cache
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); }
        return r;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html")))
  );
});
