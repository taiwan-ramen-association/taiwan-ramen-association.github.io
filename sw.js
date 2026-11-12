const STATIC_CACHE = 'ramen-static-v4';
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

// Network First（連網優先）：先抓網路，成功就存一份；連不上才用存的那份。
// - 快取鍵只用路徑、不含網址參數：data.json 的 ?t=、finder.html 的 ?shop=／?q=／utm_* 等都是同一份檔案，
//   只存一份；離線時帶參數的網址也找得到。
// - 一定要在 return 之前 clone：response 交給瀏覽器後就開始被讀，之後再 clone 會失敗
//   （v3 的 finder.html 那段就是這樣，每次都失敗、從沒存進去）。
// - 只存成功的回應：404／500 不會蓋掉上一份好的。
function networkFirst(event, url, cacheName) {
  const cacheKey = new Request(url.origin + url.pathname);
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(cacheName).then(cache => cache.put(cacheKey, copy)));
        }
        return response;
      })
      .catch(() => caches.match(cacheKey))
  );
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 跨域請求（Firebase Storage、Firestore、Google APIs 等）直接放行，不讓 SW 介入
  if (url.origin !== self.location.origin) return;

  // data.json → Network First（離線才用快取）
  if (url.pathname.endsWith('data.json')) {
    networkFirst(event, url, DATA_CACHE);
    return;
  }

  // finder.html、首頁「/」→ Network First（確保每次都取最新版）
  if (url.pathname.endsWith('finder.html') || url.pathname === '/') {
    networkFirst(event, url, STATIC_CACHE);
    return;
  }

  // 其他靜態資源 → Cache First：只有 STATIC_ASSETS 會在快取裡，其他找不到就直接抓、不存。
  // 所以 style.css、03.png 改了要把 STATIC_CACHE 版號 +1，不然開過搜尋器的人會一直拿到舊的。
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

// FCM 推播由 firebase-messaging-sw.js 專責處理
