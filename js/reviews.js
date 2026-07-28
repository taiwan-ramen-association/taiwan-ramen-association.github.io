// ── reviews.js ────────────────────────────────────────────────────────────────
// 評論、照片瀏覽、Feed 模組
// 依賴全域變數（main script 提供）：
//   db, auth, storage, firebase
//   currentUserRole, currentDisplayName, currentAvatarUrl, userAvatar
//   stampMap, reviewMap, showFavOnly, isWarned
// 依賴全域函式：
//   escapeHtml, showStampToast, canView, canUse, showAccessToast
//   render, getShopById, openSfModal, lockScroll, unlockScroll

// ── URL 白名單（XSS 第二層防護）──────────────────────────────────────────────
// escapeHtml 擋屬性逃逸；safeUrl 再限制 URL 只能指向已知圖片來源，
// 防止惡意 avatarUrl / 照片 URL 指向外部網址（追蹤像素洩漏瀏覽者 IP 等）。
// 不在白名單 → 回空字串（avatar 會 fallback 成 👤 placeholder）。
function safeUrl(u) {
  try {
    const url = new URL(String(u || ''));
    if (url.protocol !== 'https:') return '';
    const h = url.hostname;
    const ok = h === 'firebasestorage.googleapis.com'
            || h.endsWith('.googleusercontent.com')
            || h.endsWith('.ggpht.com');
    return ok ? u : '';
  } catch { return ''; }
}

// ── Reviews System ────────────────────────────────────────────────────────────

const REVIEW_MAX_PHOTOS = 5;
const REVIEW_PAGE_SIZE  = 5;
let _rvShopId   = null;
let _rvShopName = '';
let _rvRating   = 0;
let _rvFiles    = [];       // { file, previewUrl }
let _rvCursors  = {};       // shopId → lastDoc for pagination

// ── 圖片壓縮（Canvas，不需外部套件）──────────────────────────────────────────
function compressImage(file, { maxPx = 1200, maxKB = 400 } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxPx || height > maxPx) {
        const scale = Math.min(maxPx / width, maxPx / height);
        width  = Math.round(width  * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);

      // 先嘗試 WebP；iOS 不支援時 canvas.toBlob 會 fallback 成 PNG（blob.type === 'image/png'），
      // 此時改用 JPEG（有 quality 參數，所有平台皆支援）
      const tryFormat = (format) => {
        let q = 0.82;
        const tryBlob = () => {
          canvas.toBlob(blob => {
            if (!blob) { reject(new Error('compress failed')); return; }
            if (format === 'image/webp' && blob.type === 'image/png') { tryFormat('image/jpeg'); return; }
            if (blob.size > maxKB * 1024 && q > 0.28) { q = Math.max(0.28, q - 0.15); tryBlob(); return; }
            resolve(new File([blob], file.name.replace(/\.\w+$/, format === 'image/jpeg' ? '.jpg' : '.webp'), { type: blob.type }));
          }, format, q);
        };
        tryBlob();
      };
      tryFormat('image/webp');
    };
    img.onerror = reject;
    img.src = url;
  });
}
// thumb 從縮圖 canvas 生成，orig 較寬鬆以減少迭代
const makeThumb    = f => compressImage(f, { maxPx: 400,  maxKB: 60  });
const makeOriginal = f => compressImage(f, { maxPx: 1200, maxKB: 400 });

// ── Storage 上傳單張（只存一份壓縮檔，thumb 與 original 共用同一 URL）────────
async function uploadReviewPhoto(file, shopId, reviewId, idx, onUploadStart) {
  const t0 = performance.now();
  const compressed = await compressImage(file, { maxPx: 900, maxKB: 250 });
  const t1 = performance.now();
  console.log(`[photo ${idx}] 壓縮: ${(t1-t0).toFixed(0)}ms | ${(compressed.size/1024).toFixed(0)}KB`);

  onUploadStart?.();
  const path = `reviews/${shopId}/${reviewId}/photo_${idx}.webp`;
  const snap = await storage.ref(path).put(compressed, { contentType: compressed.type });
  const t2 = performance.now();
  console.log(`[photo ${idx}] 上傳: ${(t2-t1).toFixed(0)}ms`);

  const url = await snap.ref.getDownloadURL();
  return { original: url, thumb: url };
}

// ── 刪除 Storage 裡的照片 ────────────────────────────────────────────────────
async function deleteReviewPhotos(shopId, reviewId, photos) {
  const tasks = [];
  (photos || []).forEach((_, i) => {
    const base = `reviews/${shopId}/${reviewId}/photo_${i}`;
    tasks.push(storage.ref(`${base}_orig.webp`).delete().catch(() => {}));
    tasks.push(storage.ref(`${base}_thumb.webp`).delete().catch(() => {}));
  });
  await Promise.all(tasks);
}

// ── 載入評論 ─────────────────────────────────────────────────────────────────
async function loadReviews(shopId, panel, append = false) {
  if (!append) {
    _rvCursors[shopId] = null;
    panel.innerHTML = '<div class="review-loading">載入中…</div>';
  }
  try {
    let q = db.collection('reviews')
      .where('shopId', '==', shopId)
      .orderBy('createdAt', 'desc')
      .limit(REVIEW_PAGE_SIZE);
    if (_rvCursors[shopId]) q = q.startAfter(_rvCursors[shopId]);

    const snap = await q.get();
    const docs = snap.docs;
    if (docs.length) _rvCursors[shopId] = docs[docs.length - 1];

    const uid = auth.currentUser?.uid;
    const isAdmin = currentUserRole === 'admin';

    if (!append) panel.innerHTML = '';

    // 重繪 header（count + 寫評論 btn）
    if (!append) {
      const totalSnap = await db.collection('reviews').where('shopId', '==', shopId).get();
      const total = totalSnap.size;
      const headerRow = document.createElement('div');
      headerRow.className = 'review-header-row';
      const canWrite = canView('reviews') && canUse('reviews') && auth.currentUser;
      headerRow.innerHTML = `
        ${canView('reviews') ? `<button class="write-review-btn${canWrite ? '' : ' locked'}"
          id="writeReviewBtn_${shopId}"
          ${canWrite ? '' : 'disabled title="需登入才能評論"'}>
          ✍ 寫評論
        </button>` : ''}
        <span class="review-count-label">共 ${total} 則評論</span>`;
      panel.insertBefore(headerRow, panel.firstChild);
      if (canWrite) {
        headerRow.querySelector(`#writeReviewBtn_${shopId}`)
          .addEventListener('click', () => openReviewModal(shopId, getShopById(shopId)?.['店名'] || ''));
      }
    }

    if (!docs.length && !append) {
      panel.insertAdjacentHTML('beforeend', '<div class="review-empty">目前還沒有評論，成為第一個吧！</div>');
      return;
    }

    const list = document.createElement('div');
    list.className = 'review-list';
    docs.forEach(doc => {
      const d  = doc.data();
      const ts = d.createdAt?.toDate?.();
      const dateStr = ts ? ts.toLocaleDateString('zh-TW', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
      const stars = '★'.repeat(d.rating || 0) + '☆'.repeat(5 - (d.rating || 0));
      const canDel = uid === d.uid || isAdmin;
      const photosHtml = (d.photos || []).map(p =>
        `<img class="review-photo-thumb" src="${escapeHtml(safeUrl(p.thumb))}" data-original="${escapeHtml(safeUrl(p.original))}" alt="">`
      ).join('');
      const avatarUrl = safeUrl(d.avatarUrl);
      const item = document.createElement('div');
      item.className = 'review-item';
      item.innerHTML = `
        <div class="review-item-header">
          ${avatarUrl
            ? `<img class="review-avatar" src="${escapeHtml(avatarUrl)}" data-uid="${d.uid}" alt="">`
            : `<div class="review-avatar-placeholder" data-uid="${d.uid}">👤</div>`}
          <div class="review-meta">
            <div class="review-name" data-uid="${d.uid}">${escapeHtml(d.displayName || '匿名')}</div>
            <div class="review-date">${dateStr}</div>
          </div>
          <div>
            <span class="review-stars">${stars}</span>
            ${canDel ? `<button class="review-del-btn" data-docid="${doc.id}" data-shopid="${shopId}">🗑 刪除</button>` : ''}
          </div>
        </div>
        ${d.text ? `<div class="review-text">${escapeHtml(d.text)}</div>` : ''}
        ${d.photos?.length ? `<div class="review-photos" data-photo-date="${escapeHtml(d.photoDate || '')}">${photosHtml}</div>` : ''}`;

      // 留言區
      const commentsEl = document.createElement('div');
      commentsEl.className = 'review-comments';
      item.appendChild(commentsEl);
      loadComments(doc.id, commentsEl);

      // 留言表單（登入才顯示）
      if (auth.currentUser) {
        const formEl = document.createElement('div');
        formEl.className = 'review-comment-form';
        formEl.innerHTML = `<input class="review-comment-input" placeholder="留言…" maxlength="100">
          <button class="review-comment-send">送出</button>`;
        item.appendChild(formEl);
        const cinput = formEl.querySelector('.review-comment-input');
        const csend  = formEl.querySelector('.review-comment-send');
        csend.addEventListener('click', async () => {
          const text = cinput.value.trim();
          if (!text) return;
          csend.disabled = true;
          try {
            const u = auth.currentUser;
            await db.collection('reviews').doc(doc.id).collection('comments').add({
              uid: u.uid,
              displayName: currentDisplayName || u.displayName || '匿名',
              avatarUrl: currentAvatarUrl || u.photoURL || null,
              text,
              createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            });
            cinput.value = '';
            loadComments(doc.id, commentsEl);
          } catch { showStampToast('留言失敗，請稍後再試'); }
          csend.disabled = false;
        });
      }

      list.appendChild(item);
    });
    panel.appendChild(list);

    // 刪除按鈕
    list.querySelectorAll('.review-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('確定刪除這則評論？')) return;
        btn.disabled = true;
        try {
          const docId = btn.dataset.docid;
          await db.collection('reviews').doc(docId).delete();
          await db.collection('meta').doc('reviewDeleteRecords').set({ [docId]: btn.dataset.shopid || '' }, { merge: true }).catch(() => {});
          btn.closest('.review-item').remove();
          showStampToast('✅ 已刪除評論');
        } catch(e) { showStampToast('❌ 刪除失敗'); btn.disabled = false; }
      });
    });

    // 照片瀏覽
    list.querySelectorAll('.review-photos').forEach(row => {
      const thumbs    = [...row.querySelectorAll('.review-photo-thumb')];
      const urls      = thumbs.map(i => i.dataset.original);
      const item      = row.closest('.review-item');
      const uid       = item?.querySelector('.review-name')?.dataset.uid || '';
      const photoDate = row.dataset.photoDate || '';
      const name      = item?.querySelector('.review-name')?.textContent  || '';
      thumbs.forEach((img, idx) => {
        img.addEventListener('click', () => openPhotoViewer(urls, idx, { date: photoDate, uid, authorName: name }));
      });
    });
    updateDisplayNames(list);

    // 載入更多
    const existing = panel.querySelector('.review-load-more');
    if (existing) existing.remove();
    if (docs.length === REVIEW_PAGE_SIZE) {
      const more = document.createElement('button');
      more.className = 'review-load-more';
      more.textContent = '載入更多評論…';
      more.addEventListener('click', () => loadReviews(shopId, panel, true));
      panel.appendChild(more);
    }
  } catch(e) {
    panel.innerHTML = `<div class="review-empty">載入失敗：${e.message}</div>`;
  }
}

// ── 留言（review 子集合）──────────────────────────────────────────────────────
async function loadComments(reviewId, container, showAll = false) {
  try {
    const snap = await db.collection('reviews').doc(reviewId).collection('comments')
      .orderBy('createdAt', 'asc').limit(showAll ? 100 : 3).get();
    if (!snap.docs.length) { container.innerHTML = ''; return; }
    container.innerHTML = snap.docs.map(d => {
      const c = d.data();
      return `<div class="review-comment"><span class="review-comment-name" data-uid="${c.uid || ''}">${escapeHtml(c.displayName || '匿名')}</span>：${escapeHtml(c.text)}</div>`;
    }).join('');
    if (!showAll && snap.docs.length >= 3) {
      const btn = document.createElement('button');
      btn.className = 'review-comments-more';
      btn.textContent = '顯示更多留言…';
      btn.addEventListener('click', () => { btn.remove(); loadComments(reviewId, container, true); });
      container.appendChild(btn);
    }
  } catch {}
}

// ── User display cache（UID → { name, avatarUrl }）────────────────────────────
const _userDisplayCache = new Map();
async function getUserDisplay(uid) {
  if (_userDisplayCache.has(uid)) return _userDisplayCache.get(uid);
  try {
    const snap = await db.collection('userProfiles').doc(uid).get();
    const d    = snap.data() || {};
    const result = {
      name:      d.nickname || d.displayName || '匿名',
      avatarUrl: d.avatarUrl || d.photoURL   || '',
    };
    _userDisplayCache.set(uid, result);
    return result;
  } catch {
    const fallback = { name: '匿名', avatarUrl: '' };
    _userDisplayCache.set(uid, fallback);
    return fallback;
  }
}

// 渲染後非同步更新容器內所有 [data-uid] 名稱元素
async function updateDisplayNames(container) {
  const els  = [...container.querySelectorAll('[data-uid]')];
  if (!els.length) return;
  const uids = [...new Set(els.map(e => e.dataset.uid))];
  await Promise.all(uids.map(uid => getUserDisplay(uid)));
  els.forEach(el => {
    const u = _userDisplayCache.get(el.dataset.uid);
    if (u) el.textContent = u.name;
  });
}

// ── Photo Viewer ──────────────────────────────────────────────────────────────

// ── Review Modal ──────────────────────────────────────────────────────────────
function openReviewModal(shopId, shopName) {
  if (!auth.currentUser)  { showStampToast('請先登入以使用此功能'); return; }
  if (!canUse('reviews')) { showStampToast('此功能目前暫不開放'); return; }
  _rvShopId   = shopId;
  _rvShopName = shopName;
  _rvRating   = 0;
  _rvFiles    = [];
  document.getElementById('rvTitle').textContent = `✍ 寫評論 — ${shopName}`;
  document.getElementById('rvText').value = '';
  document.getElementById('rvPhotoDate').value = '';
  document.getElementById('rvPhotoDate').max = new Date().toISOString().split('T')[0];
  document.getElementById('rvPreviewGrid').innerHTML = '';
  document.getElementById('rvProgress').textContent = '';
  document.getElementById('rvSubmitBtn').disabled = true;
  updateRvStars(0);
  document.getElementById('rvBackdrop').classList.add('open');
  document.getElementById('rvModal').classList.add('open');
  lockScroll();
}
function closeReviewModal() {
  document.getElementById('rvBackdrop').classList.remove('open');
  document.getElementById('rvModal').classList.remove('open');
  unlockScroll();
  _rvFiles.forEach(f => URL.revokeObjectURL(f.previewUrl));
  _rvFiles = [];
}
document.getElementById('rvClose').addEventListener('click',    closeReviewModal);
document.getElementById('rvCancelBtn').addEventListener('click', closeReviewModal);
document.getElementById('rvBackdrop').addEventListener('click',  closeReviewModal);

// 星評
function updateRvStars(val) {
  _rvRating = val;
  document.querySelectorAll('.star-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.v) <= val);
  });
  checkRvSubmitReady();
}
document.querySelectorAll('.star-btn').forEach(b => {
  b.addEventListener('click', () => updateRvStars(parseInt(b.dataset.v)));
  b.addEventListener('mouseover', () => {
    document.querySelectorAll('.star-btn').forEach(s =>
      s.classList.toggle('active', parseInt(s.dataset.v) <= parseInt(b.dataset.v)));
  });
  b.addEventListener('mouseout', () => updateRvStars(_rvRating));
});

function isValidPhotoDate(val) {
  if (!val || !/^\d{4}-\d{2}-\d{2}$/.test(val)) return false;
  const d = new Date(val + 'T00:00:00');
  if (isNaN(d.getTime())) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return d <= today;
}

function checkRvSubmitReady() {
  const hasContent = _rvRating > 0 || document.getElementById('rvText').value.trim().length > 0;
  const hasDate    = isValidPhotoDate(document.getElementById('rvPhotoDate').value);
  document.getElementById('rvSubmitBtn').disabled = !(hasContent && hasDate);
}
document.getElementById('rvText').addEventListener('input', checkRvSubmitReady);
document.getElementById('rvPhotoDate').addEventListener('change', checkRvSubmitReady);

// 圖片上傳區域
function addRvFiles(newFiles) {
  const remaining = REVIEW_MAX_PHOTOS - _rvFiles.length;
  if (remaining <= 0) { showStampToast(`最多只能上傳 ${REVIEW_MAX_PHOTOS} 張`); return; }
  Array.from(newFiles).slice(0, remaining).forEach(f => {
    if (!f.type.startsWith('image/')) return;
    const previewUrl = URL.createObjectURL(f);
    _rvFiles.push({ file: f, previewUrl });
    const item = document.createElement('div');
    item.className = 'rv-preview-item';
    item.innerHTML = `<img src="${previewUrl}" alt=""><button class="rv-preview-remove">✕</button>`;
    item.querySelector('.rv-preview-remove').addEventListener('click', () => {
      URL.revokeObjectURL(previewUrl);
      _rvFiles = _rvFiles.filter(x => x.previewUrl !== previewUrl);
      item.remove();
    });
    document.getElementById('rvPreviewGrid').appendChild(item);
  });
}
document.getElementById('rvUploadArea').addEventListener('click', () =>
  document.getElementById('rvFileInput').click());
document.getElementById('rvFileInput').addEventListener('change', e => {
  addRvFiles(e.target.files); e.target.value = '';
});
const rvUploadArea = document.getElementById('rvUploadArea');
rvUploadArea.addEventListener('dragover', e => { e.preventDefault(); rvUploadArea.classList.add('drag-over'); });
rvUploadArea.addEventListener('dragleave', () => rvUploadArea.classList.remove('drag-over'));
rvUploadArea.addEventListener('drop', e => {
  e.preventDefault(); rvUploadArea.classList.remove('drag-over');
  addRvFiles(e.dataTransfer.files);
});

// 送出評論
document.getElementById('rvSubmitBtn').addEventListener('click', async () => {
  if (!_rvShopId || !auth.currentUser) return;
  const text = document.getElementById('rvText').value.trim();
  if (!_rvRating && !text && !_rvFiles.length) return;
  const rvPhotoDate = document.getElementById('rvPhotoDate').value;
  if (!isValidPhotoDate(rvPhotoDate)) {
    document.getElementById('rvProgress').textContent = '❌ 日期格式錯誤或不可為未來日期';
    return;
  }

  const submitBtn = document.getElementById('rvSubmitBtn');
  const cancelBtn = document.getElementById('rvCancelBtn');
  const progress  = document.getElementById('rvProgress');
  submitBtn.disabled = true; cancelBtn.disabled = true;

  try {
    const reviewId = db.collection('reviews').doc().id;
    let photos = [];

    if (_rvFiles.length) {
      for (let i = 0; i < _rvFiles.length; i++) {
        progress.textContent = `壓縮照片 ${i + 1} / ${_rvFiles.length}…`;
        const p = await uploadReviewPhoto(_rvFiles[i].file, _rvShopId, reviewId, i,
          () => { progress.textContent = `上傳照片 ${i + 1} / ${_rvFiles.length}…`; });
        photos.push(p);
      }
    }

    progress.textContent = '送出評論…';
    const u = auth.currentUser;
    // 頭像：直接用目前顯示的頭像 URL（已是 Storage URL 或 DiceBear 或 Google）
    await db.collection('reviews').doc(reviewId).set({
      shopId:      _rvShopId,
      shopName:    _rvShopName,
      uid:         u.uid,
      displayName: u.displayName || '匿名',
      avatarUrl:   userAvatar.src || u.photoURL || '',
      rating:      _rvRating,
      text,
      photos,
      photoDate:   rvPhotoDate,
      createdAt:   firebase.firestore.FieldValue.serverTimestamp(),
    });

    showStampToast('✅ 評論已送出！');
    if (typeof gtag !== 'undefined') gtag('event', 'review_submit', { shop_id: _rvShopId, shop_name: _rvShopName, rating: _rvRating });
    closeReviewModal();

    // 重置評論（下次切換時重新載入）
    _rfLoaded      = false;
    _rfPageCursors = [null];
    _rfCurrentPage = 1;
    _rfMaxPage     = 1;

    // 重新載入該 shop 的評論 panel
    const panel = document.querySelector(`.card[data-shop-id="${_rvShopId}"] [data-tab-panel="reviews"]`);
    if (panel) loadReviews(_rvShopId, panel);
  } catch(e) {
    progress.textContent = '❌ 送出失敗：' + e.message;
    submitBtn.disabled = false;
  }
  cancelBtn.disabled = false;
});

// ── Scroll lock (modal 開啟時鎖定 mainContent 捲動，nav bar 不受影響) ─────────
function lockScroll()   { document.getElementById('mainContent').classList.add('scroll-locked'); }
function unlockScroll() { document.getElementById('mainContent').classList.remove('scroll-locked'); }

// ── Reviews Feed ──────────────────────────────────────────────────────────────
const RF_SEEN_KEY  = 'rvFeedSeen';
const RF_TOPTS_KEY = 'rvFeedTopTs'; // 已讀到的最新評論時間（毫秒），供 checkUnreadBadge 以 ≤1 筆讀取判斷紅點
const RF_PAGE_SIZE   = 10;
let _rfPageCursors   = [null]; // index 0 = 起點，[n] = 第 n+1 頁的 startAfter cursor
let _rfCurrentPage   = 1;
let _rfMaxPage       = 1;
let _rfLoaded        = false;
let _rfTab           = 'reviews'; // 'reviews' | 'menus'
var _currentPage     = 'finder';

function getFeedSeen() {
  try { return new Set(JSON.parse(localStorage.getItem(RF_SEEN_KEY) || '[]')); }
  catch { return new Set(); }
}
function addFeedSeen(ids) {
  const seen = getFeedSeen();
  ids.forEach(id => seen.add(id));
  let arr = [...seen];
  if (arr.length > 500) arr = arr.slice(arr.length - 500);
  localStorage.setItem(RF_SEEN_KEY, JSON.stringify(arr));
}
function updateUnreadBadge() {
  if (_currentPage === 'finder') return;
  const hasUnread = !!document.querySelector('#rfList .rf-card.unread');
  document.getElementById('bnavPosts').classList.toggle('has-badge', hasUnread);
}
function markFeedPageSeen() {
  const ids = [...document.querySelectorAll('#rfList .rf-card[data-docid]')]
    .map(el => el.dataset.docid);
  if (ids.length) {
    addFeedSeen(ids);
    ids.forEach(id => {
      const el = document.querySelector(`#rfList .rf-card[data-docid="${id}"]`);
      if (el) el.classList.remove('unread');
    });
  }
  document.getElementById('bnavPosts').classList.remove('has-badge');
}
async function checkUnreadBadge() {
  if (!auth.currentUser || _currentPage === 'finder') return;
  try {
    const lastTs = +localStorage.getItem(RF_TOPTS_KEY) || 0;
    const q = lastTs
      ? db.collection('reviews').where('createdAt', '>', firebase.firestore.Timestamp.fromMillis(lastTs)).limit(1)
      : db.collection('reviews').orderBy('createdAt', 'desc').limit(1);
    const snap = await q.get();
    document.getElementById('bnavPosts').classList.toggle('has-badge', !snap.empty);
  } catch {}
}

// opts.keepView=true → 背景重抓模式（Google 登入後用）：保留舊畫面（半透明＋擋點擊），
// 資料到齊才換上，不先清成「載入中…」造成畫面跳一次。
// 登入後必須重載這頁，因為留言 bar 是渲染當下依 auth.currentUser 決定塞不塞進 DOM 的。
async function loadReviewsFeedPage(page = 1, opts) {
  _rfCurrentPage = page;
  const list = document.getElementById('rfList');
  const keepView = !!(opts && opts.keepView) && !!list.querySelector('.rf-card');
  if (keepView) list.classList.add('is-refreshing');
  else          list.innerHTML = '<div class="rf-empty">載入中…</div>';

  try {
    let q = db.collection('reviews').orderBy('createdAt', 'desc').limit(RF_PAGE_SIZE);
    const cursor = _rfPageCursors[page - 1];
    if (cursor) q = q.startAfter(cursor);

    const snap = await q.get();
    const docs = snap.docs;

    // 記錄「已讀到的最新評論時間」高水位，供下次登入時 checkUnreadBadge 以 ≤1 筆讀取判斷紅點
    if (page === 1 && docs.length) {
      const topTs = docs[0].data().createdAt?.toMillis?.() || 0;
      if (topTs > (+localStorage.getItem(RF_TOPTS_KEY) || 0)) localStorage.setItem(RF_TOPTS_KEY, String(topTs));
    }

    // 記錄下一頁的起點 cursor
    if (docs.length >= RF_PAGE_SIZE) {
      if (!_rfPageCursors[page]) _rfPageCursors[page] = docs[docs.length - 1];
      _rfMaxPage = Math.max(_rfMaxPage, page + 1);
    } else {
      _rfMaxPage = page; // 這是最後一頁
    }

    list.classList.remove('is-refreshing');
    list.innerHTML = '';
    if (!docs.length) {
      list.innerHTML = '<div class="rf-empty">目前還沒有評論</div>';
      renderRfPagination();
      _rfLoaded = true;
      return;
    }

    const seen = getFeedSeen();
    docs.forEach(doc => {
      const d = doc.data();
      const isUnread = !seen.has(doc.id);
      const ts = d.createdAt?.toDate?.();
      const dateStr = ts
        ? ts.toLocaleDateString('zh-TW', { month: 'short', day: 'numeric' })
        : '';
      const stars = '★'.repeat(d.rating || 0) + '☆'.repeat(5 - (d.rating || 0));
      const photosHtml = (d.photos || []).slice(0, 5).map(p =>
        `<img class="rf-thumb" src="${escapeHtml(safeUrl(p.thumb))}" data-original="${escapeHtml(safeUrl(p.original))}" alt="" loading="lazy">`
      ).join('');

      const avatarUrl = safeUrl(d.avatarUrl);
      const card = document.createElement('div');
      card.className = 'rf-card' + (isUnread ? ' unread' : '');
      card.dataset.docid = doc.id;
      card.innerHTML = `
        <div class="rf-card-header">
          ${avatarUrl
            ? `<img class="rf-avatar" src="${escapeHtml(avatarUrl)}" data-uid="${d.uid}" alt="">`
            : `<div class="rf-avatar-ph" data-uid="${d.uid}">👤</div>`}
          <div class="rf-user-info">
            <span class="rf-username" data-uid="${d.uid}">${escapeHtml(d.displayName || '匿名')}</span>
            <span class="rf-shopname">📍 ${escapeHtml(d.shopName || '')}</span>
          </div>
          <div class="rf-right">
            <span class="rf-stars">${stars}</span>
            <span class="rf-date">${dateStr}</span>
          </div>
        </div>
        ${d.text ? `<div class="rf-text">${escapeHtml(d.text)}</div>` : ''}
        ${photosHtml ? `<div class="rf-photos" data-photo-date="${escapeHtml(d.photoDate || '')}">${photosHtml}</div>` : ''}
        <span class="rf-unread-dot"></span>`;

      const rfThumbs    = [...card.querySelectorAll('.rf-thumb')];
      const rfUrls      = rfThumbs.map(i => i.dataset.original);
      const rfUid       = d.uid || '';
      const rfPhotoDate = d.photoDate || '';
      const rfName      = d.displayName || '匿名';
      rfThumbs.forEach((img, idx) => {
        img.addEventListener('click', () => openPhotoViewer(rfUrls, idx, { date: rfPhotoDate, uid: rfUid, authorName: rfName }));
      });

      // 留言區
      const rfCommentsEl = document.createElement('div');
      rfCommentsEl.className = 'review-comments';
      card.appendChild(rfCommentsEl);
      loadComments(doc.id, rfCommentsEl);

      if (auth.currentUser) {
        const rfFormEl = document.createElement('div');
        rfFormEl.className = 'review-comment-form';
        rfFormEl.innerHTML = `<input class="review-comment-input" placeholder="留言…" maxlength="100">
          <button class="review-comment-send">送出</button>`;
        card.appendChild(rfFormEl);
        const rci = rfFormEl.querySelector('.review-comment-input');
        const rcs = rfFormEl.querySelector('.review-comment-send');
        rcs.addEventListener('click', async () => {
          const text = rci.value.trim();
          if (!text) return;
          rcs.disabled = true;
          try {
            const u = auth.currentUser;
            await db.collection('reviews').doc(doc.id).collection('comments').add({
              uid: u.uid,
              displayName: currentDisplayName || u.displayName || '匿名',
              avatarUrl: currentAvatarUrl || u.photoURL || null,
              text,
              createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            });
            rci.value = '';
            loadComments(doc.id, rfCommentsEl);
          } catch { showStampToast('留言失敗，請稍後再試'); }
          rcs.disabled = false;
        });
      }

      list.appendChild(card);
    });
    updateDisplayNames(list);
    renderRfPagination();
    _rfLoaded = true;
    updateUnreadBadge();
  } catch (e) {
    console.error('loadReviewsFeedPage 失敗', e);
    list.classList.remove('is-refreshing');
    // 背景重抓失敗時維持原畫面，不要把使用者正在看的列表換成紅字
    if (!keepView) list.innerHTML = `<div class="rf-empty">載入失敗：${e.message}</div>`;
  }
}

function renderRfPagination() {
  const el = document.getElementById('rfPagination');
  if (!el) return;
  const pages = Array.from({ length: _rfMaxPage }, (_, i) => i + 1);
  el.innerHTML =
    `<button class="rf-page-btn rf-page-prev" ${_rfCurrentPage <= 1 ? 'disabled' : ''}>◄</button>` +
    pages.map(p => `<button class="rf-page-btn${p === _rfCurrentPage ? ' active' : ''}" data-page="${p}">${p}</button>`).join('') +
    `<button class="rf-page-btn rf-page-next" ${_rfCurrentPage >= _rfMaxPage ? 'disabled' : ''}>►</button>`;
  el.querySelector('.rf-page-prev').addEventListener('click', () => {
    if (_rfCurrentPage > 1) loadReviewsFeedPage(_rfCurrentPage - 1);
  });
  el.querySelector('.rf-page-next').addEventListener('click', () => {
    if (_rfCurrentPage < _rfMaxPage) loadReviewsFeedPage(_rfCurrentPage + 1);
  });
  el.querySelectorAll('.rf-page-btn[data-page]').forEach(btn =>
    btn.addEventListener('click', () => loadReviewsFeedPage(+btn.dataset.page))
  );
}

document.getElementById('rfTabToggleBtn').addEventListener('click', () => {
  _rfTab = _rfTab === 'reviews' ? 'menus' : 'reviews';
  const isMenus = _rfTab === 'menus';
  document.getElementById('rfTabToggleBtn').textContent  = isMenus ? '📝 評論' : '🍜 菜單';
  document.getElementById('rfFeedTitle').textContent     = isMenus ? '🍜 菜單' : '📝 貼文';
  document.getElementById('rfList').style.display        = isMenus ? 'none' : '';
  document.getElementById('rfPagination').style.display  = isMenus ? 'none' : '';
  document.getElementById('rfToolbar').style.display     = isMenus ? 'none' : '';
  document.getElementById('rfMenuList').style.display        = isMenus ? '' : 'none';
  document.getElementById('rfMenuPagination').style.display  = isMenus ? '' : 'none';
  if (isMenus && !_mnuFeedLoaded) loadMenusFeedPage(1);
});

// ── Click to profile.html（avatars / nicknames / 留言名稱 都可點）─────────────
(function() {
  // 注入 cursor:pointer 樣式（不必動 HTML 的 <style>）
  const PROFILE_LINK_SEL = '.review-name[data-uid], .review-avatar[data-uid], .review-avatar-placeholder[data-uid], .rf-username[data-uid], .rf-avatar[data-uid], .rf-avatar-ph[data-uid], .review-comment-name[data-uid], .mnu-user[data-uid]';
  const style = document.createElement('style');
  style.textContent = `${PROFILE_LINK_SEL.split(',').map(s => s.trim() + ':not([data-uid=""])').join(',\n')} { cursor: pointer; transition: opacity 0.15s; }
${PROFILE_LINK_SEL.split(',').map(s => s.trim() + ':not([data-uid=""]):hover').join(',\n')} { opacity: 0.72; }`;
  document.head.appendChild(style);

  // 點擊跳轉
  document.body.addEventListener('click', e => {
    const t = e.target.closest(PROFILE_LINK_SEL);
    if (!t) return;
    const uid = t.dataset.uid;
    if (!uid) return;
    // 避免攔截評論刪除/留言送出等 button 點擊
    if (e.target.closest('button')) return;
    location.href = `profile.html?uid=${encodeURIComponent(uid)}`;
  });
})();
