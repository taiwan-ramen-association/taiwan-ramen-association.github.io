// ── auth.js ──────────────────────────────────────────────────────────────────
// Firebase 初始化、登入/登出、Profile dropdown、Feature Flags、Beta Gate
// 依賴全域（其他 JS 模組）：
//   showStampToast, loadStamps（stamps.js）
//   compressImage（reviews.js）
//   favSet, stampMap, reviewMap（stamps.js）
// 依賴全域（主 inline script）：
//   showFavOnly, render, _currentPage, switchPage, checkUnreadBadge,
//   _onDataLoaded, _onBdAnimDone, openOnboardingModal
// 提供全域：
//   auth, db, storage, provider, firebase (透過 initializeApp)
//   currentUserRole, currentDisplayName, currentAvatarUrl, isWarned
//   featureFlags（含 vis/perm 設定）
//   canView, canUse, showAccessToast, hasPermission, getRoleLevel
//   loadFeatureFlags, applyFeatureFlags
//   getAvatarUrl, applyAvatarUrl
//   showBetaGate, openPrivacyModal, closePrivacyModal, doGoogleSignIn

// ── 0. Page Detection: 自動辨識當前是 finder.html 還是 finder-beta.html ─────
// 兩個頁面共用此 auth.js，但 gate 參數不同：
//   finder-beta.html → 使用 betaAccess，預設 director，beta 專屬訊息
//   finder.html      → 使用 siteAccess，預設 all，緊急關站訊息
const IS_BETA = location.pathname.endsWith('finder-beta.html');
const GATE_FLAG              = IS_BETA ? 'betaAccess' : 'siteAccess';
const GATE_DEFAULT_ROLE      = IS_BETA ? 'director'    : 'all';
const GATE_MSG_NO_PERM       = IS_BETA ? '此頁面僅開放特定身份瀏覽' : '此頁面暫時關閉，請稍後再試';
const GATE_MSG_NOT_LOGGED_IN = IS_BETA ? '此頁面需要登入後才能瀏覽' : '此頁面暫時關閉，請稍後再試';
const GATE_SHOW_LOGIN_BTN    = IS_BETA;  // 未登入時是否顯示登入按鈕

// ── 1. Firebase Init ─────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyBdN0AYZMM2AU66QcH4BVNJHx1plwQBBYc",
  authDomain: "taiwan-ramen-association.web.app",
  projectId: "taiwan-ramen-association",
  storageBucket: "taiwan-ramen-association.firebasestorage.app",
  messagingSenderId: "66234065738",
  appId: "1:66234065738:web:eb9fc4348a942da66ad7b3"
};
firebase.initializeApp(firebaseConfig);
const auth     = firebase.auth();
const db       = firebase.firestore();
const storage  = firebase.storage();
const provider = new firebase.auth.GoogleAuthProvider();

// ── 2. DOM refs ──────────────────────────────────────────────────────────────
const loginBtn         = document.getElementById('loginBtn');
const userAvatar       = document.getElementById('userAvatar');
const logoutBtn        = document.getElementById('logoutBtn');
const adminLink        = document.getElementById('adminLink');
const profileDropdown  = document.getElementById('profileDropdown');
const pdEmail          = document.getElementById('pdEmail');

let _googlePhotoURL = '';
let _localAvatarUid = null;

// ── 3. Role / Feature Flag State ─────────────────────────────────────────────
var currentUserRole    = ''; // 登入後由 onAuthStateChanged 填入
var _ffReady           = null; // loadFeatureFlags() 的 Promise，供 onAuthStateChanged await
var currentDisplayName = '';
var currentAvatarUrl   = '';
var isWarned           = false;

var featureFlags = {
  favorites:      { vis: 'viewer',   perm: 'viewer'   },
  stamps:         { vis: 'viewer',   perm: 'viewer'   },
  queueReport:    { vis: 'director', perm: 'director' },
  rankings:       { vis: 'viewer',   perm: 'viewer'   },
  domination:     { vis: 'viewer',   perm: 'viewer'   },
  reviews:        { vis: 'all',      perm: 'viewer'   },
  challengesNav:  { vis: 'admin',    perm: 'admin'    },
  nonActiveShops: { vis: 'all',      perm: 'viewer'   },
  onboardingTour: { vis: 'viewer',   perm: 'viewer'   },
  shopPage:       { vis: 'viewer',   perm: 'viewer'   },
};

const ROLE_LEVEL = { all: 0, viewer: 1, member: 2, director: 3, admin: 4 };
const MEMBER_ROLES = ['member_individual','member_group','member_sponsor','member_honorary'];

function getRoleLevel(role) {
  if (role === 'admin')    return 4;
  if (role === 'director') return 3;
  if (MEMBER_ROLES.includes(role)) return 2;
  if (role === 'viewer' || role === 'store') return 1;
  return 0;
}

function canView(feature) {
  const flag = featureFlags[feature];
  if (!flag) return true;
  const req = ROLE_LEVEL[flag.vis] ?? 1;
  return getRoleLevel(currentUserRole) >= req;
}

function canUse(feature) {
  const flag = featureFlags[feature];
  if (!flag) return true;
  const req = ROLE_LEVEL[flag.perm] ?? 1;
  return getRoleLevel(currentUserRole) >= req;
}

// 未登入 vs 已登入無權限，顯示對應提示
function showAccessToast() {
  if (!auth.currentUser) {
    showStampToast('請先登入以使用此功能');
  } else {
    showStampToast('此功能目前暫不開放');
  }
}

async function loadFeatureFlags() {
  try {
    const snap = await db.collection('meta').doc('featureFlags').get();
    if (snap.exists) featureFlags = { ...featureFlags, ...snap.data() };
  } catch(e) {}
}

function hasPermission(userRole, requiredRole) {
  return getRoleLevel(userRole) >= (ROLE_LEVEL[requiredRole] ?? 99);
}

// ── 4. Avatar utilities ──────────────────────────────────────────────────────
function localAvatarKey(uid) { return 'avatarCache_' + uid; }

function getAvatarUrl(userData, googlePhotoURL) {
  return userData?.avatarUrl || googlePhotoURL || 'assets/icons/03.png';
}

function applyAvatarUrl(url) {
  if (!url) return;
  userAvatar.src = url;
}

function applyLocalAvatarCache(uid) {
  const cached = uid && localStorage.getItem(localAvatarKey(uid));
  if (cached) { applyAvatarUrl(cached); return true; }
  return false;
}

// ── 5. Profile Dropdown ──────────────────────────────────────────────────────
function closeProfileDropdown() {
  profileDropdown.style.display = 'none';
}

userAvatar.addEventListener('click', e => {
  e.stopPropagation();
  const isOpen = profileDropdown.style.display !== 'none';
  if (isOpen) {
    closeProfileDropdown();
  } else {
    document.getElementById('drawer').style.display = 'none';
    document.getElementById('drawerBackdrop').style.display = 'none';
    profileDropdown.style.display = 'block';
  }
});

document.addEventListener('click', e => {
  if (!profileDropdown.contains(e.target) && e.target !== userAvatar) {
    closeProfileDropdown();
  }
});


logoutBtn.addEventListener('click', () => {
  closeProfileDropdown();
  auth.signOut();
});

// ── 6. applyFeatureFlags ─────────────────────────────────────────────────────
function applyFeatureFlags() {
  // ── Bottom Nav ────────────────────────────────────────────────────────────
  // 收藏（初始 display:none，有權限才顯示）
  const bnavFavorites = document.getElementById('bnavFavorites');
  if (bnavFavorites) bnavFavorites.style.display = canView('favorites') ? '' : 'none';

  // 社群貼文（初始 display:none）
  const bnavPosts = document.getElementById('bnavPosts');
  if (bnavPosts) {
    const show = canView('postsNav');
    bnavPosts.style.display = show ? '' : 'none';
    bnavPosts.classList.toggle('ff-locked', show && !canUse('postsNav'));
    if (!show && _currentPage === 'reviews') switchPage('finder');
  }

  // 挑戰任務（初始 display:none）
  const bnavChallenges = document.getElementById('bnavChallenges');
  if (bnavChallenges) {
    const show = canView('challengesNav');
    bnavChallenges.style.display = show ? '' : 'none';
    bnavChallenges.classList.toggle('ff-locked', show && !canUse('challengesNav'));
    if (!show && _currentPage === 'challenges') switchPage('finder');
  }

  // ── Profile Dropdown ──────────────────────────────────────────────────────
  // 制霸地圖（初始 display:none）
  const domLink = document.getElementById('dominationLink');
  if (domLink) {
    domLink.style.display = canView('domination') ? '' : 'none';
    domLink.classList.toggle('ff-locked', canView('domination') && !canUse('domination'));
    if (!domLink._ga4bound) {
      domLink._ga4bound = true;
      domLink.addEventListener('click', () => {
        if (typeof gtag !== 'undefined') gtag('event', 'domination_open');
      });
    }
  }

  // 排行榜（初始 display:none）
  const rkPdBtn = document.getElementById('rankingsPdBtn');
  if (rkPdBtn) {
    rkPdBtn.style.display = canView('rankings') ? '' : 'none';
    rkPdBtn.classList.toggle('ff-locked', canView('rankings') && !canUse('rankings'));
  }

  // ── 搜尋過濾 Modal ────────────────────────────────────────────────────────
  // 非現存店家 toggle（初始 display:none）
  const sfNonActiveRow = document.getElementById('sfNonActiveRow');
  if (sfNonActiveRow) sfNonActiveRow.style.display = canView('nonActiveShops') ? '' : 'none';

  // ── 漢堡選單 ──────────────────────────────────────────────────────────────
  // 新手導覽（初始 display:none）
  const resetOnboardBtn = document.getElementById('resetOnboardBtn');
  if (resetOnboardBtn) resetOnboardBtn.style.display = canView('onboardingTour') ? '' : 'none';
}

// ── 7. Beta Gate ─────────────────────────────────────────────────────────────
function showBetaGate(msg, showLogin = false) {
  document.getElementById('betaGate').style.display = 'flex';
  document.getElementById('betaGateMsg').textContent = msg;
  document.getElementById('betaLoginBtn').style.display = showLogin ? 'flex' : 'none';
  document.getElementById('loadingScreen').style.display = 'none';
  document.getElementById('mainContent').classList.remove('mc-show');
}

document.getElementById('betaLoginBtn').addEventListener('click', () => openPrivacyModal());

// ── 8. onAuthStateChanged ────────────────────────────────────────────────────
auth.onAuthStateChanged(async user => {
  try {
    if (user) {
      _googlePhotoURL = user.photoURL || '';
      loginBtn.style.display = 'none';
      userAvatar.style.display = 'block';

      const userRef = db.collection('users').doc(user.uid);
      await userRef.set({
        displayName: user.displayName || '',
        email:       user.email || '',
        photoURL:    user.photoURL || '',
        lastLogin:   firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      const snap     = await userRef.get();
      const userData = snap.data();

      // 第一次登入：設定基本欄位 + 自動分配 memberNo
      if (!userData.role) {
        // Step 1：先寫入基本欄位（獨立，確保一定成功）
        try {
          await userRef.update({
            role: 'viewer', level: 0, postCount: 0, likeCount: 0,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
        } catch (e) {
          console.error('[首次登入] 寫入基本欄位失敗：', e);
        }
        // Step 2：分配 memberNo（Transaction 確保不重複）
        try {
          const counterRef = db.collection('meta').doc('counters');
          await db.runTransaction(async tx => {
            const cs = await tx.get(counterRef);
            const memberNo = cs.exists ? (cs.data().memberCount || 0) + 1 : 1;
            tx.set(counterRef, { memberCount: memberNo }, { merge: true });
            tx.update(userRef, { memberNo });
          });
        } catch (e) {
          console.error('[首次登入] memberNo 分配失敗：', e);
        }
        const snap2 = await userRef.get();
        Object.assign(userData, snap2.data());
      }

      // 同步公開 profile（讓其他登入用戶可讀 nickname / avatarUrl）
      try {
        await db.collection('userProfiles').doc(user.uid).set({
          displayName: userData.nickname || user.displayName || '匿名',
          nickname:    userData.nickname || '',
          avatarUrl:   userData.avatarUrl || user.photoURL || '',
        }, { merge: true });
      } catch(e) { console.warn('userProfiles sync failed', e); }

      // 從 Firestore 讀取 featureFlags，決定本頁存取門檻（GATE_FLAG 由頁面偵測決定）
      let permRole = GATE_DEFAULT_ROLE;
      try {
        const ffSnap = await db.collection('meta').doc('featureFlags').get();
        if (ffSnap.exists && ffSnap.data()[GATE_FLAG]?.perm) {
          permRole = ffSnap.data()[GATE_FLAG].perm;
        }
      } catch(e) { /* Firestore rules 未允許時沿用預設值 */ }

      if (!hasPermission(userData.role, permRole)) {
        showBetaGate(GATE_MSG_NO_PERM);
        userAvatar.style.display = 'block';
        return;
      }

      document.getElementById('betaGate').style.display = 'none';

      // 頭像：Firestore avatarUrl > Google photoURL，localStorage 只做 URL 快取加速
      _localAvatarUid = user.uid;
      const avatar = getAvatarUrl(userData, user.photoURL);
      applyAvatarUrl(avatar);
      applyLocalAvatarCache(user.uid); // 若有快取 URL 先顯示（避免閃爍）
      // Google 帳號區（唯讀）
      document.getElementById('pdGoogleAvatar').src        = user.photoURL || 'assets/icons/03.png';
      document.getElementById('pdGoogleName').textContent  = user.displayName || '';
      pdEmail.value = user.email || '';
      adminLink.style.display   = userData.role === 'admin' ? 'flex' : 'none';
      isWarned = userData.role === 'warned';
      currentUserRole    = userData.role || 'viewer';
      currentDisplayName = userData.nickname || user.displayName || '匿名';
      currentAvatarUrl   = avatar;

      // GA4: 綁定 user_id（跨裝置識別）
      if (typeof gtag === 'function') {
        gtag('config', 'G-D5PB53XF7P', { user_id: user.uid });
      }

      // 載入收藏清單 + 踩點記錄
      const favIds = userData.favorites || [];
      favSet = new Set(favIds);
      await loadStamps(user.uid);
      await _ffReady;
      applyFeatureFlags();
      render();
      checkUnreadBadge();
      _onDataLoaded(() => _onBdAnimDone(() => { if (!localStorage.getItem('onboarding_done_' + user.uid)) openOnboardingModal(); }));
    } else {
      loginBtn.style.display   = 'flex';
      userAvatar.style.display = 'none';
      isWarned = false;
      currentUserRole    = '';
      currentDisplayName = '';
      currentAvatarUrl   = '';
      _localAvatarUid = null;
      favSet = new Set();
      stampMap = {}; reviewMap = {};
      showFavOnly = false;
      document.getElementById('mainContent').classList.remove('fav-mode');
      if (_currentPage === 'favorites') switchPage('finder');
      closeProfileDropdown();
      await _ffReady;
      applyFeatureFlags();

      // 未登入時也要檢查本頁 gate flag，若為 'all' 則開放瀏覽
      let permRole = GATE_DEFAULT_ROLE;
      try {
        const ffSnap = await db.collection('meta').doc('featureFlags').get();
        if (ffSnap.exists && ffSnap.data()[GATE_FLAG]?.perm) {
          permRole = ffSnap.data()[GATE_FLAG].perm;
        }
      } catch(e) {}

      if (permRole === 'all') {
        document.getElementById('betaGate').style.display  = 'none';
        document.getElementById('loadingScreen').style.display = 'none';
        document.getElementById('mainContent').classList.add('mc-show');
        render();
      } else {
        showBetaGate(GATE_MSG_NOT_LOGGED_IN, GATE_SHOW_LOGIN_BTN);
      }
    }
  } catch (err) {
    console.error('[auth] 處理失敗:', err.message, err.stack || '');
    loginBtn.style.display   = 'flex';
    userAvatar.style.display = 'none';
  }
});

// ── 9. Privacy Modal & Login Flow ────────────────────────────────────────────
function openPrivacyModal() {
  document.getElementById('privacyModal').classList.add('open');
}
function closePrivacyModal() {
  document.getElementById('privacyModal').classList.remove('open');
}
function doGoogleSignIn() {
  closePrivacyModal();
  // popup 優先；popup 被擋才 fallback 到 redirect
  // getRedirectResult()（頁面底部）負責接回 redirect 的結果
  auth.signInWithPopup(provider)
    .catch(err => {
      if (err.code === 'auth/popup-blocked') {
        auth.signInWithRedirect(provider).catch(e => console.error('[auth] redirect failed', e));
      } else if (err.code !== 'auth/popup-closed-by-user') {
        console.error('[auth] 登入失敗', err);
      }
    });
}
document.getElementById('privacyGoogleBtn').addEventListener('click', doGoogleSignIn);
document.getElementById('privacySkipBtn').addEventListener('click', closePrivacyModal);

loginBtn.addEventListener('click', () => openPrivacyModal());

auth.getRedirectResult()
  .catch(err => {
    if (err.code && err.code !== 'auth/no-auth-event') console.error('[auth] getRedirectResult error:', err.code, err.message);
  });

// featureFlags 立即開始從 Firestore 載入，onAuthStateChanged 的兩個分支都會 await 此 Promise
// 確保 applyFeatureFlags() 永遠用 Firestore 值，不用 code 預設值，杜絕 UI 閃爍
_ffReady = loadFeatureFlags();
