/* SetBook service worker — offline support for a GitHub Pages single-file app.
 *
 * Caching strategy:
 *   - Navigation / index.html: NETWORK-FIRST with cache fallback. A GitHub
 *     Pages deploy must never be pinned stale: users always get the newest
 *     app when online, and the cache only serves when the network fails.
 *   - Immutable, versioned assets (jsPDF + PDF.js on cdnjs, Google Fonts CSS + font
 *     files): CACHE-FIRST. Those URLs are content-addressed or effectively
 *     immutable, so a cached copy is always correct; this is what makes PDF
 *     export work offline after the jsPDF lazy-load.
 *   - Drive/API traffic is never intercepted (see the bypass list): user
 *     credentials must not transit the SW cache, and SetBook degrades
 *     gracefully when offline anyway (the recovery snapshot + local autosave
 *     stay authoritative until the next online save).
 *
 * Bump CACHE_VERSION whenever the app's cached asset list changes; old
 * caches are deleted on activate.
 */
const CACHE_VERSION = 'v2';
const CACHE_NAME = `setbook-${CACHE_VERSION}`;

// Same-origin shell + cross-origin immutable assets to pre-cache.
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  // jsPDF — loaded lazily by the app, cached here so offline exports work.
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  // PDF.js — lazy-loaded by the per-song Performance preview's page-turning
  // strip (ensurePdfJs); cached here so the strip works offline after first use.
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  // Google Fonts (Work Sans + JetBrains Mono): the CSS and its font files
  // are added to the cache opportunistically on first fetch (they can't be
  // enumerated here because the CSS content varies by user agent).
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('setbook-') && k !== CACHE_NAME)
            .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Never intercept: auth/consent popups and Drive API traffic.
function isBypassed(url){
  return url.hostname === 'accounts.google.com' ||
         url.hostname === 'oauth2.googleapis.com' ||
         url.hostname === 'www.googleapis.com' ||
         url.hostname === 'apis.google.com';
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try{ url = new URL(req.url); } catch(err){ return; }
  if (isBypassed(url)) return;

  // App shell / navigations: network-first, cache fallback.
  if (req.mode === 'navigate' ||
      (url.origin === self.location.origin && (url.pathname === '/' || url.pathname.endsWith('/index.html')))){
    event.respondWith(
      fetch(req).then((res) => {
        // Refresh the cached copy with the fresh one.
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy)).catch(() => {});
        return res;
      }).catch(() =>
        caches.match('./index.html').then((hit) => hit || Response.error())
      )
    );
    return;
  }

  // Everything else: cache-first with network fill (works for fonts, the
  // jsPDF/PDF.js CDN, icons). Only cache successful basic/cors responses.
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && (res.type === 'basic' || res.type === 'cors') && res.status === 200){
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit || Response.error());
    })
  );
});
