// ── scan.js ──────────────────────────────────────────────────────────────────
// 店家掃描 widget（內嵌於 finder.html，免跳轉 scan.html）
// header 掃描圖示 → 直接叫出相機 → 掃顧客會員卡 QR → 顧客面板核銷
//
// 設計：重用 finder 既有 Firebase（auth.js 已 initializeApp），不自帶 init；
//       PWA 已登入時點一下幾乎瞬間開相機（省去跳頁 + 重新 init + 重新 auth）。
// 依賴全域（auth.js）：auth, db, firebase, currentUserRole, currentShopId
// 依賴 DOM（finder.html）：scnScanBtn, scannerOverlay, scannerContainer, scCancelBtn,
//                          cpBackdrop, customerPanel, cpContent, scToast
// html5-qrcode：lazy load（第一次點掃描才注入 CDN，不拖累一般使用者首屏）
//
// ⚠ 所有識別字加 scn / SCN 前綴，避免與 auth.js / 主 script 全域（如 ROLE_LEVEL）衝突。

// ── Constants ─────────────────────────────────────────────────────────────────
const SCN_SCANNER_ROLES = ['store', 'member_group', 'admin'];
const SCN_PANEL_TIMEOUT = 60; // 秒

const SCN_ROLE_BADGE = {
  admin:             { label: 'ADMIN',    cls: 'admin'    },
  director:          { label: '理事',     cls: 'director' },
  member_individual: { label: '個人會員', cls: 'member'   },
  member_group:      { label: '團體會員', cls: 'member'   },
  member_sponsor:    { label: '贊助會員', cls: 'member'   },
  member_honorary:   { label: '榮譽會員', cls: 'member'   },
  store:             { label: '合作店家', cls: 'store'    },
  viewer:            { label: '一般用戶', cls: 'viewer'   },
};
// 角色等級（決定顯示哪些獎勵：forRole 等級 <= 顧客等級才顯示）。含 shopRewards.forRole 的 all/member。
const SCN_ROLE_LEVEL = {
  admin: 4, director: 3,
  member_individual: 2, member_group: 2, member_sponsor: 2, member_honorary: 2,
  store: 1, viewer: 1, all: 0, member: 2,
};

// ── State ─────────────────────────────────────────────────────────────────────
let _scnScannerUid     = null;
let _scnStoreShopId    = null;
let _scnHtml5Qr        = null;
let _scnScanning       = false;
let _scnPanelTimer     = null;
let _scnCurrentUid     = null;
let _scnMatchedRewards = [];
let _scnQrLibLoading   = null;
let _scnShowingMyCode    = false;  // overlay 內是否正顯示「我的碼」
let _scnMyQrUid          = null;   // 已生成 QR 的 uid（換帳號則重生）
let _scnQrCodeLibLoading = null;   // qrcodejs lazy load Promise

// ── Helpers ─────────────────────────────────────────────────────────────────
function _scnEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])
  );
}
function _scnLocalDateKey() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// html5-qrcode lazy load（只在第一次掃描時注入，避免一般使用者白白下載）
function _scnLoadQrLib() {
  if (window.Html5Qrcode) return Promise.resolve();
  if (_scnQrLibLoading)   return _scnQrLibLoading;
  _scnQrLibLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
    s.onload  = () => resolve();
    s.onerror = () => { _scnQrLibLoading = null; reject(new Error('html5-qrcode load failed')); };
    document.head.appendChild(s);
  });
  return _scnQrLibLoading;
}

// ── 入口：header 掃描圖示點擊 ────────────────────────────────────────────────
async function scnStart() {
  // double-check 權限（圖示本身已靠 featureFlag 只對掃描者顯示，此處防 race / 防直接呼叫）
  if (!auth.currentUser) { scnShowToast('請先登入', 'error'); return; }
  if (!SCN_SCANNER_ROLES.includes(currentUserRole)) { scnShowToast('此功能僅限具掃描資格的帳號', 'error'); return; }
  if (currentUserRole !== 'admin' && !currentShopId) {
    scnShowToast('此帳號尚未設定店家 ID，請聯絡管理員', 'error'); return;
  }
  _scnScannerUid  = auth.currentUser.uid;
  _scnStoreShopId = currentShopId || null; // admin 可無 shopId（測試模式）

  try { await _scnLoadQrLib(); }
  catch (e) { scnShowToast('掃描元件載入失敗，請檢查網路', 'error'); return; }

  scnOpenScanner();
}

// ── Scanner ───────────────────────────────────────────────────────────────────
function scnOpenScanner() {
  document.getElementById('scannerOverlay').classList.add('open');
  scnBackToScan(); // 進入掃描模式（隱藏我的碼 + 啟動相機）
}

// 啟動相機（掃描模式）。抽出供 scnOpenScanner / scnBackToScan 共用。
function _scnStartCamera() {
  document.getElementById('scannerContainer').innerHTML = ''; // 清除前次殘留
  _scnHtml5Qr  = new Html5Qrcode('scannerContainer');
  _scnScanning = true;

  _scnHtml5Qr.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 240, height: 240 }, showTorchButtonIfSupported: false },
    async (text) => {
      // 掃描成功：只處理一次
      if (!_scnScanning) return;
      _scnScanning = false;
      await _scnHtml5Qr.stop().catch(() => {});
      _scnHtml5Qr = null;
      document.getElementById('scannerOverlay').classList.remove('open');
      scnHandleScannedText(text.trim());
    },
    () => { /* 掃描持續嘗試中，忽略單幀失敗 */ }
  ).catch(err => {
    _scnScanning = false;
    _scnHtml5Qr  = null;
    document.getElementById('scannerOverlay').classList.remove('open');
    console.error('[scan] camera 錯誤:', err);
    scnShowToast('無法開啟相機，請確認權限', 'error');
  });
}

function _scnStopCamera() {
  if (_scnHtml5Qr && _scnScanning) {
    _scnScanning = false;
    _scnHtml5Qr.stop().catch(() => {});
    _scnHtml5Qr = null;
  }
}

function scnCloseScanner() {
  document.getElementById('scannerOverlay').classList.remove('open');
  _scnStopCamera();
  _scnResetMyCodeView(); // 重置回掃描模式，下次開乾淨
}

// ── 我的會員卡碼（overlay 內切換顯示）────────────────────────────────────────
// qrcodejs lazy load（與 profile 同一個 cdnjs 套件；點切換才注入）
function _scnLoadQrCodeLib() {
  if (window.QRCode) return Promise.resolve();
  if (_scnQrCodeLibLoading) return _scnQrCodeLibLoading;
  _scnQrCodeLibLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    s.onload  = () => resolve();
    s.onerror = () => { _scnQrCodeLibLoading = null; reject(new Error('qrcodejs load failed')); };
    document.head.appendChild(s);
  });
  return _scnQrCodeLibLoading;
}

function _scnResetMyCodeView() {
  _scnShowingMyCode = false;
  const myCode    = document.getElementById('scnMyCode');
  const container = document.getElementById('scannerContainer');
  const toggleBtn = document.getElementById('scnToggleMyCode');
  if (myCode)    myCode.style.display = 'none';
  if (container) container.style.display = '';
  if (toggleBtn) toggleBtn.textContent = '顯示我的碼';
}

function scnBackToScan() {
  _scnResetMyCodeView();
  _scnStartCamera();
}

async function scnToggleMyCode() {
  if (_scnShowingMyCode) { scnBackToScan(); return; }
  // 掃描 → 我的碼：停相機、切換畫面
  _scnStopCamera();
  document.getElementById('scannerContainer').style.display = 'none';
  document.getElementById('scnMyCode').style.display = 'flex';
  _scnShowingMyCode = true;
  const toggleBtn = document.getElementById('scnToggleMyCode');
  if (toggleBtn) toggleBtn.textContent = '掃描';

  // 生成自己的會員卡 QR（uid，同 profile 參數）。換帳號（uid 變）才重生。
  try {
    await _scnLoadQrCodeLib();
    if (auth.currentUser) {
      const qrEl = document.getElementById('scnMyQr');
      if (qrEl && _scnMyQrUid !== auth.currentUser.uid) {
        qrEl.innerHTML = '';
        new QRCode(qrEl, {
          text: auth.currentUser.uid, width: 180, height: 180,
          colorDark: '#000000', colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.M
        });
        _scnMyQrUid = auth.currentUser.uid;
      }
      const nameEl = document.getElementById('scnMyCodeName');
      if (nameEl) nameEl.textContent = (typeof currentDisplayName !== 'undefined' ? currentDisplayName : '') || '';
    }
  } catch (e) {
    console.error('[scan] qrcodejs 載入失敗', e);
    scnShowToast('QR 元件載入失敗，請檢查網路', 'error');
  }
}

// ── 掃到 QR 後處理 ─────────────────────────────────────────────────────────────
async function scnHandleScannedText(uid) {
  if (!uid) { scnShowToast('無效的 QR 內容', 'error'); return; }
  if (uid === _scnScannerUid) { scnShowToast('⚠ 無法掃描自己的 QR', 'error'); return; }
  // 會員卡 QR = 顧客 uid（英數）。含 Firestore docId 非法字元或過長 → 明顯非會員卡，
  // 直接擋並給精準訊息（不必白跑 Firestore，也避免落入 catch 顯示模糊的「查詢失敗」）
  if (uid.length > 128 || /[\/.#$\[\]]/.test(uid)) {
    scnShowToast('無法辨識的 QR（非會員卡）', 'error'); return;
  }

  // ── 未來 QR 類型 dispatch 預留（想法①②；目前一律當會員卡 uid 處理）──────────
  //   店家立牌尋寶：if (uid.startsWith('quest:')) return scnHandleQuestQR(uid); // → GPS 打卡 / 謎題
  //   輪替碼(Phase 6)：const realUid = scnParseToken(uid);
  //   權限放寬後：viewer 掃會員卡應只顯示唯讀身份，核銷仍限 operator。

  try {
    // 平行查詢：userProfiles（顧客）+ redemptions（本店預發券）+ shopRewards（本店即時獎勵）
    const queries = [
      db.collection('userProfiles').doc(uid).get(),
      _scnStoreShopId
        ? db.collection('redemptions')
            .where('uid', '==', uid)
            .where('shopId', '==', _scnStoreShopId)
            .get()
            .catch(e => {
              console.warn('[scan] redemptions 查詢失敗（可能需建立 uid+shopId 複合索引）:', e.message);
              return { docs: [] };
            })
        : Promise.resolve({ docs: [] }),
      _scnStoreShopId
        ? db.collection('shopRewards').doc(_scnStoreShopId).get()
        : Promise.resolve({ exists: false }),
    ];

    const [profileSnap, couponsSnap, srSnap] = await Promise.all(queries);

    if (!profileSnap.exists) { scnShowToast('找不到此用戶', 'error'); return; }
    const profile = profileSnap.data();

    // 只留 issued + 有效期內的預發券
    const now = new Date();
    const coupons = couponsSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(c => {
        if (c.status !== 'issued') return false;
        const from  = c.validFrom?.toDate?.() || new Date(0);
        const until = c.validUntil?.toDate?.();
        return now >= from && (!until || now <= until);
      });

    // 即時兌換：今日已兌「品項」集合（每店每天每品項各 1 次；跨店不互擋）
    const instantPrefix = _scnStoreShopId + '_' + uid + '_' + _scnLocalDateKey();
    const redeemedItemsToday = new Set(
      couponsSnap.docs
        .filter(d => d.id.indexOf(instantPrefix) === 0)
        .map(d => d.data().item || '')
    );

    const shopRewards = srSnap.exists ? srSnap.data() : null;
    scnOpenCustomerPanel(uid, profile, coupons, shopRewards, redeemedItemsToday);
  } catch (e) {
    console.error('[scan] 查詢失敗', e);
    scnShowToast('查詢失敗，請重試', 'error');
  }
}

// ── 顧客面板 ──────────────────────────────────────────────────────────────────
function scnOpenCustomerPanel(uid, profile, coupons, shopRewards, redeemedItemsToday) {
  _scnCurrentUid = uid;

  const role      = profile.role || 'viewer';
  const badge     = SCN_ROLE_BADGE[role] || SCN_ROLE_BADGE.viewer;
  const custLevel = SCN_ROLE_LEVEL[role] || 0;

  // 依顧客等級篩選即時獎勵（forRole 等級 <= 顧客等級才顯示）
  _scnMatchedRewards = (shopRewards?.rewards || [])
    .filter(r => (SCN_ROLE_LEVEL[r.forRole] || 0) <= custLevel);

  let html = `
    <div class="cp-identity">
      <img class="cp-avatar"
           src="${_scnEsc(profile.avatarUrl || profile.photoURL || 'assets/icons/03.png')}"
           onerror="this.src='assets/icons/03.png'">
      <div>
        <div class="cp-name">${_scnEsc(profile.nickname || profile.displayName || '匿名用戶')}</div>
        <span class="cp-role-chip ${badge.cls}">${badge.label}</span>
      </div>
    </div>
    <div class="cp-timer-row">
      <span class="cp-timer-text" id="cpTimerText">${SCN_PANEL_TIMEOUT}s</span>
      <div class="cp-timer-bar"><div class="cp-timer-fill" id="cpTimerFill" style="width:100%"></div></div>
    </div>`;

  // Path A：預發券
  html += `<div class="cp-section-title">預發券</div>`;
  if (coupons.length) {
    html += coupons.map(c => {
      const typeLabel = c.type === 'ticket' ? '🎫 入場券' : '🎟 兌換券';
      const validStr  = c.validUntil ? '　有效至 ' + c.validUntil.toDate().toLocaleDateString('zh-TW') : '';
      return `
        <div class="cp-item">
          <div class="cp-item-info">
            <div class="cp-item-name">${_scnEsc(c.item || '兌換券')}</div>
            <div class="cp-item-sub">${typeLabel}${_scnEsc(validStr)}</div>
          </div>
          <button class="cp-redeem-btn" data-path="A" data-coupon-id="${_scnEsc(c.id)}">核銷</button>
        </div>`;
    }).join('');
  } else {
    html += `<div class="cp-empty">無預發券</div>`;
  }

  // Path B：即時兌換獎勵（逐品項判斷今日是否已兌；同店其他品項不互擋）
  html += `<div class="cp-section-title">即時兌換獎勵</div>`;
  if (_scnMatchedRewards.length) {
    html += _scnMatchedRewards.map((r, i) => {
      const forBadge = SCN_ROLE_BADGE[r.forRole] || { label: r.forRole || '' };
      const done = redeemedItemsToday.has(r.item || '');
      return `
        <div class="cp-item">
          <div class="cp-item-info">
            <div class="cp-item-name">${_scnEsc(r.item || '獎勵')}</div>
            <div class="cp-item-sub">${_scnEsc(r.condition || '')}　<span style="opacity:.6">${_scnEsc(forBadge.label)} 適用</span></div>
          </div>
          ${done
            ? `<button class="cp-redeem-btn" disabled>✅ 今日已兌換</button>`
            : `<button class="cp-redeem-btn" data-path="B" data-reward-idx="${i}">核銷</button>`}
        </div>`;
    }).join('');
  } else {
    html += `<div class="cp-empty">此店尚未設定即時獎勵</div>`;
  }

  document.getElementById('cpContent').innerHTML = html;

  // 綁定核銷按鈕
  document.getElementById('cpContent').querySelectorAll('.cp-redeem-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      _scnResetPanelTimer();
      const allBtns = document.querySelectorAll('.cp-redeem-btn');
      allBtns.forEach(b => { b.disabled = true; });
      try {
        if (btn.dataset.path === 'A') {
          await _scnRedeemPathA(btn.dataset.couponId);
        } else {
          const idx = parseInt(btn.dataset.rewardIdx, 10);
          await _scnRedeemPathB(uid, _scnMatchedRewards[idx]);
        }
        scnShowToast('✅ 核銷成功！', 'success');
        setTimeout(scnCloseCustomerPanel, 1400);
      } catch (e) {
        console.error('[scan] 核銷失敗', e);
        const msg = e.code === 'today-redeemed'    ? '⚠ 此品項今日已兌換過'
                  : e.code === 'permission-denied' ? '權限不足（請確認 operators 設定 / 是否已兌換）'
                  : '請重試';
        scnShowToast('核銷失敗：' + msg, 'error');
        if (e.code === 'today-redeemed') setTimeout(scnCloseCustomerPanel, 1400);
        // 只重新啟用可核銷的按鈕（有 data-path），不碰常駐 disabled 的「✅ 今日已兌換」
        else allBtns.forEach(b => { if (b.dataset.path) b.disabled = false; });
      }
    });
  });

  // 面板內任何點擊重置計時器
  document.getElementById('customerPanel').addEventListener('click', _scnResetPanelTimer, { passive: true });

  document.getElementById('cpBackdrop').classList.add('open');
  document.getElementById('customerPanel').classList.add('open');
  _scnStartPanelTimer();
}

function scnCloseCustomerPanel() {
  clearInterval(_scnPanelTimer);
  _scnCurrentUid = null;
  document.getElementById('cpBackdrop').classList.remove('open');
  document.getElementById('customerPanel').classList.remove('open');
}

// ── 計時器 ────────────────────────────────────────────────────────────────────
function _scnStartPanelTimer() {
  clearInterval(_scnPanelTimer);
  let remaining = SCN_PANEL_TIMEOUT;
  _scnPanelTimer = setInterval(() => {
    remaining--;
    const t = document.getElementById('cpTimerText');
    const f = document.getElementById('cpTimerFill');
    if (t) t.textContent = remaining + 's';
    if (f) f.style.width = `${(remaining / SCN_PANEL_TIMEOUT) * 100}%`;
    if (remaining <= 0) { clearInterval(_scnPanelTimer); scnCloseCustomerPanel(); }
  }, 1000);
}
function _scnResetPanelTimer() { if (_scnCurrentUid) _scnStartPanelTimer(); }

// ── 核銷 ──────────────────────────────────────────────────────────────────────
// Path A：更新預發券 issued → redeemed
async function _scnRedeemPathA(couponId) {
  await db.collection('redemptions').doc(couponId).update({
    status:     'redeemed',
    redeemedAt: firebase.firestore.FieldValue.serverTimestamp(),
    redeemedBy: _scnScannerUid,
  });
}

// Path B：直接建立 redeemed 記錄（即時兌換）
// 固定 doc id = shopId_uid_YYYY-MM-DD_品項 → 同顧客同店同天「每品項」各 1 份
// （跨店、同店不同品項皆不互擋；防重複靠 doc id + rules !exists()）
async function _scnRedeemPathB(customerUid, reward) {
  const itemKey = String(reward.item || '獎勵').replace(/[\/#\.\[\]\$]/g, '_').slice(0, 60);
  const docId = _scnStoreShopId + '_' + customerUid + '_' + _scnLocalDateKey() + '_' + itemKey;
  const ref   = db.collection('redemptions').doc(docId);
  const snap  = await ref.get();
  if (snap.exists) {
    const err = new Error('今日已兌換'); err.code = 'today-redeemed';
    throw err;
  }
  await ref.set({
    uid:        customerUid,
    shopId:     _scnStoreShopId,
    type:       'coupon',
    status:     'redeemed',
    item:       reward.item || '',
    issuedBy:   _scnScannerUid,
    issuedAt:   firebase.firestore.FieldValue.serverTimestamp(),
    validFrom:  firebase.firestore.Timestamp.fromDate(new Date('2020-01-01')),
    validUntil: null,
    redeemedAt: firebase.firestore.FieldValue.serverTimestamp(),
    redeemedBy: _scnScannerUid,
    // TTL：即時核銷紀錄保留 90 天後由 Firestore 自動刪除（防止無限堆積）
    expireAt:   firebase.firestore.Timestamp.fromDate(new Date(Date.now() + 90*24*60*60*1000)),
  });
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let _scnToastTimer;
function scnShowToast(msg, type = '') {
  const el = document.getElementById('scToast');
  if (!el) return;
  el.textContent = msg;
  el.className   = 'sc-toast ' + type;
  void el.offsetWidth; // reflow
  el.classList.add('show');
  clearTimeout(_scnToastTimer);
  _scnToastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ── Bindings ────────────────────────────────────────────────────────────────
document.getElementById('scnScanBtn')     ?.addEventListener('click', scnStart);
document.getElementById('scnToggleMyCode')?.addEventListener('click', scnToggleMyCode);
document.getElementById('scCancelBtn')    ?.addEventListener('click', scnCloseScanner);
document.getElementById('cpBackdrop')     ?.addEventListener('click', scnCloseCustomerPanel);
