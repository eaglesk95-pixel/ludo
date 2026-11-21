// Minimal service worker (needed for "Install app"). It does not cache anything,
// so the game always loads the latest version and live data from the server.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.url.includes('/socket.io')) return; // let live game traffic pass untouched
  e.respondWith(fetch(e.request));
});
