const SHELL = 'quran-shell-v2';
const CORE = 'recitation-core';
const SHELL_FILES = ['index.html', 'css/app.css', 'js/app.js', 'js/download-manager.js', 'data/recitation-assets-manifest.json'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(names => Promise.all(names.filter(n => n.startsWith('quran-shell-') && n !== SHELL).map(n => caches.delete(n)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const core = await caches.open(CORE);
    const installed = await core.match(event.request);
    if (installed) return installed;
    const shell = await caches.open(SHELL);
    const cachedShell = await shell.match(event.request);
    if (cachedShell && !navigator.onLine) return cachedShell;
    try {
      const network = await fetch(event.request);
      if (network.ok && SHELL_FILES.some(path => event.request.url.endsWith(path))) shell.put(event.request, network.clone()).catch(() => {});
      return network;
    } catch (error) {
      if (cachedShell) return cachedShell;
      throw error;
    }
  })());
});
