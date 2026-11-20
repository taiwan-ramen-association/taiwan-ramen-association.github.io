// ── auth.js ──────────────────────────────────────────────────────────────────
// Firebase 初始化、登入/登出、Profile dropdown、Feature Flags、Beta Gate
// 依賴全域（其他 JS 模組）：
//   showStampToast, loadStamps（stamps.js）
//   compressImage（reviews.js）
//   favSet, stampMap, reviewMap（stamps.js）
// 依賴全域（主 inline script）：
//   render, _currentPage, switchPage, checkUnreadBadge,
//   _onDataLoaded, _onBdAnimDone
// 依賴全域（js/onboarding.js；快取裡的舊版 finder.html 沒有 → 退回 openOnboardingModal）：
//   onboardingAutoOpen
// 提供全域：
//   auth, db, storage, provider, firebase (透過 initializeApp)
//   currentUserRole, currentDisplayName, currentAvatarUrl, isWarned
//   _memberRoleKnown, _memberSlowOrFailed, _authSettled, _authSettledPromise（2026-11-17，見 §3、§8）
//   featureFlags（含 vis/perm 設定）
//   canView, canUse, showAccessToast, accessDeniedText, showMemberLoadToast, hasPermission, getRoleLevel
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

// beta 讀獨立的 meta/featureFlagsBeta（測試設定，不污染正式版）；不存在時 fallback 正式 doc
async function _readGatePerm() {
  // 回傳本頁 gate flag 的 perm 角色；featureFlagsBeta 不存在則 fallback 正式 featureFlags
  try {
    if (IS_BETA) {
      const b = await db.collection('meta').doc('featureFlagsBeta').get();
      if (b.exists && b.data()[GATE_FLAG]?.perm) return b.data()[GATE_FLAG].perm;
    }
    const s = await db.collection('meta').doc('featureFlags').get();
    if (s.exists && s.data()[GATE_FLAG]?.perm) return s.data()[GATE_FLAG].perm;
  } catch(e) {}
  return GATE_DEFAULT_ROLE;
}

// 跨檔共享狀態（reviews.js 亦會宣告，此處先宣告確保 auth callback 觸發前已存在）
var _currentPage = 'finder';

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
var currentShopId      = ''; // 掃描者綁定的店家 ID（store/member_group）；js/scan.js 核銷用
var _ffReady           = null; // loadFeatureFlags() 的 Promise，供 onAuthStateChanged await
var currentDisplayName = '';
var currentAvatarUrl   = '';
var isWarned           = false;

// 會員資料載入狀態（2026-11-17，見 §8 onAuthStateChanged 開頭的說明）
//   _memberRoleKnown     users/{uid} 讀到了、身分已填 → currentUserRole／isWarned 才可信；false＝權限照未登入算
//   _memberSlowOrFailed  讀取失敗，或超過 MEMBER_WATCHDOG_MS 還沒讀完 → 提示改成請使用者重新整理
// 別的檔案要用一律 window.xxx 或先 typeof：部署後約 10 分鐘內 finder.html／stamps.js 可能還是快取的舊版
var _memberRoleKnown     = false;
var _memberSlowOrFailed  = false;
var MEMBER_LOAD_FAIL_MSG = '會員資料沒有載入成功，請重新整理';
const MEMBER_WATCHDOG_MS = 10000;
let _memberWatchdog      = null;

// 身分確定了沒：登入流程跑完（已登入、未登入、出錯三條路都算）才是 true，登入狀態改變時重來一次。
// finder.html 底部 nav 用：還沒確定就點 → 先等 _authSettledPromise（見 finder.html _bnavAllowed）
var _authSettled = false;
var _authSettledResolve = null;
var _authSettledPromise = new Promise(r => { _authSettledResolve = r; });
function _authBegin() {
  if (!_authSettled) return;
  _authSettled = false;
  _authSettledPromise = new Promise(r => { _authSettledResolve = r; });
}
function _authEnd() { _authSettled = true; _authSettledResolve(); }

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
  scanLink:       { vis: 'viewer',   perm: 'viewer'   },
  scanChallengeVerify: { vis: 'admin', perm: 'admin' },
  birthdayNotice: { vis: 'admin',   perm: 'admin'   },  // 生日店家通知（煙火）；預設關（admin），後台改 all 開放
  badges:         { vis: 'admin',   perm: 'admin'   },  // 獎章（任務頁橫幅＋面板，js/badges.js）；測完後台改 all 開放
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

// 權限不足時的提示：未登入／會員資料還沒好（身分還沒填）／已登入但沒權限。
// accessDeniedText 也給 finder.html 深連結用（兩邊文字要一樣）
function accessDeniedText() {
  if (!auth.currentUser) return '請先登入以使用此功能';
  if (!_memberRoleKnown) return _memberSlowOrFailed ? MEMBER_LOAD_FAIL_MSG : '還在載入，請稍後再試';
  return '此功能目前暫不開放';
}
function showAccessToast() {
  const msg = accessDeniedText();
  showStampToast(msg, msg === MEMBER_LOAD_FAIL_MSG ? 5000 : 0);
}
// 按了要用會員資料的功能、但還沒載好（踩點，js/stamps.js _stampsReady）：失敗或逾時 → 請重新整理；還在跑 → 稍候
function showMemberLoadToast() {
  if (_memberSlowOrFailed) showStampToast(MEMBER_LOAD_FAIL_MSG, 5000);
  else showStampToast('還在載入，請稍後再試');
}
// 會員資料沒讀到 → 跳一次提示。要等店家資料、壽星動畫：載入畫面（z-index 1400）、深連結遮罩都蓋在提示（700）上面
function _queueMemberFailToast() {
  const show  = () => { if (_memberSlowOrFailed && auth.currentUser) showStampToast(MEMBER_LOAD_FAIL_MSG, 6000); };
  const later = () => setTimeout(show, (typeof _dlMaskOpen !== 'undefined' && _dlMaskOpen) ? 400 : 0);
  const afterAnim = () => (typeof _onBdAnimDone === 'function' ? _onBdAnimDone(later) : later());
  if (typeof _onDataLoaded === 'function') _onDataLoaded(afterAnim); else afterAnim();
}

async function loadFeatureFlags() {
  // beta 優先讀 featureFlagsBeta（獨立測試設定），不存在則 fallback 正式 featureFlags
  try {
    if (IS_BETA) {
      const betaSnap = await db.collection('meta').doc('featureFlagsBeta').get();
      if (betaSnap.exists) { featureFlags = { ...featureFlags, ...betaSnap.data() }; return; }
    }
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


// 登出後整頁重載：一次清乾淨所有「登入後才渲染」的殘留（評論留言 bar、挑戰圖鑑戳章、
// 收藏/踩點狀態…），並天然回到預設落點首頁。只掛在「使用者主動按登出」這條路徑——
// 不可改掛 onAuthStateChanged 的未登入分支，否則未登入訪客首次開頁也會觸發 → 無限 reload。
logoutBtn.addEventListener('click', () => {
  closeProfileDropdown();
  auth.signOut()
    .then(() => location.reload())
    .catch(() => location.reload());
});

// ── 6. applyFeatureFlags ─────────────────────────────────────────────────────
function applyFeatureFlags() {
  // ── Bottom Nav（beta：五顆常駐，不因權限隱藏）──────────────────────────────
  // vis 退役：bottomNav 一律顯示；perm 控鎖定（未達 → ff-locked），
  // 點擊鎖定項由既有 click handler（canUse 檢查 → showAccessToast）提示登入/不開放。
  // 首頁 bnavHome、搜尋 bnavFinder 無 flag，永遠可用。
  // 2026-11-17 起 HTML 不再預設 display:none（一開頁就是五顆）；下面清 display 那行留給快取裡的舊版 finder.html
  [['bnavFavorites', 'favorites'], ['bnavPosts', 'postsNav'], ['bnavChallenges', 'challengesNav']]
    .forEach(([id, feat]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.display = '';                            // 覆蓋舊版 HTML 的 display:none → 常駐
      el.classList.toggle('ff-locked', !canUse(feat));  // perm 控鎖定
    });

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

  // 店家掃描 header 圖示（初始 display:none）：顯示純由 featureFlag scanLink 控制（vis）
  // 未登入靠 scanLink 預設 viewer 擋（等級 0 < viewer，看不到也不能用）
  // （profile 下拉的 scanLink 連結已移除，統一走 header 圖示 scnScanBtn → js/scan.js）
  const scnScanBtn = document.getElementById('scnScanBtn');
  if (scnScanBtn) {
    scnScanBtn.style.display = canView('scanLink') ? '' : 'none';
  }

  // ── 搜尋過濾 Modal ────────────────────────────────────────────────────────
  // 非現存店家 toggle（初始 display:none）：vis 控顯示、perm 控鎖定（無 perm 則 checkbox 禁用）
  const sfNonActiveRow = document.getElementById('sfNonActiveRow');
  if (sfNonActiveRow) {
    const show = canView('nonActiveShops');
    sfNonActiveRow.style.display = show ? '' : 'none';
    const lockedNon = show && !canUse('nonActiveShops');
    sfNonActiveRow.classList.toggle('ff-locked', lockedNon);
    const cbNon = document.getElementById('sfShowNonActive');
    if (cbNon) cbNon.disabled = lockedNon;
  }

  // 未踩點 toggle（登入後才顯示）
  const sfUnvisitedRow = document.getElementById('sfShowUnvisitedRow');
  if (sfUnvisitedRow) sfUnvisitedRow.style.display = '';

  // ── 漢堡選單 ──────────────────────────────────────────────────────────────
  // 新手導覽（初始 display:none）
  const resetOnboardBtn = document.getElementById('resetOnboardBtn');
  if (resetOnboardBtn) {
    const show = canView('onboardingTour');
    resetOnboardBtn.style.display = show ? '' : 'none';
    resetOnboardBtn.classList.toggle('ff-locked', show && !canUse('onboardingTour'));
  }
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
// finder.html 在 auth.js 之後才載入 stamps.js、card.js（render）、challenges.js、badges.js 與內嵌腳本。
// 腳本送得慢時（2026-10-30 實測：經 SW 轉送，map.js 晚了 1.4 秒），這裡會先跑到 render() → ReferenceError，
// 後半段整個被跳過：登入者看到「登入」按鈕，未讀、深連結、挑戰頁重抓都沒跑。
// 所以兩個分支用到其他檔案的東西之前都先等這個（HTML 解析完＝前面的同步腳本都執行過了）
const _pageScriptsReady = new Promise(resolve => {
  if (document.readyState !== 'loading') resolve();
  else document.addEventListener('DOMContentLoaded', resolve, { once: true });
});

// 2026-11-17 錯誤處理：每一步各自 try/catch；不管哪一步失敗，最後都會跑到 applyFeatureFlags()、render()、
// 深連結，已登入的人右上角維持頭像（不會變回「登入」）。
//   寫登入資料（lastLogin 等）失敗 → 照常往下
//   讀不到會員資料（users）→ 不能當成第一次登入（會重設身分、重發會員編號、多送 sign_up）：
//     身分留空＝權限照未登入算；不跑首次登入、不同步 userProfiles、不讀踩點
//   讀不到踩點紀錄（userVisits）→ 身分照常，只擋踩點（js/stamps.js _stampsReady）
//   這兩種獎章都不給 uid（不然 _bdgWriteSeen 會把「0 個踩點」算出來的結果寫回 badgeSeen），並跳提示 MEMBER_LOAD_FAIL_MSG
//   斷線時 set()／get() 不會失敗而是一直等 → 超過 MEMBER_WATCHDOG_MS 先跳提示；網路恢復後照常跑完、自動解鎖
//   身分（currentUserRole 等）等踩點讀完才填：中途有 render 的話按鈕都是鎖住的，不會拿還沒載完的資料去寫
//   其他沒料到的錯誤（外層 catch）→ 一律照「讀不到會員資料」處理
auth.onAuthStateChanged(async user => {
  _authBegin();
  clearTimeout(_memberWatchdog);
  _memberRoleKnown    = false;
  _memberSlowOrFailed = false;
  try {
    if (user) {
      _googlePhotoURL = user.photoURL || '';
      loginBtn.style.display = 'none';
      userAvatar.style.display = 'block';
      _memberWatchdog = setTimeout(() => {
        const u = auth.currentUser;
        if (!u || u.uid !== user.uid || _memberRoleKnown) return;
        console.warn('[auth] 會員資料超過 ' + (MEMBER_WATCHDOG_MS / 1000) + ' 秒還沒讀完');
        _memberSlowOrFailed = true;
        _queueMemberFailToast();
      }, MEMBER_WATCHDOG_MS);

      const userRef = db.collection('users').doc(user.uid);
      try {
        await userRef.set({
          displayName: user.displayName || '',
          email:       user.email || '',
          photoURL:    user.photoURL || '',
          lastLogin:   firebase.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      } catch (e) { console.warn('[auth] 寫入登入資料失敗（照常往下）', e); }

      // 讀失敗、文件不存在（上面也沒寫進去）、只拿到快取 → userData 留 null
      let userData = null;
      try {
        const snap = await userRef.get();
        if (snap.exists && !(snap.metadata && snap.metadata.fromCache)) userData = snap.data();
        else console.error('[auth] 會員資料沒讀到：' + (snap.exists ? '只有快取' : '文件不存在'));
      } catch (e) { console.error('[auth] 讀取會員資料失敗', e); }

      // 第一次登入：設定基本欄位 + 自動分配 memberNo
      if (userData && !userData.role) {
        // Step 1：先寫入基本欄位（獨立，確保一定成功）
        try {
          await userRef.update({
            role: 'viewer', level: 0, postCount: 0, likeCount: 0,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
        } catch (e) {
          console.error('[首次登入] 寫入基本欄位失敗：', e);
        }
        // GA4：新會員（獎章停損要看「分享圖卡帶進幾位新會員」，achievement-system.md §十）
        if (typeof gtag === 'function') gtag('event', 'sign_up', { method: 'google' });
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

      // 同步公開 profile（讓其他登入用戶可讀 nickname / avatarUrl）；會員資料沒讀到就不同步（不知道暱稱）
      if (userData) {
        try {
          await db.collection('userProfiles').doc(user.uid).set({
            displayName: userData.nickname || user.displayName || '匿名',
            nickname:    userData.nickname || '',
            avatarUrl:   userData.avatarUrl || user.photoURL || '',
          }, { merge: true });
        } catch(e) { console.warn('userProfiles sync failed', e); }
      }

      // 從 Firestore 讀取 featureFlags，決定本頁存取門檻（GATE_FLAG 由頁面偵測決定）
      let permRole = await _readGatePerm();

      if (!hasPermission(userData ? userData.role : '', permRole)) {
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
      currentDisplayName = userData ? (userData.nickname || user.displayName || '匿名') : '';
      currentAvatarUrl   = avatar;

      // GA4: 綁定 user_id（跨裝置識別）
      if (typeof gtag === 'function') {
        gtag('config', 'G-D5PB53XF7P', { user_id: user.uid });
      }

      // 以下用到 stamps.js（favSet、loadStamps）、card.js（render）與內嵌腳本，先等腳本載完
      await _pageScriptsReady;

      // 載入收藏清單 + 踩點記錄（會員資料沒讀到就不讀踩點：身分不明，踩點本來就鎖住）
      favSet = new Set(userData ? (userData.favorites || []) : []);
      let stampsOk = false;
      if (userData) {
        try { await loadStamps(user.uid); stampsOk = true; }
        catch (e) { console.error('[auth] 讀取踩點紀錄失敗', e); }
      }

      // 身分最後才填（見本段開頭）
      adminLink.style.display = userData && userData.role === 'admin' ? 'flex' : 'none';
      isWarned            = !!userData && userData.role === 'warned';
      currentUserRole     = userData ? (userData.role || 'viewer') : '';
      currentShopId       = userData ? (userData.shopId || '') : '';
      _memberRoleKnown    = !!userData;
      _memberSlowOrFailed = !stampsOk;
      clearTimeout(_memberWatchdog);

      // 獎章要用踩點判斷「從業過」，所以排在 loadStamps 之後；踩點沒讀到就不給 uid（見本段開頭）
      if (typeof badgesSetUser === 'function') badgesSetUser(stampsOk ? user.uid : null, stampsOk ? userData : null);
      await _ffReady;
      applyFeatureFlags();
      render();
      checkUnreadBadge();
      if (typeof applyDeepLinkOnce === 'function') applyDeepLinkOnce();
      if (_memberSlowOrFailed) _queueMemberFailToast();

      // 登入後背景重抓「受登入狀態影響」的資料，不 reload、不跳頁（登出才 reload）。
      // 未登入時這些頁面是以「空進度／無留言框」渲染的，不重抓就會停在舊畫面：
      //   ① 挑戰頁：進度、審查中/已駁回戳章（否則已完成的格子還點得開送出 modal）
      //   ② 首頁挑戰卡：「進行中」紅框吃 _chUserProgress
      //   ③ 貼文頁：留言 bar 是渲染當下依 auth.currentUser 決定塞不塞進 DOM 的
      // 必須等 ALL_DATA 就緒才跑——圖鑑格要靠 findShopById 查店名，早跑會顯示成 shopId。
      if (typeof _onDataLoaded === 'function') {
        _onDataLoaded(() => {
          if (typeof loadChallengesPage === 'function') {
            Promise.resolve(loadChallengesPage({ keepView: true }))
              .then(() => { if (typeof renderHomeTaskBanner === 'function') renderHomeTaskBanner(); })
              .catch(() => {});
          }
          // 沒進過貼文頁就不預載（下次進頁本來就會載），省一輪評論讀取
          if (typeof _rfLoaded !== 'undefined' && _rfLoaded && typeof loadReviewsFeedPage === 'function') {
            Promise.resolve(loadReviewsFeedPage(1, { keepView: true })).catch(() => {});
          }
        });
      }

      // 新手導覽：跳不跳交給 js/onboarding.js（看過的版本比 meta/onboarding 舊才跳）；
      // 快取裡的舊版 finder.html 沒有 onboardingAutoOpen → 照舊寫法
      _onDataLoaded(() => _onBdAnimDone(() => {
        if (typeof onboardingAutoOpen === 'function') onboardingAutoOpen(user.uid);
        else if (canView('onboardingTour') && !localStorage.getItem('onboarding_done_' + user.uid)) openOnboardingModal();
      }));
    } else {
      loginBtn.style.display   = 'flex';
      userAvatar.style.display = 'none';
      isWarned = false;
      currentUserRole    = '';
      currentShopId      = '';
      currentDisplayName = '';
      currentAvatarUrl   = '';
      _localAvatarUid = null;
      favSet = new Set();
      stampMap = {}; reviewMap = {};
      if (typeof badgesSetUser === 'function') badgesSetUser(null, null);
      showUnvisited = false;
      const _sfUnvisitedRow = document.getElementById('sfShowUnvisitedRow');
      if (_sfUnvisitedRow) _sfUnvisitedRow.style.display = 'none';
      if (_currentPage === 'favorites') switchPage('finder');
      closeProfileDropdown();
      await _pageScriptsReady;   // 下面的 render()、applyDeepLinkOnce() 在 card.js／內嵌腳本
      await _ffReady;
      applyFeatureFlags();

      // 未登入時也要檢查本頁 gate flag，若為 'all' 則開放瀏覽
      let permRole = await _readGatePerm();

      if (permRole === 'all') {
        document.getElementById('betaGate').style.display  = 'none';
        document.getElementById('loadingScreen').style.display = 'none';
        document.getElementById('mainContent').classList.add('mc-show');
        render();
        if (typeof applyDeepLinkOnce === 'function') applyDeepLinkOnce();
      } else {
        showBetaGate(GATE_MSG_NOT_LOGGED_IN, GATE_SHOW_LOGIN_BTN);
      }
    }
  } catch (err) {
    console.error('[auth] 處理失敗:', err.message, err.stack || '');
    // 2026-11-17：已登入就維持頭像（不變回「登入」）；會員狀態可能只跑一半 → 照「讀不到會員資料」處理
    if (user) {
      loginBtn.style.display   = 'none';
      userAvatar.style.display = 'block';
      adminLink.style.display  = 'none';
      isWarned        = false;
      currentUserRole = '';
      currentShopId   = '';
      _memberRoleKnown    = false;
      _memberSlowOrFailed = true;
    } else {
      loginBtn.style.display   = 'flex';
      userAvatar.style.display = 'none';
    }
    clearTimeout(_memberWatchdog);
    // 清單、底部選單、深連結照常出現；腳本可能還沒載完，先等 _pageScriptsReady（見 finder.html「深連結」段）
    await _pageScriptsReady;
    if (user && typeof badgesSetUser === 'function') { try { badgesSetUser(null, null); } catch (e) {} }
    try { await _ffReady; applyFeatureFlags(); } catch (e) { console.error('[auth] applyFeatureFlags 失敗', e); }
    try { render(); } catch (e) { console.error('[auth] render 失敗', e); }
    if (user) _queueMemberFailToast();
    // 深連結（2026-11-11）：登入流程出錯也算「身分確定了」，等登入結果的分頁（收藏等）不必等到 10 秒逾時
    if (typeof applyDeepLinkOnce === 'function') applyDeepLinkOnce();
  } finally {
    clearTimeout(_memberWatchdog);
    _authEnd();
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
