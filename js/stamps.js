// ── stamps.js ────────────────────────────────────────────────────────────────
// 踩點、收藏、Toast 通知
// 依賴全域變數（finder.html 主 script 提供）：
//   db, auth, firebase, isWarned, showFavOnly
// 依賴全域函式：
//   render, lockScroll, unlockScroll
// 提供全域變數：
//   stampMap, reviewMap, favSet
// 提供全域函式：
//   loadStamps, openStampModal, closeStampModal,
//   toggleFav, showStampToast, valToStatus, getStampVal

// ── Global state ─────────────────────────────────────────────────────────────
// Encoding: 0=沒去過, 0.2=路過, 1=吃過1次, 2-10=吃過N次, 20=從業過
var stampMap  = {};   // shopId → numeric score value
var reviewMap = {};   // shopId → string
var favSet    = new Set();  // 儲存 shop ID，由 Firestore 載入

// ── Constants ─────────────────────────────────────────────────────────────────
const STATUS_TO_VAL = { none: 0, pass: 0.2, once: 1, work: 20 };
const STATUS_LABELS = { none:'沒去過', pass:'路過', once:'吃過1次', work:'從業過' };
const COUNT_SUBS = ['','','好評常客！','熱愛此店！','忠實顧客！','拉麵信徒！','絕對常客！','高度上癮！','難以自拔！','快要從業了！','傳說中的常客！'];

// ── Private state ─────────────────────────────────────────────────────────────
let _stampShopId   = null;
let _stampShopName = '';
let _stampStatus   = 'once'; // 'none'|'pass'|'once'|'many'|'work'
let _stampCount    = 2;

// ── Helpers ───────────────────────────────────────────────────────────────────
function valToStatus(val) {
  if (val == null) return null;
  if (val === 0)             return 'none';
  if (val === 0.2)           return 'pass';
  if (val === 1)             return 'once';
  if (val >= 2 && val <= 10) return 'many';
  if (val === 20)            return 'work';
  return null;
}

function getStampVal() {
  return _stampStatus === 'many' ? _stampCount : (STATUS_TO_VAL[_stampStatus] ?? 1);
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showStampToast(msg) {
  const t = document.getElementById('stampToast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2200);
}

// ── Favorites ─────────────────────────────────────────────────────────────────
async function toggleFav(shopId) {
  const user = typeof auth !== 'undefined' && auth.currentUser;
  if (!user) { showStampToast('請先登入以使用此功能'); return; }
  if (isWarned) { showStampToast('您的帳號目前受到限制'); return; }
  if (!shopId) return;
  const ref = db.collection('users').doc(user.uid);
  if (favSet.has(shopId)) {
    favSet.delete(shopId);
    await ref.update({ favorites: firebase.firestore.FieldValue.arrayRemove(shopId) });
    if (typeof gtag !== 'undefined') gtag('event', 'fav_toggle', { shop_id: shopId, action: 'remove' });
  } else {
    favSet.add(shopId);
    await ref.update({ favorites: firebase.firestore.FieldValue.arrayUnion(shopId) });
    if (typeof gtag !== 'undefined') gtag('event', 'fav_toggle', { shop_id: shopId, action: 'add' });
  }
}

// ── Load stamps from Firestore ────────────────────────────────────────────────
async function loadStamps(uid) {
  const snap = await db.collection('userVisits').doc(uid).get();
  if (snap.exists) {
    stampMap  = snap.data().visits  || {};
    reviewMap = snap.data().reviews || {};
  } else {
    stampMap = {}; reviewMap = {};
  }
}

// ── Stamp Modal ───────────────────────────────────────────────────────────────
function openStampModal(shopId, shopName) {
  if (!auth.currentUser) { showStampToast('請先登入以使用此功能'); return; }
  if (isWarned) { showStampToast('您的帳號目前受到限制'); return; }
  _stampShopId   = shopId;
  _stampShopName = shopName;
  const stored = stampMap[shopId];
  _stampStatus = valToStatus(stored) || 'once';
  _stampCount  = (_stampStatus === 'many') ? stored : 2;
  document.getElementById('smTitle').textContent   = shopName;
  document.getElementById('smReview').value        = reviewMap[shopId] || '';
  document.getElementById('smReviewCount').textContent = (reviewMap[shopId] || '').length;
  updateSmOptions();
  updateSlider();
  document.getElementById('stampBackdrop').style.display = 'block';
  document.getElementById('stampModal').style.display   = 'block';
  lockScroll();
}

function closeStampModal() {
  document.getElementById('stampBackdrop').style.display = 'none';
  document.getElementById('stampModal').style.display   = 'none';
  unlockScroll();
}

function updateSmOptions() {
  document.querySelectorAll('.sm-option').forEach(el =>
    el.classList.toggle('selected', el.dataset.status === _stampStatus)
  );
}

function updateSlider() {
  const wrap = document.getElementById('smSliderWrap');
  wrap.classList.toggle('show', _stampStatus === 'many');
  if (_stampStatus === 'many') {
    document.getElementById('smCountSlider').value = _stampCount;
    updateSliderLabel(_stampCount);
  }
}

function updateSliderLabel(n) {
  document.getElementById('smCountLabel').textContent = n >= 10 ? '10+' : n;
  document.getElementById('smCountSub').textContent   = n >= 10 ? '傳說！你是這裡的傳說！' : (COUNT_SUBS[n] || '');
}

// ── Event Listeners ───────────────────────────────────────────────────────────
document.getElementById('stampBackdrop').addEventListener('click', closeStampModal);
document.getElementById('smCancelBtn').addEventListener('click', closeStampModal);

document.querySelectorAll('.sm-option').forEach(el => {
  el.addEventListener('click', () => {
    _stampStatus = el.dataset.status;
    if (_stampStatus === 'many' && _stampCount < 2) _stampCount = 2;
    updateSmOptions();
    updateSlider();
  });
});

document.getElementById('smCountSlider').addEventListener('input', e => {
  _stampCount = parseInt(e.target.value);
  updateSliderLabel(_stampCount);
});

document.getElementById('smReview').addEventListener('input', e => {
  document.getElementById('smReviewCount').textContent = e.target.value.length;
});

document.getElementById('smConfirmBtn').addEventListener('click', async () => {
  const shopId = _stampShopId;
  if (!shopId || !auth.currentUser) return;
  const val    = getStampVal();
  const review = document.getElementById('smReview').value.trim();
  stampMap[shopId] = val;
  if (review) reviewMap[shopId] = review; else delete reviewMap[shopId];
  try {
    const uid = auth.currentUser.uid;
    await db.collection('userVisits').doc(uid).set({ visits: { [shopId]: val } }, { merge: true });
    if (review) {
      await db.collection('userVisits').doc(uid).set({ reviews: { [shopId]: review } }, { merge: true });
    } else {
      await db.collection('userVisits').doc(uid).update({
        [`reviews.${shopId}`]: firebase.firestore.FieldValue.delete()
      }).catch(() => {});
    }
    document.querySelectorAll(`.stamp-btn[data-id="${shopId}"]`).forEach(b => b.classList.add('stamped'));
    // 同步更新 userProfiles.conqueredCount（供制霸排名使用）
    const _cnt = Object.values(stampMap).filter(v => v != null && (v >= 1 || v === 20)).length;
    db.collection('userProfiles').doc(uid).set({ conqueredCount: _cnt }, { merge: true }).catch(() => {});
    closeStampModal();
    const lbl = _stampStatus === 'many'
      ? `吃過${_stampCount >= 10 ? '10+' : _stampCount}次`
      : STATUS_LABELS[_stampStatus];
    showStampToast(`✓ 踩點：${lbl}`);
    if (typeof gtag !== 'undefined') gtag('event', 'stamp_shop', { shop_id: shopId, shop_name: _stampShopName });
  } catch (e) { showStampToast('踩點失敗：' + e.message); }
});

document.getElementById('smResetBtn').addEventListener('click', async () => {
  if (!confirm(`確定要清除「${_stampShopName}」的踩點記錄嗎？\n此操作無法復原。`)) return;
  const shopId = _stampShopId;
  if (!shopId || !auth.currentUser) return;
  delete stampMap[shopId]; delete reviewMap[shopId];
  try {
    await db.collection('userVisits').doc(auth.currentUser.uid).update({
      [`visits.${shopId}`]:  firebase.firestore.FieldValue.delete(),
      [`reviews.${shopId}`]: firebase.firestore.FieldValue.delete(),
    });
    document.querySelectorAll(`.stamp-btn[data-id="${shopId}"]`).forEach(b => b.classList.remove('stamped'));
    // 同步更新 userProfiles.conqueredCount
    const _cnt = Object.values(stampMap).filter(v => v != null && (v >= 1 || v === 20)).length;
    db.collection('userProfiles').doc(auth.currentUser.uid).set({ conqueredCount: _cnt }, { merge: true }).catch(() => {});
    closeStampModal();
    showStampToast('已清除踩點記錄');
  } catch (e) { showStampToast('重置失敗：' + e.message); }
});
