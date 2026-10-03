// Service worker: permite instalar o app e abri-lo sem internet.
// Estratégia "rede primeiro": com internet, sempre pega a versão mais nova.
const CACHE = "financas-abdf3db8";
const BASICO = ["./", "index.html", "estilo.css", "app.js", "scanner.js", "config.js", "manifest.webmanifest", "icons/dolar-192.png", "vendor/jsQR.min.js",
  "fonts/doto-latin-900-normal.woff2", "fonts/space-grotesk-latin-400-normal.woff2", "fonts/space-grotesk-latin-500-normal.woff2",
  "fonts/space-grotesk-latin-600-normal.woff2", "fonts/space-mono-latin-400-normal.woff2", "fonts/space-mono-latin-700-normal.woff2"];
const EXTERNOS = ["https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(BASICO).then(() => c.addAll(EXTERNOS).catch(() => {}))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  const mesmaOrigem = url.origin === self.location.origin;
  const biblioteca = ["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname);
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

// Notificações de lançamentos novos (enviadas pelo servidor depois de cada sincronização)
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { titulo: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.titulo || "Finanças da Casa", {
    body: d.corpo || "", tag: d.tag, icon: "icons/dolar-192.png", badge: "icons/dolar-192.png",
    data: { url: d.url || "./" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((janelas) => {
    for (const j of janelas) {
      if ("focus" in j) { if (j.navigate) j.navigate(url).catch(() => {}); return j.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
