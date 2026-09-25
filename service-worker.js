const SHELL = 'quran-shell-v7';
const CORE = 'recitation-core';
// Publish the complete executable shell atomically. Old CORE entries must not
// shadow a new worker, matcher, or asset manifest after an application update.
const SHELL_FILES = ['index.html', 'css/app.css', 'data/recitation-assets-manifest.json',
  'assets/models/meta.json', 'service-worker.js',
  'js/app.js', 'js/asr-selection.js', 'js/asr-engine.js', 'js/asr-worker.js', 'js/audio-worklet.js',
  'js/calibration.js', 'js/download-manager.js', 'js/firebase.js', 'js/microphone.js',
  'js/mushaf-renderer.js', 'js/quran-data.js', 'js/pronunciation.js',
  'js/pronunciation-provider.js', 'js/phoneme-scoring.js', 'js/phoneme-worker.js',
  'js/word-audio.js', 'js/recitation-engine.js',
  'js/report-engine.js', 'js/sha256.js', 'js/transcript-gate.js'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(names => Promise.all(names.filter(n => n.startsWith('quran-shell-') && n !== SHELL).map(n => caches.delete(n)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const url = new URL(event.request.url);
    const shell = await caches.open(SHELL);
    const scope = new URL(self.registration.scope);
    const relative = url.pathname.slice(scope.pathname.length) || 'index.html';
    if (SHELL_FILES.includes(relative)) {
      const installedShell = await shell.match(new URL(relative, scope));
      if (installedShell) return installedShell;
      return fetch(event.request);
    }
    const installed = await (await caches.open(CORE)).match(event.request);
    return installed || fetch(event.request);
  })());
});
