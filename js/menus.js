// ── menus.js ─────────────────────────────────────────────────────────────────
// 菜單功能：店家卡片菜單 tab、菜單上傳 modal、pageReviews 內的菜單清單
// 依賴全域變數（finder.html 主 script 提供）：
//   db, auth, firebase, storage, currentUserRole
// 依賴全域函式：
//   canUse, canView（feature flag 檢查）、findShopById、escapeHtml
//   openPhotoViewer（photos.js）、showStampToast（stamps.js）
//   compressImage、isValidPhotoDate、updateDisplayNames（reviews.js）
// 提供全域變數：
//   menuCache, _mnuFeedLoaded（pageReviews tab 切換用）
// 提供全域函式：
//   loadShopMenu, openMenuModal, closeMenuModal, loadMenusFeedPage

// ── 1. 店家卡片內的菜單 tab ──────────────────────────────────────────────────
var menuCache = {}; // shopId → { docs: [], lastDoc, hasMore }

async function loadShopMenu(shop, panel, append = false) {
  const shopId = shop['ID'];
  if (!append) {
    panel.innerHTML = '';
    if (canUse('menuTab')) {
      const headerRow = document.createElement('div');
      headerRow.className = 'review-header-row';
      const uploadBtn = document.createElement('button');
      uploadBtn.className = 'mnu-upload-btn';
      uploadBtn.innerHTML = '📷 上傳菜單照片';
      uploadBtn.addEventListener('click', () => openMenuModal(shopId, shop['店名'] || ''));
      headerRow.appendChild(uploadBtn);
      panel.appendChild(headerRow);
    }
  }

  const loading = document.createElement('p');
  loading.className = 'tab-placeholder';
  loading.style.padding = '10px 0';
  loading.textContent = '載入中…';
  panel.appendChild(loading);

  try {
    const cache = menuCache[shopId] || { lastDoc: null };
    let q = db.collection('menus')
      .where('shopId', '==', shopId)
      .orderBy('photoDate', 'desc')
      .limit(3);
    if (append && cache.lastDoc) q = q.startAfter(cache.lastDoc);

    const snap = await q.get();
    loading.remove();
    const docs = snap.docs;
    const hasMore = docs.length >= 3;
    menuCache[shopId] = { lastDoc: docs.length ? docs[docs.length - 1] : cache.lastDoc, hasMore };

    if (!docs.length && !append) {
      panel.insertAdjacentHTML('beforeend', '<p class="tab-placeholder" style="padding:8px 0">目前還沒有人上傳菜單，成為第一個吧！</p>');
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'mnu-grid';
    const allMnuUrls = docs.map(doc => {
      const d = doc.data();
      return d.photo?.original || d.photo?.thumb || '';
    });
    docs.forEach((doc, idx) => {
      const d = doc.data();
      const thumb = document.createElement('div');
      thumb.className = 'mnu-thumb';
      thumb.innerHTML = `<img src="${d.photo?.thumb || d.photo?.original}" alt="菜單" loading="lazy">
        ${d.photoDate ? `<span class="mnu-date-badge">${d.photoDate}</span>` : ''}`;
      thumb.addEventListener('click', () =>
        openPhotoViewer(allMnuUrls, idx, { date: d.photoDate || '', uid: d.uid || '', authorName: d.displayName || '匿名' })
      );
      const canDel = auth.currentUser && (auth.currentUser.uid === d.uid || currentUserRole === 'admin');
      if (canDel) {
        const delBtn = document.createElement('button');
        delBtn.className = 'mnu-del-btn';
        delBtn.title = '刪除';
        delBtn.textContent = '✕';
        delBtn.addEventListener('click', async e => {
          e.stopPropagation();
          if (!confirm('確定刪除這張菜單照片？')) return;
          delBtn.disabled = true;
          try {
            await db.collection('menus').doc(doc.id).delete();
            delete menuCache[shopId];
            thumb.remove();
            showStampToast('✅ 已刪除菜單照片');
          } catch(err) {
            showStampToast('❌ 刪除失敗');
            delBtn.disabled = false;
          }
        });
        thumb.appendChild(delBtn);
      }
      grid.appendChild(thumb);
    });
    panel.appendChild(grid);

    if (hasMore) {
      const moreBtn = document.createElement('button');
      moreBtn.className = 'mnu-load-more';
      moreBtn.textContent = '顯示更多…';
      moreBtn.addEventListener('click', () => { moreBtn.remove(); loadShopMenu(shop, panel, true); });
      panel.appendChild(moreBtn);
    }
  } catch(e) {
    loading.remove();
    panel.insertAdjacentHTML('beforeend', '<p class="tab-placeholder" style="padding:8px 0">目前還沒有人上傳菜單，成為第一個吧！</p>');
  }
}

// ── 2. 菜單上傳 Modal ────────────────────────────────────────────────────────
let _mnuShopId = '', _mnuShopName = '', _mnuFile = null;

function openMenuModal(shopId, shopName) {
  _mnuShopId = shopId; _mnuShopName = shopName;
  _mnuFile = null;
  document.getElementById('mnuTitle').textContent = `📷 上傳菜單 — ${shopName}`;
  document.getElementById('mnuPhotoDate').value = '';
  document.getElementById('mnuPhotoDate').max = new Date().toISOString().split('T')[0];
  document.getElementById('mnuProgress').textContent = '';
  document.getElementById('mnuSubmitBtn').disabled = true;
  document.getElementById('mnuPreviewGrid').innerHTML = '';
  // 重置上傳區
  const area = document.getElementById('mnuUploadArea');
  area.innerHTML = `<input type="file" id="mnuFileInput" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/gif">📷 點擊上傳照片`;
  area.querySelector('#mnuFileInput').addEventListener('change', onMnuFileChange);
  document.getElementById('mnuBackdrop').classList.add('open');
  document.getElementById('mnuModal').classList.add('open');
}

function onMnuFileChange(e) {
  const file = e.target.files[0];
  if (!file) return;
  _mnuFile = file;
  const preview = document.getElementById('mnuPreviewGrid');
  const url = URL.createObjectURL(file);
  preview.innerHTML = `
    <div class="rv-preview-item">
      <img src="${url}" alt="">
      <button class="rv-preview-remove" id="mnuPreviewRemove">✕</button>
    </div>`;
  preview.querySelector('#mnuPreviewRemove').addEventListener('click', () => {
    _mnuFile = null;
    preview.innerHTML = '';
    // 重置 input 讓使用者可再次選擇
    const area = document.getElementById('mnuUploadArea');
    area.innerHTML = `<input type="file" id="mnuFileInput" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/gif">📷 點擊上傳照片`;
    area.querySelector('#mnuFileInput').addEventListener('change', onMnuFileChange);
    checkMnuReady();
  });
  checkMnuReady();
}

function checkMnuReady() {
  const hasDate  = isValidPhotoDate(document.getElementById('mnuPhotoDate')?.value);
  const hasPhoto = !!_mnuFile;
  document.getElementById('mnuSubmitBtn').disabled = !(hasDate && hasPhoto);
}

function closeMenuModal() {
  document.getElementById('mnuBackdrop').classList.remove('open');
  document.getElementById('mnuModal').classList.remove('open');
}

document.getElementById('mnuPhotoDate').addEventListener('input', checkMnuReady);
document.getElementById('mnuUploadArea').addEventListener('click', () =>
  document.getElementById('mnuFileInput')?.click()
);
document.getElementById('mnuCancelBtn').addEventListener('click', closeMenuModal);
document.getElementById('mnuClose').addEventListener('click', closeMenuModal);
document.getElementById('mnuBackdrop').addEventListener('click', e => {
  if (e.target === document.getElementById('mnuBackdrop')) closeMenuModal();
});

document.getElementById('mnuSubmitBtn').addEventListener('click', async () => {
  if (!_mnuFile || !_mnuShopId || !auth.currentUser) return;
  const photoDate = document.getElementById('mnuPhotoDate').value;
  if (!isValidPhotoDate(photoDate)) {
    document.getElementById('mnuProgress').textContent = '❌ 日期格式錯誤或不可為未來日期';
    return;
  }

  const btn      = document.getElementById('mnuSubmitBtn');
  const progress = document.getElementById('mnuProgress');
  btn.disabled = true;
  progress.textContent = '壓縮中…';

  try {
    const user       = auth.currentUser;
    const compressed = await compressImage(_mnuFile, { maxPx: 1200, maxKB: 280 });
    progress.textContent = '上傳中…';
    const docRef  = db.collection('menus').doc();
    const path    = `menus/${_mnuShopId}/${docRef.id}.webp`;
    const ref     = storage.ref(path);
    await ref.put(compressed, { contentType: compressed.type });
    const url = await ref.getDownloadURL();

    await docRef.set({
      shopId:      _mnuShopId,
      shopName:    _mnuShopName,
      uid:         user.uid,
      displayName: user.displayName || '匿名',
      photoDate,
      photo:       { thumb: url, original: url },
      createdAt:   firebase.firestore.FieldValue.serverTimestamp(),
    });

    delete menuCache[_mnuShopId];
    showStampToast('✅ 菜單照片已上傳');
    if (typeof gtag !== 'undefined') gtag('event', 'menu_upload', { shop_id: _mnuShopId, shop_name: _mnuShopName });
    closeMenuModal();

    // 重新載入該 shop 的菜單 panel（同 review 做法）
    const menuPanel = document.querySelector(`.card[data-shop-id="${_mnuShopId}"] [data-tab-panel="menu"] .menu-tab-inner`);
    if (menuPanel) {
      const shop = findShopById(_mnuShopId);
      if (shop) loadShopMenu(shop, menuPanel);
    }
  } catch(e) {
    progress.textContent = '❌ 上傳失敗：' + e.message;
    btn.disabled = false;
  }
});

// ── 3. pageReviews 內的菜單清單 ──────────────────────────────────────────────
const MNU_PAGE_SIZE = 10;
var _mnuFeedLoaded   = false;
let _mnuFeedPage     = 1;
let _mnuFeedMaxPage  = 1;
let _mnuFeedCursors  = [null];

async function loadMenusFeedPage(page = 1) {
  _mnuFeedPage = page;
  const list = document.getElementById('rfMenuList');
  list.innerHTML = '<div class="rf-empty">載入中…</div>';
  try {
    let q = db.collection('menus').orderBy('createdAt', 'desc').limit(MNU_PAGE_SIZE);
    const cursor = _mnuFeedCursors[page - 1];
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    const docs = snap.docs;
    if (docs.length >= MNU_PAGE_SIZE) {
      if (!_mnuFeedCursors[page]) _mnuFeedCursors[page] = docs[docs.length - 1];
      _mnuFeedMaxPage = Math.max(_mnuFeedMaxPage, page + 1);
    } else {
      _mnuFeedMaxPage = page;
    }
    list.innerHTML = '';
    if (!docs.length) {
      list.innerHTML = '<div class="rf-empty">目前還沒有菜單照片</div>';
      renderMnuPagination();
      _mnuFeedLoaded = true;
      return;
    }
    docs.forEach(doc => {
      const d = doc.data();
      const ts = d.createdAt?.toDate?.();
      const dateStr = ts ? ts.toLocaleDateString('zh-TW', { month: 'short', day: 'numeric' }) : '';
      const card = document.createElement('div');
      card.className = 'mnu-card';
      card.dataset.docid = doc.id;
      card.innerHTML = `
        <img class="mnu-photo" src="${d.photo?.thumb || d.photo?.original || ''}" data-original="${d.photo?.original || ''}" alt="" loading="lazy">
        <div class="mnu-info">
          <span class="mnu-shop">📍 ${escapeHtml(d.shopName || '')}</span>
          <span class="mnu-date">${escapeHtml(d.photoDate || dateStr)}</span>
          <span class="mnu-user" data-uid="${d.uid || ''}">${escapeHtml(d.displayName || '匿名')}</span>
        </div>`;
      card.querySelector('.mnu-photo').addEventListener('click', e => {
        const original = e.target.dataset.original || e.target.src;
        openPhotoViewer([original], 0, { date: d.photoDate || '', uid: d.uid || '', authorName: d.displayName || '匿名' });
      });
      list.appendChild(card);
    });
    updateDisplayNames(list);
    renderMnuPagination();
    _mnuFeedLoaded = true;
  } catch (e) {
    console.error('loadMenusFeedPage 失敗', e);
    list.innerHTML = `<div class="rf-empty">載入失敗：${e.message}</div>`;
  }
}

function renderMnuPagination() {
  const el = document.getElementById('rfMenuPagination');
  if (!el) return;
  const pages = Array.from({ length: _mnuFeedMaxPage }, (_, i) => i + 1);
  el.innerHTML =
    `<button class="rf-page-btn rf-page-prev" ${_mnuFeedPage <= 1 ? 'disabled' : ''}>◄</button>` +
    pages.map(p => `<button class="rf-page-btn${p === _mnuFeedPage ? ' active' : ''}" data-page="${p}">${p}</button>`).join('') +
    `<button class="rf-page-btn rf-page-next" ${_mnuFeedPage >= _mnuFeedMaxPage ? 'disabled' : ''}>►</button>`;
  el.querySelector('.rf-page-prev').addEventListener('click', () => {
    if (_mnuFeedPage > 1) loadMenusFeedPage(_mnuFeedPage - 1);
  });
  el.querySelector('.rf-page-next').addEventListener('click', () => {
    if (_mnuFeedPage < _mnuFeedMaxPage) loadMenusFeedPage(_mnuFeedPage + 1);
  });
  el.querySelectorAll('.rf-page-btn[data-page]').forEach(btn =>
    btn.addEventListener('click', () => loadMenusFeedPage(+btn.dataset.page))
  );
}
