const STATIC_CACHE = 'ramen-static-v3';
const DATA_CACHE   = 'ramen-data-v1';

const STATIC_ASSETS = [
  '/finder.html',
  '/assets/css/style.css',
  '/assets/icons/03.png',
];

// 安裝：預先快取靜態資源
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// 啟動：清除舊版快取
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== STATIC_CACHE && k !== DATA_CACHE)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 跨域請求（Firebase Storage、Firestore、Google APIs 等）直接放行，不讓 SW 介入
  if (url.origin !== self.location.origin) return;

  // data.json → Network First（連網優先，離線才用快取）
  // 忽略 ?t= cache-busting 參數，統一以路徑為 cache key
  if (url.pathname.endsWith('data.json')) {
    const cacheKey = new Request(url.origin + url.pathname);
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(DATA_CACHE).then(cache => cache.put(cacheKey, clone));
          return response;
        })
        .catch(() => caches.match(cacheKey))
    );
    return;
  }

  // finder.html → Network First（確保每次都取最新版）
  if (url.pathname.endsWith('finder.html') || url.pathname === '/') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          caches.open(STATIC_CACHE).then(cache => cache.put(event.request, response.clone()));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // 其他靜態資源 → Cache First
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

// FCM 推播由 firebase-messaging-sw.js 專責處理
