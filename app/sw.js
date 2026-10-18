// The service worker makes the app installable and lets it open with no signal (S22a, owner
// 2026-10-16: the iPhone app opens offline; browsers get the same).
// - Online, nothing changes: every request goes to the network first, so the version.txt
//   auto-update sees each deploy as before. The cache is only a fallback when fetch fails.
// - One cache per build, filled whole at install (BUILD.files, written by scripts/build.mjs),
//   never from live responses: offline, every file comes from the same build, so a shell from
//   one deploy never runs modules from another. Older builds' caches go at activate.
// - Never strands a device: a navigation that fails falls back to the cached page; with no
//   cache it fails as it would without a service worker.
// - Cross-origin calls (bridge, Supabase) pass through untouched; version.txt never comes
//   from the cache (offline, "no news" is the right answer).

const BUILD = { version: 'dev', files: [] }; // replaced by scripts/build.mjs
const CACHE = `mullo-${BUILD.version}`;
const PAGE = new URL('./', self.location).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    if (BUILD.files.length) {
      // A file that can't be fetched is skipped, not fatal: no offline copy beats no update.
      const cache = await caches.open(CACHE);
      await Promise.all([PAGE, ...BUILD.files.map((f) => new URL(f, self.location).href)].map(async (url) => {
        try {
          const res = await fetch(url, { cache: 'reload' });
          if (res.ok) await cache.put(url, res);
        } catch { /* offline at install: this file stays uncached */ }
      }));
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith('mullo-') && name !== CACHE) await caches.delete(name);
  await self.clients.claim();
})()));

const fromCache = async (url) => (await caches.open(CACHE)).match(url, { ignoreSearch: true });

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(async () => (await fromCache(PAGE)) ?? Response.error()));
    return;
  }
  if (url.pathname.endsWith('/version.txt')) return;
  event.respondWith(fetch(req).catch(async () => (await fromCache(url.href)) ?? Response.error()));
});
