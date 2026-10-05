// 2026-07-30 restore-fix：图文工具已停用离线缓存。
// 旧版缓存优先 Service Worker 仍可能控制已打开的页面，因此本版本先改为
// 网络直通，再删除旧缓存并注销自己，让下一次导航一定拿到最新恢复逻辑。
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('card-tool-')).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
      .then(() => self.registration.unregister())
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
