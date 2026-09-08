// Service worker: precache the app shell so it launches offline (book §2.4.2).
//
// VERSION and ASSETS between the markers are rewritten by build.mjs from a
// content hash of the app files, so every deploy installs a fresh cache and
// the activate step throws the old one away.

/* BUILD:START */
const VERSION = '7e003fb45bd8';
const ASSETS = [
  './',
  'app.css',
  'app.js',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-32.png',
  'icons/icon-512-maskable.png',
  'icons/icon-512.png',
  'icons/icon-maskable.svg',
  'icons/icon.svg',
  'index.html',
  'manifest.webmanifest',
  'src/components/app-toast.js',
  'src/components/brief-outline.js',
  'src/components/command-palette.js',
  'src/components/editor-pane.js',
  'src/components/file-list.js',
  'src/components/help-dialog.js',
  'src/components/markdown-preview.js',
  'src/components/status-bar.js',
  'src/lib/brief.js',
  'src/lib/files.js',
  'src/lib/markdown.js',
  'src/lib/settings.js',
  'src/lib/state.js',
  'src/lib/store.js',
  'src/lib/themes.js',
  'src/welcome.js',
  'vendor/editor.js',
  'vendor/editor.js?v=9b64368cdc14',
];
/* BUILD:END */

const CACHE = `xor-${VERSION}`;

// While developing on localhost, prefer the network so edits show up on
// reload; the cache is still filled, so going offline keeps working.
const DEV = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Cache-first for our own assets; navigations fall back to the app shell so
// deep links and file-handler launches work offline too.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  // the viewer server's live routes are never cached or intercepted: caching /events would hold a copy of an
  // endless stream open, so every reload left a connection behind until the browser's per-host limit was hit
  if (/^\/(events|brief|briefs|file|switch|stop)(\/|$)/.test(url.pathname)) return;

  const fromNetwork = () => fetch(request).then((response) => {
    if (response.ok && response.type === 'basic' && !/text\/event-stream/.test(response.headers.get('content-type') ?? '')) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request.mode === 'navigate' ? 'index.html' : request, copy));
    }
    return response;
  });
  const fromCache = () => caches.match(request.mode === 'navigate' ? 'index.html' : request, { ignoreSearch: true });

  if (DEV) {
    event.respondWith(fromNetwork().catch(() => fromCache()));
  } else {
    event.respondWith(fromCache().then((cached) => cached ?? fromNetwork()));
  }
});
