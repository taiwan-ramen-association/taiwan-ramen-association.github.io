// ── photos.js ────────────────────────────────────────────────────────────────
// Places API 店家照片載入與快取 + 通用照片瀏覽器（Photo Viewer）
// 依賴：無外部全域（純使用 fetch、localStorage、DOM API）
// 依賴函式（reviews.js 提供）：getUserDisplay
// 提供全域函式：
//   loadShopPhotos（Places 照片主入口）
//   openPhotoViewer / closePhotoViewer（通用照片瀏覽器，被 reviews.js / menu / Places 共用）

// ── Constants ─────────────────────────────────────────────────────────────────
const PLACES_KEY       = 'AIzaSyBek6fDRbXZhxenlSgwR1DLaVRJjrxYUOU';
const photoCache       = {}; // 記憶體快取：shopId → data | 'loading' | null
// 逃生口：把版本字尾往上加（如 'ramen_photo_v2_'）即可讓全體使用者的照片快取與
// 失敗冷卻一次失效，用途有二：(1) 設定修好後要強制全體重抓 (2) 本次改動回滾時必改。
// 注意：改號等於清空所有人的快取，會造成一波 Places API 重抓（2026-07 換網域即因此爆量），
// 只在真的需要時才動。
const PHOTO_LS_PREFIX  = 'ramen_photo_';
// 圖片／API 失敗後的冷卻期。期間內不再向 Places API 詢問同一家店。
const PHOTO_FAIL_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

// ── localStorage 快取輔助 ────────────────────────────────────────────────────
// 快取值有兩種形態：
//   正常：{ urls: [...], attribution: '...' }
//   失敗：{ urls: [...保留原值...], attribution: '...', failedAt: <timestamp> }
// 失敗時「保留 urls、只加標記」而不是刪除整筆，是為了讓本次改動可以安全回滾——
// 舊版程式不認得 failedAt 會直接忽略，看到 urls 仍在就照原邏輯運作。
function lsGetPhoto(shopId) {
  try { const v = localStorage.getItem(PHOTO_LS_PREFIX + shopId); return v ? JSON.parse(v) : null; } catch { return null; }
}
function lsSetPhoto(shopId, data) {
  try { localStorage.setItem(PHOTO_LS_PREFIX + shopId, JSON.stringify(data)); } catch {}
}
// 標記「這家店剛才抓失敗」。成功路徑的 lsSetPhoto 會整筆覆寫，failedAt 自然消失，
// 因此不需要另外的解除函式。
function lsMarkPhotoFail(shopId, cached) {
  lsSetPhoto(shopId, {
    urls:        cached?.urls ?? [],
    attribution: cached?.attribution ?? '',
    failedAt:    Date.now(),
  });
}

// ── 載入店家照片 ──────────────────────────────────────────────────────────────
// isRetry=true 時不再觸發二次重抓，避免無限循環
async function loadShopPhotos(shop, panel, isRetry = false) {
  const shopId = shop['ID'];

  // 重抓走 photo_refetch，正常瀏覽走 photo_view。冷卻機制會把重抓壓到接近 0，
  // 所以 GA4 上 photo_refetch 一旦冒量就是異常訊號（不必等帳單才發現）。
  if (typeof gtag !== 'undefined') {
    gtag('event', isRetry ? 'photo_refetch' : 'photo_view',
         { shop_id: shopId, shop_name: shop['店名'] || '' });
  }

  // 1. 記憶體快取
  if (photoCache[shopId] && photoCache[shopId] !== 'loading') {
    renderPhotoPanel(photoCache[shopId], panel, shop, !isRetry);
    return;
  }
  if (photoCache[shopId] === 'loading') return;

  // 2. localStorage 快取（跨重整、跨 App 存活）
  if (!isRetry) {
    const cached = lsGetPhoto(shopId);
    if (cached) {
      // 冷卻期內：這家店最近抓過而且失敗，直接顯示結果，不再打 Places API。
      // 舊行為是「失敗就清快取重抓」，導致每開一次卡片就付一次 API 費用。
      if (cached.failedAt && Date.now() - cached.failedAt < PHOTO_FAIL_COOLDOWN_MS) {
        panel.innerHTML = '<p class="tab-placeholder">Google Maps 尚無此店照片</p>';
        return;
      }
      // 冷卻已過但沒有可用 urls → 往下走重新抓
      if (cached.urls?.length) {
        photoCache[shopId] = cached;
        renderPhotoPanel(cached, panel, shop, true); // 仍需驗證圖片是否有效
        return;
      }
    }
  }

  photoCache[shopId] = 'loading';
  panel.innerHTML = '<p class="tab-placeholder" style="padding:20px 0">載入中…</p>';

  try {
    const query = [shop['店名'], shop['地址']].filter(Boolean).join(' ');
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': PLACES_KEY,
        'X-Goog-FieldMask': 'places.photos',
      },
      body: JSON.stringify({ textQuery: query, languageCode: 'zh-TW' }),
    });
    const json = await res.json();
    // API 回錯誤（key referrer 被擋、配額不足等）時，res.json() 會解析出 error 物件而非 throw，
    // 明確轉成例外交給 catch，避免下面的空陣列被誤判成「沒照片」而顯示錯誤提示。
    if (!res.ok || json.error) throw new Error(json.error?.message || `HTTP ${res.status}`);
    const photos = json.places?.[0]?.photos?.slice(0, 3) ?? [];

    const urls = photos.map(p =>
      `https://places.googleapis.com/v1/${p.name}/media?maxWidthPx=800&key=${PLACES_KEY}`
    );
    const attribution = photos[0]?.authorAttributions?.[0]?.displayName ?? '';
    const data = { urls, attribution };
    photoCache[shopId] = data;
    lsSetPhoto(shopId, data);
    renderPhotoPanel(data, panel, shop, !isRetry);
  } catch(e) {
    console.warn('[photos] 載入失敗：', e.message || e);
    photoCache[shopId] = null;
    // API 本身失敗（referrer 被擋、配額用盡、網路問題）也要記冷卻。
    // 原本失敗完全不寫快取，而 photoCache = null 通不過上面第 1 段的 truthy 檢查，
    // 導致同一個 session 內每開一次卡片就重打一次 API。
    lsMarkPhotoFail(shopId, null);
    panel.innerHTML = '<p class="tab-placeholder">Google Maps 尚無此店照片</p>';
  }
}

// shop      傳入時才會在圖片全數失敗後記錄冷卻標記
// allowRetry 是否允許再向 API 重抓一次（重抓那一輪為 false，避免無限遞迴）
// 兩者拆開的原因：舊寫法用「shop 傳 null」兼作防遞迴，導致重抓失敗時拿不到 shop
// 而無法記錄冷卻，冷卻機制等於失效。
function renderPhotoPanel({ urls, attribution }, panel, shop = null, allowRetry = true) {
  if (!urls.length) {
    panel.innerHTML = '<p class="tab-placeholder">Google Maps 尚無此店照片</p>';
    return;
  }
  const sourceLabel = `圖片來源：Google Maps${attribution ? '・' + attribution : ''}`;
  panel.innerHTML = `
    <div class="photo-grid">
      ${urls.map((u, i) => `
        <div class="photo-grid-item" data-idx="${i}">
          <img class="loading" src="${u}" alt="店家照片">
        </div>`).join('')}
    </div>
    <p class="photo-attribution">${sourceLabel}</p>`;

  // 點圖開啟 viewer（不另開分頁，attribution 隨圖呈現）
  panel.querySelectorAll('.photo-grid-item').forEach(item => {
    item.addEventListener('click', () => {
      const idx = parseInt(item.dataset.idx, 10) || 0;
      openPhotoViewer(urls, idx, { source: sourceLabel });
    });
  });

  // JS 附掛 onload / onerror，計算成功張數，判斷是否需重抓
  const imgs  = [...panel.querySelectorAll('img')];
  const total = imgs.length;
  let settled = 0, loaded = 0;

  imgs.forEach(img => {
    img.onload = () => {
      img.classList.replace('loading', 'loaded');
      loaded++; settled++;
      checkDone();
    };
    img.onerror = () => {
      img.closest('.photo-grid-item')?.remove();
      settled++;
      checkDone();
    };
  });

  function checkDone() {
    if (settled < total) return;
    // 至少 1 張載入成功就視為正常。原本條件是 loaded <= 1，會把「Google 上只有
    // 1 張照片」的店誤判成失敗，導致這類店家每個 session 都固定重抓一次。
    if (loaded >= 1 || !shop) return;

    // 全部載不出來 → 記冷卻（保留 urls，見 lsMarkPhotoFail 註解），並重抓一次
    const shopId = shop['ID'];
    lsMarkPhotoFail(shopId, photoCache[shopId]);
    delete photoCache[shopId];
    if (allowRetry) loadShopPhotos(shop, panel, true);
  }
}

// ── Photo Viewer（通用照片瀏覽器） ────────────────────────────────────────────
// meta 欄位：
//   urls       - 圖片網址陣列
//   startIdx   - 起始索引
//   meta.date  - 拍攝日期（可選）
//   meta.uid   - 上傳者 uid（可選，會非同步查 displayName）
//   meta.authorName - 顯示名稱（可選，meta.uid 取代）
//   meta.source - 來源標籤（如「圖片來源：Google Maps・XXX」，提供時優先於 author 顯示）
let _pvUrls = [];
let _pvIdx  = 0;
let _pvMeta = {};

function openPhotoViewer(urls, startIdx, meta) {
  _pvUrls = Array.isArray(urls) ? urls : [urls];
  _pvIdx  = Math.max(0, Math.min(startIdx || 0, _pvUrls.length - 1));
  _pvMeta = meta || {};
  _renderPV();
  document.getElementById('photoViewer').classList.add('open');
}
function closePhotoViewer() {
  document.getElementById('photoViewer').classList.remove('open');
  document.getElementById('pvImg').src = '';
}
function _renderPV(dir) {
  const single = _pvUrls.length <= 1;
  const img = document.getElementById('pvImg');
  img.classList.remove('pv-enter-right', 'pv-enter-left');
  if (dir) {
    void img.offsetWidth;
    img.classList.add(dir === 1 ? 'pv-enter-right' : 'pv-enter-left');
  }
  img.src = _pvUrls[_pvIdx];
  document.getElementById('pvCounter').textContent       = `${_pvIdx + 1} / ${_pvUrls.length}`;
  document.getElementById('pvCounter').style.visibility  = single ? 'hidden' : '';
  document.getElementById('pvPrev').style.display        = single ? 'none' : '';
  document.getElementById('pvNext').style.display        = single ? 'none' : '';
  const dateEl   = document.getElementById('pvFooterDate');
  const authorEl = document.getElementById('pvFooterAuthor');
  // source 優先（用於 Places API 等需 attribution 的場合）
  if (_pvMeta.source) {
    dateEl.textContent   = '';
    authorEl.textContent = _pvMeta.source;
    return;
  }
  dateEl.textContent   = _pvMeta.date ? `拍攝日期 ${_pvMeta.date}` : '';
  authorEl.textContent = _pvMeta.authorName ? `by ${_pvMeta.authorName}` : '';
  if (_pvMeta.uid) {
    getUserDisplay(_pvMeta.uid).then(u => {
      authorEl.textContent = `by ${u.name}`;
    });
  }
}
function _pvGo(delta) {
  _pvIdx = (_pvIdx + delta + _pvUrls.length) % _pvUrls.length;
  _renderPV(delta);
}

document.getElementById('pvClose').addEventListener('click', closePhotoViewer);
document.getElementById('pvPrev').addEventListener('click', () => _pvGo(-1));
document.getElementById('pvNext').addEventListener('click', () => _pvGo(1));

let _pvTouchX = 0;
document.getElementById('photoViewer').addEventListener('touchstart', e => {
  _pvTouchX = e.touches[0].clientX;
}, { passive: true });
document.getElementById('photoViewer').addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - _pvTouchX;
  if (Math.abs(dx) > 40) _pvGo(dx < 0 ? 1 : -1);
}, { passive: true });

document.addEventListener('keydown', e => {
  if (!document.getElementById('photoViewer').classList.contains('open')) return;
  if      (e.key === 'ArrowLeft')  _pvGo(-1);
  else if (e.key === 'ArrowRight') _pvGo(1);
  else if (e.key === 'Escape')     closePhotoViewer();
});
