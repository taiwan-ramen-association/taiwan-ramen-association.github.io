// Firebase Messaging 專用 Service Worker
// 此檔案必須放在根目錄，FCM 會自動尋找此路徑
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            "AIzaSyBdN0AYZMM2AU66QcH4BVNJHx1plwQBBYc",
  authDomain:        "taiwan-ramen-association.firebaseapp.com",
  projectId:         "taiwan-ramen-association",
  storageBucket:     "taiwan-ramen-association.firebasestorage.app",
  messagingSenderId: "66234065738",
  appId:             "1:66234065738:web:eb9fc4348a942da66ad7b3"
});

const messaging = firebase.messaging();

// 背景訊息處理（頁面關閉時）
messaging.onBackgroundMessage(payload => {
  const n = payload.notification ?? {};
  self.registration.showNotification(n.title ?? '📝 新問題回報', {
    body:  n.body  ?? '',
    icon:  '/assets/icons/03.png',
    badge: '/assets/icons/03.png',
    tag:   'issue-report',
    renotify: true,
    data:  { url: '/admin.html' },
  });
});

// 點通知 → 開啟 admin.html
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
