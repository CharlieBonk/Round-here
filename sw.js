/* Round Here service worker v1.1
   Keeps the app, the map squares you have already looked at and the stop photos on the phone,
   so a loop made with signal still opens and follows without it.
   Map squares are never fetched ahead of time: the map servers' rules don't allow it. A square is kept only once the
   map has shown it. Without signal, a square that was never shown is filled with a stretched copy of a saved
   zoomed-out square covering the same ground, so the map goes soft rather than blank. Nothing is fetched for that.
   Routing, places and Wikipedia text are never cached here: they go straight to the network. */
const VERSION = 'rh-sw-1.1';
const SHELL = VERSION + '-shell';   // the app page, Leaflet, fonts
const TILES = VERSION + '-tiles';   // map squares the map has shown
const MEDIA = VERSION + '-media';   // stop photos
const HTML_URL = new URL('./round-here.html', self.location.href).href;
const PRECACHE = [
  HTML_URL,
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,200..800&display=swap'
];
const MAX_TILES = 1200, MAX_MEDIA = 300, PREFETCH_MAX = 40, PREFETCH_PARALLEL = 4, NET_TIMEOUT = 6000, SOFT_LEVELS = 5;
const TILE_HOSTS = /(^|\.)tile\.(openstreetmap|opentopomap)\.org$/;
const SHELL_HOSTS = /^(unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/;
const MEDIA_HOSTS = /^upload\.wikimedia\.org$/;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // Each file on its own: one failing must not stop the others being saved.
    await Promise.allSettled(PRECACHE.map(u => c.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('rh-sw-') && !k.startsWith(VERSION + '-')).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url; try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin === self.location.origin) { e.respondWith(networkFirst(req, url)); return; }
  if (TILE_HOSTS.test(url.hostname)) { e.respondWith(cacheFirst(req, TILES, MAX_TILES, softTile)); return; }
  if (SHELL_HOSTS.test(url.hostname)) { e.respondWith(cacheFirst(req, SHELL, 0, null)); return; }
  if (MEDIA_HOSTS.test(url.hostname)) { e.respondWith(cacheFirst(req, MEDIA, MAX_MEDIA, null)); return; }
  // Anything else (routing, places, Wikipedia text, elevation): the network, untouched.
});

self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type === 'prefetch' && Array.isArray(d.urls)) { const p = prefetch(d.urls); if (e.waitUntil) e.waitUntil(p); }
});

// The app page itself: fresh from the network when there is signal (so updates show straight away),
// the saved copy when there isn't or the network is slow.
async function networkFirst(req, url) {
  const key = url.origin + url.pathname;
  const c = await caches.open(SHELL);
  const cached = async () => (await c.match(key)) || (req.mode === 'navigate' || key === HTML_URL ? await c.match(HTML_URL) : null);
  try {
    const res = await withTimeout(fetch(req), NET_TIMEOUT);
    if (res && res.ok) { c.put(key, res.clone()).catch(() => {}); return res; }
    return (await cached()) || res;
  } catch (err) {
    const hit = await cached();
    if (hit) return hit;
    return new Response('Round Here needs signal the first time it opens. Open it once with signal and it will work offline after that.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

const putCount = {};
async function cacheFirst(req, name, max, fallback) {
  const c = await caches.open(name);
  const hit = await c.match(req, { ignoreVary: true });
  if (hit) return hit;
  try {
    const res = await fetchForCache(req);
    if (res && (res.ok || res.type === 'opaque')) {
      store(c, req.url, res.clone(), max).then(() => {
        if (!max) return;
        putCount[name] = (putCount[name] || 0) + 1;
        if (putCount[name] % 25 === 0) return trim(c, max);
      }).catch(() => {});
    }
    return res;
  } catch (err) {
    return fallback ? fallback(req) : Response.error();
  }
}

// Images are normally fetched "no-cors", which gives an opaque response; Chrome counts each of those as about 7 MB
// against the site's storage, so a few hundred tiles would fill it. Ask with CORS first (tile servers and Wikimedia
// allow it), and only fall back to the plain request for a server that does not.
const noCorsHosts = new Set();
async function fetchForCache(req, url) {
  const u = url || req.url, host = new URL(u).hostname;
  const plain = () => fetch(req || new Request(u, { mode: 'no-cors' }));
  if (noCorsHosts.has(host)) return plain();
  try { return await fetch(new Request(u, { mode: 'cors', credentials: 'omit' })); }
  catch (err) { /* refused CORS, or no signal: the plain request below tells which */ }
  const res = await plain();        // throws too when there is no signal
  noCorsHosts.add(host);            // network is fine, so it was CORS that this server refuses
  return res;
}

// Put with one retry after making room, in case the storage limit has been hit.
async function store(c, url, res, max) {
  const copy = res.clone();
  try { await c.put(url, res); }
  catch (err) { await trim(c, Math.max(50, Math.floor((max || 200) / 2))); await c.put(url, copy); }
}

// Save the stop photos the page asked for (a handful per tour), a few at a time. Only photos: anything else in the
// list, map squares included, is ignored, so no page (not even an old saved copy of it) can fetch map squares ahead.
async function prefetch(urls) {
  const media = await caches.open(MEDIA);
  const queue = urls.filter(u => { try { return MEDIA_HOSTS.test(new URL(u).hostname); } catch (err) { return false; } }).slice(0, PREFETCH_MAX);
  let active = 0;
  await new Promise(resolve => {
    const next = () => {
      if (!queue.length && active === 0) return resolve();
      while (active < PREFETCH_PARALLEL && queue.length) {
        const u = queue.shift(); active++;
        (async () => {
          try {
            if (await media.match(u)) return;
            const res = await fetchForCache(null, u);
            if (res && (res.ok || res.type === 'opaque')) await store(media, u, res, MAX_MEDIA);
          } catch (err) { /* no signal or a refused photo: skip it */ }
          finally { active--; next(); }
        })();
      }
    };
    next();
  });
  await trim(media, MAX_MEDIA);
}

// Keep a cache to its size limit by dropping the oldest entries.
async function trim(c, max) {
  try {
    const keys = await c.keys();
    if (keys.length <= max) return;
    await Promise.all(keys.slice(0, keys.length - max).map(k => c.delete(k)));
  } catch (err) {}
}

// No signal, and this map square was never shown so it was never saved. Look through the saved squares for one from a
// few zoom levels further out that covers the same ground, and stretch the matching part of it to fill the square.
// Only what is already on the phone is used. If there is nothing, or the browser can't draw here, a plain square.
async function softTile(req) {
  try {
    const u = new URL(req.url), m = /^\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(u.pathname);
    if (!m || typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') return blankTile();
    const z = +m[1], x = +m[2], y = +m[3];
    const topo = /^[abc]\.(tile\.opentopomap\.org)$/.exec(u.hostname);   // that map is spread over three server names
    const c = await caches.open(TILES);
    for (let dz = 1; dz <= SOFT_LEVELS && z - dz >= 0; dz++) {
      const n = Math.pow(2, dz), px = Math.floor(x / n), py = Math.floor(y / n), path = '/' + (z - dz) + '/' + px + '/' + py + '.png';
      const hosts = topo ? ['abc'[Math.abs(px + py) % 3], 'a', 'b', 'c'].map(s => s + '.' + topo[1]) : [u.hostname];
      let hit = null;
      for (const h of hosts) {
        const r = await c.match('https://' + h + path, { ignoreVary: true });
        if (r && r.type !== 'opaque' && r.ok) { hit = r; break; }
      }
      if (!hit) continue;
      const bmp = await createImageBitmap(await hit.blob());
      const sw = bmp.width / n, sh = bmp.height / n;
      const cv = new OffscreenCanvas(256, 256), g = cv.getContext('2d');
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      g.drawImage(bmp, (x - px * n) * sw, (y - py * n) * sh, sw, sh, 0, 0, 256, 256);
      if (bmp.close) bmp.close();
      const blob = await cv.convertToBlob({ type: 'image/png' });
      return new Response(blob, { status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } });
    }
  } catch (err) { /* fall through to the plain square */ }
  return blankTile();
}

// A plain square for a map tile that was never saved and cannot be fetched, instead of a broken-image icon.
function blankTile() {
  return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e6ebe4"/></svg>', { status: 200, headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' } });
}

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}
