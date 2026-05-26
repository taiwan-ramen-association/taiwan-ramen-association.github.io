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
const PHOTO_LS_PREFIX  = 'ramen_photo_';

// ── localStorage 快取輔助 ────────────────────────────────────────────────────
function lsGetPhoto(shopId) {
  try { const v = localStorage.getItem(PHOTO_LS_PREFIX + shopId); return v ? JSON.parse(v) : null; } catch { return null; }
}
function lsSetPhoto(shopId, data) {
  try { localStorage.setItem(PHOTO_LS_PREFIX + shopId, JSON.stringify(data)); } catch {}
}
function lsRemovePhoto(shopId) {
  try { localStorage.removeItem(PHOTO_LS_PREFIX + shopId); } catch {}
}

// ── 載入店家照片 ──────────────────────────────────────────────────────────────
// isRetry=true 時不再觸發二次重抓，避免無限循環
async function loadShopPhotos(shop, panel, isRetry = false) {
  const shopId = shop['ID'];

  if (!isRetry && typeof gtag !== 'undefined') {
    gtag('event', 'photo_view', { shop_id: shopId, shop_name: shop['店名'] || '' });
  }

  // 1. 記憶體快取
  if (photoCache[shopId] && photoCache[shopId] !== 'loading') {
    renderPhotoPanel(photoCache[shopId], panel, isRetry ? null : shop);
    return;
  }
  if (photoCache[shopId] === 'loading') return;

  // 2. localStorage 快取（跨重整、跨 App 存活）
  if (!isRetry) {
    const cached = lsGetPhoto(shopId);
    if (cached) {
      photoCache[shopId] = cached;
      renderPhotoPanel(cached, panel, shop); // 仍需驗證圖片是否有效
      return;
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
    const photos = json.places?.[0]?.photos?.slice(0, 3) ?? [];

    const urls = photos.map(p =>
      `https://places.googleapis.com/v1/${p.name}/media?maxWidthPx=800&key=${PLACES_KEY}`
    );
    const attribution = photos[0]?.authorAttributions?.[0]?.displayName ?? '';
    const data = { urls, attribution };
    photoCache[shopId] = data;
    lsSetPhoto(shopId, data);
    renderPhotoPanel(data, panel, isRetry ? null : shop);
  } catch(e) {
    photoCache[shopId] = null;
    panel.innerHTML = '<p class="tab-placeholder">照片載入失敗，請稍後再試</p>';
  }
}

// shop 傳入時才啟用「≤1 張成功 → 清快取重抓」邏輯
function renderPhotoPanel({ urls, attribution }, panel, shop = null) {
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
    if (loaded <= 1 && shop) {
      // 快取的 URL 已失效，清除後重新向 API 取得最新照片
      lsRemovePhoto(shop['ID']);
      delete photoCache[shop['ID']];
      loadShopPhotos(shop, panel, true); // isRetry=true，不再二次重抓
    }
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
