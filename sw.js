const STATIC_CACHE = 'ramen-static-v2';
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

  // data.json → Network First（連網優先，離線才用快取）
  // 忽略 ?t= cache-busting 參數，統一以路徑為 cache key
  if (url.pathname.endsWith('data.json')) {
    const cacheKey = new Request(url.origin + url.pathname);
    event.respondWith(
      fetch(event.request)
        .then(response => {
          caches.open(DATA_CACHE).then(cache => cache.put(cacheKey, response.clone()));
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

// ── FCM / Web Push ──────────────────────────────────────────────────────────
self.addEventListener('push', event => {
  let payload = { title: '📝 新問題回報', body: '', icon: '/assets/icons/03.png' };
  try {
    const data = event.data?.json();
    if (data?.notification) {
      payload.title = data.notification.title || payload.title;
      payload.body  = data.notification.body  || '';
    }
  } catch(e) {}

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body:  payload.body,
      icon:  payload.icon,
      badge: '/assets/icons/03.png',
      tag:   'issue-report',      // 同類通知合併，不堆疊
      renotify: true,
      data:  { url: '/admin.html' },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || '/admin.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes('admin.html'));
      if (existing) return existing.focus();
      return clients.openWindow(target);
    })
  );
});
