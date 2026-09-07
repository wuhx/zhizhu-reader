// Rewritten on every deploy by the "Stamp service worker cache key" step in
// .github/workflows/deploy.yml, from the hash of the core assets. The value
// committed here is only a placeholder — don't bother keeping it current.
const CACHE_NAME = 'zhizhu-cache-00000000';
const IMG_CACHE_NAME = 'zhizhu-img-v1';
const IMG_CACHE_LIMIT = 400;

// feeds.opml is a core asset because it is app state, not content: adding a
// publisher is a deploy, and the deploy's cache key covers this file, so the
// new subscription list arrives with the new worker.
const CORE_ASSETS = [
  './',
  './index.html',
  './assets/style.css',
  './assets/app.js',
  './feeds.opml'
];

// Absolute paths of the core assets, so the fetch handler can match on equality
// instead of endsWith(). './' resolves to the scope root, which is what a
// navigation request asks for.
const CORE_PATHS = new Set(
  CORE_ASSETS.map(a => new URL(a, self.registration.scope).pathname)
);

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Not cache.addAll: that goes through the HTTP cache, and Pages serves
    // everything with max-age=600. A cache key bumped within ten minutes of the
    // previous fetch would be seeded with the *old* build and, being served
    // cache-first, keep serving it forever.
    await Promise.all(CORE_ASSETS.map(async asset => {
      const res = await fetch(new Request(asset, { cache: 'reload' }));
      if (res.ok) await cache.put(asset, res);
    }));
  })());
});

self.addEventListener('activate', event => {
  // The bundle's cache is deliberately not in here: nothing reads data/ any
  // more, so leaving zhizhu-data-v1 out is what evicts it.
  const keep = new Set([CACHE_NAME, IMG_CACHE_NAME]);
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.map(key => keep.has(key) ? undefined : caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

// The revalidation can finish before the page has attached its message
// listener — on a fast connection it usually does. So remember that we found an
// update and hand it to the next client that says hello, which the page does as
// soon as it registers. One-shot: once a client has been told, a reload starts
// clean and the next revalidation finds nothing changed.
let pendingUpdate = false;

async function broadcastUpdate() {
  pendingUpdate = true;
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clients) client.postMessage({ type: 'zhizhu-update' });
}

self.addEventListener('message', event => {
  if (event.data?.type !== 'zhizhu-hello') return;
  if (pendingUpdate) {
    pendingUpdate = false;
    event.source?.postMessage({ type: 'zhizhu-update' });
  }
});

// Pages sends an ETag, but don't rely on it: fall back to Last-Modified, then
// to comparing the bodies, so the update pill still fires on a server that
// sends neither. Both responses are clones the caller no longer needs.
async function hasChanged(cached, fresh) {
  for (const header of ['ETag', 'Last-Modified']) {
    const a = cached.headers.get(header);
    const b = fresh.headers.get(header);
    if (a && b) return a !== b;
  }
  const [oldBody, newBody] = await Promise.all([cached.text(), fresh.text()]);
  return oldBody !== newBody;
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(event.request);
  // Clone now, not inside the revalidation: by the time that resumes from its
  // first await, `cached` has been handed to the page and its body is disturbed,
  // and clone() on a disturbed Response throws.
  const previous = cached && cached.clone();

  const revalidate = (async () => {
    let fresh;
    try {
      fresh = await fetch(new Request(event.request, { cache: 'no-cache' }));
    } catch {
      return cached;
    }
    if (!fresh.ok) return cached;
    const changed = previous && await hasChanged(previous, fresh.clone());
    await cache.put(event.request, fresh.clone());
    if (changed) await broadcastUpdate();
    return fresh;
  })();

  if (cached) {
    event.waitUntil(revalidate);
    return cached;
  }
  return revalidate;
}

async function cacheFirstImages(event) {
  const cached = await caches.match(event.request, { cacheName: IMG_CACHE_NAME });
  if (cached) return cached;
  const res = await fetch(event.request);
  if (res.ok || res.type === 'opaque') {
    const cache = await caches.open(IMG_CACHE_NAME);
    await cache.put(event.request, res.clone());
    // Article images live in their own cache so a core-asset bump does not
    // evict them and they do not bloat the core. Nothing else evicts them
    // either, hence the rolling window — keys() comes back in insertion order,
    // so the oldest are at the front.
    const keys = await cache.keys();
    if (keys.length > IMG_CACHE_LIMIT) {
      await Promise.all(keys.slice(0, keys.length - IMG_CACHE_LIMIT)
        .map(k => cache.delete(k)));
    }
  }
  return res;
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // Match on our own paths only: an article can perfectly well link to
  // someone else's /assets/app.js.
  const ours = url.origin === self.location.origin;

  if (event.request.mode === 'navigate' || (ours && CORE_PATHS.has(url.pathname))) {
    event.respondWith(staleWhileRevalidate(event));
    return;
  }

  // Images, and nothing else. The feeds are cross-origin GETs too, and a
  // catch-all that handed them to a cache-first strategy would pin the first
  // copy of every feed forever — the reader would never see another article.
  // Anything that is not an image is left alone, so app.js's own no-store and
  // If-None-Match reach the network as written.
  if (event.request.destination !== 'image') return;

  event.respondWith(cacheFirstImages(event).catch(() => Response.error()));
});
