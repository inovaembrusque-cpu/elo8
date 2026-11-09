/* Elo 8 — funciona sem internet depois da primeira abertura */
const CACHE = 'elo8-v9-online';
const ARQUIVOS = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Google, BrasilAPI etc. vão direto à internet
  e.respondWith(caches.open(CACHE).then(async c => {
    const salvo = await c.match(e.request, {ignoreSearch: true});
    const rede = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => salvo);
    return salvo || rede; // abre na hora com a versão salva e atualiza em segundo plano
  }));
});
