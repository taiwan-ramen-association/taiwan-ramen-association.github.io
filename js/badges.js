// ── badges.js ────────────────────────────────────────────────────────────────
// 獎章：任務頁標題下方的入口橫幅（#badgeStrip）、全螢幕獎章面板、點獎章看詳細＋設稱號／精選、
//       新獎章慶祝視窗＋底部「任務」紅點＋面板 NEW
// 計算在 js/badge-core.js（與後台「重算等級」共用）；規格見 ramen-finder-notes/achievement-system.md §六
// 依賴全域變數：
//   db, auth, stampMap, ALL_DATA, NON_ACTIVE_DATA, currentDisplayName,
//   _chChallenges, _chUserProgress, _chPendingTaskIds, _chProgressUid, _dataLoaded
// 依賴全域函式：
//   badgeMergeConfig, badgeCompute, badgeTierName, badgeTitleText, badgeAutoFeatured, badgeNewSince, badgePointsAt,
//   canView, canUse, escapeHtml, showStampToast, showAccessToast, openPrivacyModal, _onDataLoaded, _onBdAnimDone
// 提供全域函式：
//   badgesSetUser, badgesRefresh, badgesOpenPanel, badgesClosePanel, badgesOnAction

// ── 狀態 ────────────────────────────────────────────────────────────────────
let _bdgConfig     = null;    // 合併後的設定（meta/achievementConfig＋預設值）
let _bdgConfigLoad = null;    // 設定讀取中的 Promise（整個 session 只讀一次）
let _bdgUid        = null;
let _bdgUserData   = {};      // users/{uid}：badgeTitle、badgeFeatured、avatarUrl
let _bdgCounts     = null;    // { reviews, menus, crafts }：這個帳號的評論數、菜單數、職人確認結果
let _bdgCountsSeq  = 0;       // 計數載入序號：只讓最後一次請求寫入
let _bdgResult     = null;    // 最近一次 badgeCompute 的結果
let _bdgShopIdx    = null;    // shopId → data.json 那一列（ALL_DATA＋NON_ACTIVE_DATA，含歇業店）
let _bdgShopIdxN   = -1;
let _bdgMissedOpen = false;   // 面板「錯過的活動」展開中
let _bdgSheetKey   = null;    // 詳細資訊正在看的獎章
let _bdgNew        = new Set(); // 跳過慶祝視窗、還沒打開面板看的獎章 key（存這台裝置；任務鈕紅點＋面板 NEW）
let _bdgNewShown   = null;    // 這次打開面板要標 NEW 的 key（面板關掉前保留，重畫也不會消失）
let _bdgSeenReady  = false;   // 開站後的第一次比對已經等過壽星煙火、新手導覽
let _bdgSeenWait   = false;   // 正在等上面那個時機
let _bdgCompared   = false;   // 這次開網頁比對過了（之後跳的視窗都算自己操作觸發）
let _bdgPopup      = null;    // 慶祝視窗開著時的內容 { kind:'new'|'summary', items:[{ b, from }] }

const BDG_FEATURED_MAX = 6;

// ── 資料 ────────────────────────────────────────────────────────────────────
// 登入後由 auth.js 呼叫（踩點載入之後）；登出傳 null
function badgesSetUser(uid, data) {
  if ((uid || null) !== _bdgUid) { _bdgCounts = null; _bdgCountsSeq++; }
  _bdgUid = uid || null;
  _bdgUserData = data || {};
  _bdgNew = new Set(_bdgLoadNew());
  _bdgRenderNavDot();
}

function _bdgLoadConfig() {
  if (_bdgConfig) return Promise.resolve(_bdgConfig);
  if (!_bdgConfigLoad) {
    _bdgConfigLoad = db.collection('meta').doc('achievementConfig').get()
      .then(s => (s.exists ? s.data() : null))
      .catch(e => { console.warn('[badges] 設定讀取失敗，改用預設值', e); return null; })
      .then(remote => (_bdgConfig = badgeMergeConfig(remote)));
  }
  return _bdgConfigLoad;
}

// 評論數、菜單數只查到最高門檻為止（limit），超過也不會再升級；職人確認只有勾過「從業過」才查
function _bdgLoadCounts() {
  const uid = _bdgUid, seq = ++_bdgCountsSeq, cfg = _bdgConfig;
  let ok = true;   // 有一份讀取失敗就不比對新獎章（少算的會被記成沒拿到，之後又被當成新的跳出來）
  const maxOf = src => {
    const th = cfg.badges.filter(b => b.source === src).map(b => b.thresholds[b.thresholds.length - 1]);
    return th.length ? Math.max(...th) : 0;
  };
  const countOf = (col, n) => n
    ? db.collection(col).where('uid', '==', uid).limit(n).get().then(s => s.size)
        .catch(e => { ok = false; console.warn('[badges] ' + col + ' 計數失敗', e); return 0; })
    : Promise.resolve(0);
  const hasWork = Object.values(stampMap || {}).some(v => Number(v) === 20);
  const crafts = hasWork
    ? db.collection('craftsmanConfirmations').where('uid', '==', uid).get()
        .then(s => { const m = {}; s.forEach(d => { const x = d.data(); if (x.shopId) m[x.shopId] = x.status; }); return m; })
        .catch(e => { ok = false; console.warn('[badges] 職人確認讀取失敗', e); return {}; })
    : Promise.resolve({});
  return Promise.all([countOf('reviews', maxOf('reviews')), countOf('menus', maxOf('menus')), crafts])
    .then(([reviews, menus, cr]) => {
      if (seq !== _bdgCountsSeq || uid !== _bdgUid) return;   // 換帳號、或有更新的請求
      _bdgCounts = { reviews, menus, crafts: cr, ok };
    });
}

function _bdgShopOf(id) {
  const a = (typeof ALL_DATA !== 'undefined' && ALL_DATA) || [];
  const b = (typeof NON_ACTIVE_DATA !== 'undefined' && NON_ACTIVE_DATA) || [];
  if (!_bdgShopIdx || _bdgShopIdxN !== a.length + b.length) {
    _bdgShopIdx = new Map();
    a.concat(b).forEach(s => { if (s && s['ID']) _bdgShopIdx.set(s['ID'], s); });
    _bdgShopIdxN = a.length + b.length;
  }
  return _bdgShopIdx.get(id) || null;
}

function _bdgCompute() {
  const loggedIn = !!_bdgUid;
  const pending = {};
  if (loggedIn && typeof _chPendingTaskIds !== 'undefined' && _chPendingTaskIds) {
    _chPendingTaskIds.forEach(k => { pending[String(k).split('\u0000')[0]] = true; });   // key＝chKey(cid, tid)
  }
  _bdgResult = badgeCompute({
    config:     _bdgConfig,
    stamps:     loggedIn ? (stampMap || {}) : {},
    shopOf:     _bdgShopOf,
    challenges: (typeof _chChallenges !== 'undefined' && _chChallenges) || [],
    progress:   loggedIn ? ((typeof _chUserProgress !== 'undefined' && _chUserProgress) || {}) : {},
    pending,
    reviews:    _bdgCounts ? _bdgCounts.reviews : 0,
    menus:      _bdgCounts ? _bdgCounts.menus : 0,
    crafts:     _bdgCounts ? _bdgCounts.crafts : {},
  });
  return _bdgResult;
}

// 任務頁每次渲染（renderChallenges）與切到任務頁時呼叫。
// 設定或計數還沒到齊前不畫（避免先顯示 0 枚再跳成 N 枚）；opts.reload＝重查評論／菜單數（開面板時）
function badgesRefresh(opts) {
  const strip = document.getElementById('badgeStrip');
  if (!strip) return;
  if (!canView('badges')) { strip.style.display = 'none'; badgesClosePanel(); _bdgRenderNavDot(); return; }
  const reload = !!(opts && opts.reload);
  const ready = () => !!_bdgConfig && (!_bdgUid || !!_bdgCounts);
  if (ready()) _bdgRenderAll();
  if (!ready() || reload) {
    _bdgLoadConfig()
      .then(() => (_bdgUid ? _bdgLoadCounts() : null))
      .then(() => { if (ready()) _bdgRenderAll(); })
      .catch(e => console.warn('[badges] 載入失敗', e));
  }
}

function _bdgRenderAll() {
  _bdgCompute();
  _bdgRenderStrip();
  if (_bdgPanelOpen()) {
    _bdgRenderPanel();
    if (_bdgSheetKey) _bdgOpenDetail(_bdgSheetKey);
  }
  _bdgRenderNavDot();   // featureFlags 晚到時，登入當下藏起來的紅點要補回來
  _bdgCheckNew();
}

// ── 稱號、精選 ───────────────────────────────────────────────────────────────
// badgeTitle＝'<badgeKey>:<級數>'（key 本身可能含冒號，例 ch:2026summer，所以從最後一個冒號切）
function _bdgTitleOf() {
  const raw = String(_bdgUserData.badgeTitle || '');
  const i = raw.lastIndexOf(':');
  if (i < 0 || !_bdgResult) return null;
  const key = raw.slice(0, i), saved = parseInt(raw.slice(i + 1), 10) || 1;
  const b = _bdgResult.list.find(x => x.key === key && !x.hidden);
  if (!b || b.tier < 1) return null;
  const tier = Math.min(saved, b.tier);   // 門檻調高而掉級時，顯示目前的級
  return { b, tier, text: badgeTitleText(b, tier, _bdgConfig) };
}

// badgeFeatured 空＝自動挑（稀有度高、活動優先）；有存＝照會員選的順序，已經不符合的略過
function _bdgFeatured() {
  const earned = _bdgResult ? _bdgResult.list.filter(b => b.tier > 0 && !b.hidden) : [];
  const saved = Array.isArray(_bdgUserData.badgeFeatured) ? _bdgUserData.badgeFeatured : [];
  if (!saved.length) return { custom: false, items: badgeAutoFeatured(earned, BDG_FEATURED_MAX) };
  const byKey = new Map(earned.map(b => [b.key, b]));
  return { custom: true, items: saved.map(k => byKey.get(k)).filter(Boolean).slice(0, BDG_FEATURED_MAX) };
}

async function _bdgSaveUser(fields, okMsg) {
  if (!_bdgUid) return;
  try {
    await db.collection('users').doc(_bdgUid).update(fields);
    Object.assign(_bdgUserData, fields);
    showStampToast(okMsg);
  } catch (e) {
    console.error('[badges] 儲存失敗', e);
    showStampToast('儲存失敗，請稍後再試');
  }
  _bdgRenderStrip();
  if (_bdgPanelOpen()) _bdgRenderPanel();
  if (_bdgSheetKey) _bdgOpenDetail(_bdgSheetKey);
}

function _bdgSheetBadge() {
  return (_bdgResult && _bdgResult.list.find(x => x.key === _bdgSheetKey)) || null;
}

function _bdgToggleTitle() {
  const b = _bdgSheetBadge();
  if (!b || b.tier < 1) return;
  const cur = _bdgTitleOf();
  if (cur && cur.b.key === b.key) _bdgSaveUser({ badgeTitle: '' }, '已取消稱號');
  else _bdgSaveUser({ badgeTitle: b.key + ':' + b.tier }, '稱號：' + badgeTitleText(b, b.tier, _bdgConfig));
}

function _bdgToggleFeatured() {
  const b = _bdgSheetBadge();
  if (!b || b.tier < 1) return;
  const keys = _bdgFeatured().items.map(x => x.key);
  if (keys.includes(b.key)) {
    // 存空陣列＝回到自動挑選，會把這枚又挑回來，所以最後一枚不給移
    if (keys.length === 1) { showStampToast('精選至少要留一枚'); return; }
    _bdgSaveUser({ badgeFeatured: keys.filter(k => k !== b.key) }, '已移出精選');
  } else if (keys.length >= BDG_FEATURED_MAX) {
    showStampToast(`精選最多 ${BDG_FEATURED_MAX} 枚，請先移出一枚`);
  } else {
    _bdgSaveUser({ badgeFeatured: keys.concat(b.key) }, '已加入精選');
  }
}

// ── 新獎章：慶祝視窗、任務鈕紅點、面板 NEW（規格 §六「新獎章通知」）──────────
// 每次重算完跟 users.badgeSeen（已跳過視窗的級數）比；跳視窗時把目前級數寫回去，換裝置也不會重跳。
// NEW／紅點只是提示，存這台裝置（localStorage），打開面板就清掉

function _bdgNewStoreKey() { return 'bdgNew_' + _bdgUid; }

function _bdgLoadNew() {
  if (!_bdgUid) return [];
  try {
    const a = JSON.parse(localStorage.getItem(_bdgNewStoreKey()) || '[]');
    return Array.isArray(a) ? a.map(String) : [];
  } catch (e) { return []; }
}

function _bdgSaveNew() {
  if (!_bdgUid) return;
  try {
    if (_bdgNew.size) localStorage.setItem(_bdgNewStoreKey(), JSON.stringify([..._bdgNew]));
    else localStorage.removeItem(_bdgNewStoreKey());
  } catch (e) {}
}

function _bdgRenderNavDot() {
  const btn = document.getElementById('bnavChallenges');
  if (btn) btn.classList.toggle('has-badge', !!_bdgUid && _bdgNew.size > 0 && canView('badges') && canUse('badges'));
}

function _bdgEarnedList() {
  return _bdgResult ? _bdgResult.list.filter(b => b.tier > 0 && !b.hidden) : [];
}

// 資料到齊才比：設定、評論／菜單數、這個帳號的活動進度都讀成功，店家資料也載完（足跡縣市、台北踩點要查店）。
// 少算的獎章會被記成沒拿到，之後又被當成新的跳出來
function _bdgCanCompare() {
  return !!_bdgUid && !!_bdgResult && !!(_bdgCounts && _bdgCounts.ok)
    && typeof _chProgressUid !== 'undefined' && _chProgressUid === _bdgUid
    && typeof _dataLoaded !== 'undefined' && _dataLoaded
    && canView('badges') && canUse('badges');
}

// 開站的第一次比對排在壽星煙火和新手導覽之後（新手導覽開著就等它關掉）
function _bdgWaitIdle() {
  if (_bdgSeenWait) return;
  _bdgSeenWait = true;
  const done = () => { _bdgSeenWait = false; _bdgSeenReady = true; _bdgCheckNew(); };
  const afterOnboarding = () => setTimeout(() => {   // 新手導覽是同一輪 callback 才開的，先讓它開
    const ob = document.getElementById('onboardingModal');
    if (!ob || !ob.classList.contains('open')) { done(); return; }
    const mo = new MutationObserver(() => {
      if (ob.classList.contains('open')) return;
      mo.disconnect();
      done();
    });
    mo.observe(ob, { attributes: true, attributeFilter: ['class'] });
  }, 300);
  if (typeof _onDataLoaded === 'function' && typeof _onBdAnimDone === 'function') _onDataLoaded(() => _onBdAnimDone(afterOnboarding));
  else afterOnboarding();
}

function _bdgCheckNew() {
  if (!_bdgCanCompare()) return;
  if (!_bdgSeenReady) { _bdgWaitIdle(); return; }
  const trigger = _bdgCompared ? 'action' : 'load';
  _bdgCompared = true;
  const raw = _bdgUserData.badgeSeen;
  const first = !(raw && typeof raw === 'object' && !Array.isArray(raw));   // 沒有紀錄＝第一次用（上線當天）
  const { items, seen } = badgeNewSince(_bdgResult.list, first ? {} : raw);

  // NEW 只留目前還拿著的（門檻調高掉到 0 級的拿掉）
  const held = new Set(_bdgEarnedList().map(b => b.key));
  const before = _bdgNew.size;
  _bdgNew.forEach(k => { if (!held.has(k)) _bdgNew.delete(k); });
  if (_bdgNew.size !== before) { _bdgSaveNew(); _bdgRenderNavDot(); }

  if (!first && !items.length) return;
  _bdgWriteSeen(seen);   // 第一次而且 0 枚也記一筆空的，之後拿到第一枚才會跳「獲得新獎章」
  if (first) {
    if (items.length) _bdgShowPopup('summary', [], trigger);   // 只跳一次總結，不一枚一枚跳、也不標 NEW
    return;
  }
  if (_bdgPanelOpen()) {   // 面板開著：直接在面板上標 NEW
    _bdgNewShown = _bdgNewShown || new Set();
    items.forEach(x => _bdgNewShown.add(x.b.key));
    _bdgRenderPanel();
  } else {
    items.forEach(x => _bdgNew.add(x.b.key));
    _bdgSaveNew();
    _bdgRenderNavDot();
  }
  _bdgShowPopup('new', items, trigger);
}

function _bdgWriteSeen(seen) {
  _bdgUserData.badgeSeen = seen;   // 先改本地：寫入失敗也不會在這次又跳
  db.collection('users').doc(_bdgUid).update({ badgeSeen: seen })
    .catch(e => console.warn('[badges] badgeSeen 寫入失敗', e));
}

// 自己操作達標當場跳（規格 §六）：踩點（stamps.js）、評論（reviews.js）、上傳菜單（menus.js）成功後呼叫。
// 評論、菜單要重查張數；踩點已經在 stampMap 裡，直接重算
function badgesOnAction(kind) {
  if (!_bdgUid || !canView('badges')) return;
  badgesRefresh({ reload: kind === 'review' || kind === 'menu' });
}

function _bdgPopupOpen() {
  const p = document.getElementById('badgePopup');
  return !!(p && p.classList.contains('open'));
}

function _bdgEnsurePopup() {
  if (document.getElementById('badgePopup')) return;
  const el = document.createElement('div');
  el.id = 'badgePopup';
  el.className = 'bdg-pop';
  el.innerHTML = '<div class="bdg-pop-card" role="dialog" aria-modal="true" aria-labelledby="badgePopupTitle"></div>';
  document.body.appendChild(el);
  el.addEventListener('click', e => {
    if (e.target === el) { _bdgClosePopup(); return; }   // 點視窗外面的暗區
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'pop-open') { _bdgClosePopup(); badgesOpenPanel('popup'); }
    else if (act.dataset.act === 'pop-close') _bdgClosePopup();
  });
}

// kind：'new'（items＝新拿到或升級的）／'summary'（第一次用：你已經有 N 枚）。
// 視窗還開著又拿到新的就併進同一個視窗（同一枚取新的級數，from 取較低的）
function _bdgShowPopup(kind, items, trigger) {
  _bdgEnsurePopup();
  const wasOpen = _bdgPopupOpen() && !!_bdgPopup;
  if (kind === 'summary' || (wasOpen && _bdgPopup.kind === 'summary')) {
    _bdgPopup = { kind: 'summary', items: [] };
  } else {
    const byKey = new Map(wasOpen ? _bdgPopup.items.map(x => [x.b.key, x]) : []);
    items.forEach(x => {
      const o = byKey.get(x.b.key);
      byKey.set(x.b.key, o ? { b: x.b, from: Math.min(o.from, x.from) } : x);
    });
    _bdgPopup = { kind: 'new', items: [...byKey.values()] };
  }
  const pop = document.getElementById('badgePopup');
  pop.querySelector('.bdg-pop-card').innerHTML = _bdgPopupHtml(_bdgPopup);
  if (wasOpen) return;
  pop.classList.add('open');
  if (typeof gtag !== 'undefined') {
    gtag('event', 'badge_popup_show', {
      kind: _bdgPopup.kind,
      count: _bdgPopup.kind === 'summary' ? _bdgEarnedList().length : _bdgPopup.items.length,
      trigger,
    });
  }
}

function _bdgClosePopup() {
  const p = document.getElementById('badgePopup');
  if (p) p.classList.remove('open');
  _bdgPopup = null;
}

// 視窗上那一行：這一級是怎麼拿到的
const BDG_EARN_TEXT = {
  stamps:    n => `踩點 ${n} 間`,
  cities:    n => `足跡 ${n} 個縣市`,
  events:    n => `參加 ${n} 檔活動`,
  menus:     n => `上傳 ${n} 張菜單`,
  reviews:   n => `寫了 ${n} 篇評論`,
  craftsman: () => '標記「從業過」的店家',
};

function _bdgEarnLine(b) {
  const th = b.thresholds[b.tier - 1];
  if (b.kind === 'craft') return '經協會確認';
  if (b.kind === 'event') return b.thresholds.length > 1 ? `完成 ${th} ${b.unit}` : '活動參加獎章';
  const f = BDG_EARN_TEXT[b.source];
  return f ? f(th) : `達成 ${th} ${b.unit || ''}`;
}

function _bdgPopupHtml(p) {
  const cfg = _bdgConfig, lv = _bdgResult.level;
  const coinsRow = arr => `<div class="bdg-pop-coins${arr.length > 4 ? ' g3' : ''}">${arr.join('')}</div>`;
  const btns = `<div class="bdg-pop-actions">` +
    `<button type="button" class="bdg-btn on" data-act="pop-open">查看獎章</button>` +
    `<button type="button" class="bdg-btn" data-act="pop-close">關閉</button></div>`;
  if (p.kind === 'summary') {
    const earned = _bdgEarnedList();
    const coins = badgeAutoFeatured(earned, BDG_FEATURED_MAX).map(b => _bdgCoin(b, 52));
    return `<div class="bdg-pop-title" id="badgePopupTitle">🎖️ 你已經有 ${earned.length} 枚獎章</div>` +
      coinsRow(coins) +
      `<div class="bdg-pop-lv">會員等級<span class="bdg-lv">Lv.${lv}</span></div>` +
      `<div class="bdg-pop-sub">之後拿到新獎章或升級，會在這裡通知你</div>` + btns;
  }
  // 稀有度高的排前面，同級時活動優先（同精選）
  const items = p.items.slice().sort((x, y) => (y.b.tier - x.b.tier) || ((y.b.activity ? 1 : 0) - (x.b.activity ? 1 : 0)));
  const gain = items.reduce((s, x) => s + x.b.points - badgePointsAt(x.b, x.from, cfg), 0);
  const lvLine = `<div class="bdg-pop-lv">` + (gain > 0
    ? `<span class="bdg-lv">Lv.${lv - gain}</span> → <span class="bdg-lv">Lv.${lv}</span>`
    : `<span class="bdg-lv">Lv.${lv}</span>`) + `</div>`;
  if (items.length === 1) {
    const { b, from } = items[0];
    return `<div class="bdg-pop-title" id="badgePopupTitle">${from > 0 ? '⬆️ 獎章升級' : '🎉 獲得新獎章'}</div>` +
      `<div class="bdg-pop-hero">${_bdgCoin(b, 96)}</div>` +
      `<div class="bdg-pop-name">${escapeHtml(badgeTitleText(b, b.tier, cfg))}</div>` +
      `<div class="bdg-pop-sub">${escapeHtml(_bdgEarnLine(b))}</div>` + lvLine + btns;
  }
  const shown = items.slice(0, BDG_FEATURED_MAX);
  const more = items.length - shown.length;
  return `<div class="bdg-pop-title" id="badgePopupTitle">🎉 獲得 ${items.length} 枚獎章</div>` +
    coinsRow(shown.map(x => _bdgCoin(x.b, 56))) +
    `<div class="bdg-pop-sub">${escapeHtml(shown.map(x => badgeTitleText(x.b, x.b.tier, cfg)).join('、'))}${more > 0 ? `，還有 ${more} 枚` : ''}</div>` +
    lvLine + btns;
}

// ── 畫面零件 ────────────────────────────────────────────────────────────────
const _bdgT = t => Math.max(0, Math.min(5, t | 0));   // 外框樣式只有 t0～t5

// 獎章圓章：外框依級數（t0＝灰階無框、t1 銅…t5 鑽石），中間放圖（活動封面／店徽）、店名文字或 emoji。
// 圖讀不到就藏起來，露出底下的 emoji
function _bdgCoin(b, size) {
  const cls = size >= 80 ? 'lg' : size >= 50 ? 'md' : 'sm';
  const inner = b.text
    ? `<span class="bdg-coin-text">${escapeHtml(b.text)}</span>`
    : `<span class="bdg-coin-emoji">${escapeHtml(b.icon || '🏅')}</span>`;
  const img = b.image ? `<img src="${escapeHtml(b.image)}" alt="" loading="lazy" onerror="this.style.display='none'">` : '';
  return `<span class="bdg-coin ${cls} t${_bdgT(b.tier)}" style="width:${size}px;height:${size}px">` +
    `<span class="bdg-coin-core">${inner}${img}</span></span>`;
}

function _bdgTierTag(tier) {
  return `<b class="bdg-tn t${_bdgT(tier)}">${escapeHtml(badgeTierName(_bdgConfig, tier))}</b>`;
}

function _bdgTile(b) {
  let prog;
  if (b.kind === 'event' && b.tier === 0) {
    prog = b.pending ? '<span class="bdg-pend">審核中</span>'
         : b.status === 'ended' ? '已結束'
         : b.thresholds[0] === 1 ? '參加就拿到'
         : `${b.value}/${b.thresholds[0]}`;
  } else if (b.tier === 0) {
    prog = `${b.value}/${b.thresholds[0]}`;
  } else if (b.thresholds.length === 1) {
    prog = '已取得';
  } else if (b.tier >= b.thresholds.length) {
    prog = `${_bdgTierTag(b.tier)} 最高級`;
  } else {
    prog = `${_bdgTierTag(b.tier)} ${b.value}/${b.thresholds[b.tier]}`;
  }
  const isNew = !!(_bdgNewShown && _bdgNewShown.has(b.key));
  return `<div class="bdg-tile" data-key="${escapeHtml(b.key)}">${isNew ? '<span class="bdg-new">NEW</span>' : ''}${_bdgCoin(b, 64)}` +
    `<div class="bdg-tile-name">${escapeHtml(b.name)}</div><div class="bdg-tile-prog">${prog}</div></div>`;
}

// ── 入口橫幅（任務頁標題下方）──────────────────────────────────────────────
// 三種狀態：沒登入（範例獎章＋登入提示）／0 枚（推進行中的活動或第一篇評論）／已有獎章（精選＋下一檔活動灰階預告）
function _bdgRenderStrip() {
  const strip = document.getElementById('badgeStrip');
  if (!strip || !_bdgResult) return;
  const visible = _bdgResult.list.filter(b => !b.hidden);
  const earned = visible.filter(b => b.tier > 0);
  const nextEvent = visible.find(b => b.kind === 'event' && b.status === 'active' && b.tier === 0);
  let coins, title = '🎖️ 我的獎章', sub;
  if (!_bdgUid) {
    const samples = _bdgConfig.badges.filter(d => d.source !== 'craftsman').slice(0, 4);
    coins = samples.map((d, i) => _bdgCoin({ icon: d.icon, image: d.image, tier: 4 - i }, 30)).join('');
    title = '🎖️ 拉麵獎章';
    sub = '登入就能開始收集拉麵獎章';
  } else if (!earned.length) {
    const hint = nextEvent || visible.find(b => b.source === 'reviews');
    coins = hint ? _bdgCoin(hint, 30) : '';
    sub = nextEvent ? `參加「${nextEvent.name}」拿第一枚獎章` : '寫第一篇評論，拿第一枚獎章';
  } else {
    const shown = _bdgFeatured().items.slice(0, nextEvent ? 3 : 4);
    coins = shown.map(b => _bdgCoin(b, 30)).join('') + (nextEvent ? _bdgCoin(nextEvent, 30) : '');
    title += `<span class="bdg-lv">Lv.${_bdgResult.level}</span>`;
    sub = `已收集 ${earned.length} 枚` + (nextEvent ? `｜${nextEvent.name} 開放中` : '');
  }
  strip.innerHTML = `<span class="bdg-strip-coins">${coins}</span>` +
    `<span class="bdg-strip-text"><span class="bdg-strip-title">${title}</span>` +
    `<span class="bdg-strip-sub">${escapeHtml(sub)}</span></span><span class="bdg-strip-arrow">›</span>`;
  strip.classList.toggle('ff-locked', !!_bdgUid && !canUse('badges'));
  strip.style.display = '';
}

document.getElementById('badgeStrip')?.addEventListener('click', () => {
  if (!auth.currentUser) { openPrivacyModal(); return; }
  if (!canUse('badges')) { showAccessToast(); return; }
  badgesOpenPanel();
});

// ── 全螢幕獎章面板 ───────────────────────────────────────────────────────────
function _bdgPanelOpen() {
  const p = document.getElementById('badgePanel');
  return !!(p && p.classList.contains('open'));
}

function _bdgEnsurePanel() {
  if (document.getElementById('badgePanel')) return;
  const el = document.createElement('div');
  el.id = 'badgePanel';
  el.className = 'bdg-panel';
  el.innerHTML = `
    <div class="bdg-panel-inner">
      <div class="bdg-head">
        <button type="button" class="bdg-back" data-act="close" aria-label="返回">‹</button>
        <span class="bdg-head-title">🎖️ 我的獎章</span>
      </div>
      <div id="badgePanelBody"></div>
    </div>
    <div class="bdg-sheet-backdrop" id="badgeSheet"><div class="bdg-sheet" id="badgeSheetBody"></div></div>`;
  document.body.appendChild(el);
  el.addEventListener('click', _bdgOnPanelClick);
}

// source：從哪裡打開（strip 橫幅／popup 慶祝視窗），GA4 停損看「每週打開面板人數」
function badgesOpenPanel(source) {
  if (!_bdgResult) return;
  _bdgEnsurePanel();
  const wasOpen = _bdgPanelOpen();
  // NEW 在這次打開時標出來（關掉前都保留）；紅點和這台裝置的紀錄現在就清掉
  _bdgNewShown = new Set([...((wasOpen && _bdgNewShown) || []), ..._bdgNew]);
  if (_bdgNew.size) { _bdgNew.clear(); _bdgSaveNew(); _bdgRenderNavDot(); }
  document.getElementById('badgePanel').classList.add('open');
  document.body.classList.add('bdg-open');   // 讓 #stampToast 浮在面板上面
  _bdgRenderPanel();
  badgesRefresh({ reload: true });            // 重查評論／菜單數：剛寫完評論回來就看得到
  if (!wasOpen && typeof gtag !== 'undefined') gtag('event', 'badge_panel_open', { source: source || 'strip' });
}

function badgesClosePanel() {
  const p = document.getElementById('badgePanel');
  if (!p) return;
  _bdgCloseDetail();
  p.classList.remove('open');
  document.body.classList.remove('bdg-open');
  _bdgNewShown = null;
}

function _bdgRenderPanel() {
  const body = document.getElementById('badgePanelBody');
  if (!body || !_bdgResult) return;
  const cfg = _bdgConfig;
  const all = _bdgResult.list.filter(b => !b.hidden && !(b.hideUntilEarned && b.tier === 0));
  const ev = all.filter(b => b.kind === 'event');
  const activeEv = ev.filter(b => b.status === 'active');
  const endedEv  = ev.filter(b => b.status === 'ended' && (b.tier > 0 || b.pending));
  const missed   = ev.filter(b => b.status === 'ended' && b.tier === 0 && !b.pending);
  const actFixed = all.filter(b => b.kind === 'fixed' && b.activity);
  const passive  = all.filter(b => b.kind === 'fixed' && !b.activity && b.source !== 'craftsman');
  const craft    = all.filter(b => b.source === 'craftsman');
  const earnedN  = all.filter(b => b.tier > 0).length;
  const title = _bdgTitleOf();
  const feat = _bdgFeatured();
  const grid = arr => `<div class="bdg-grid">${arr.map(_bdgTile).join('')}</div>`;
  const sec = (label, arr) => (arr.length ? `<div class="bdg-sec">${label}</div>${grid(arr)}` : '');
  const avatar = _bdgUserData.avatarUrl || 'assets/icons/03.png';   // 同分享圖卡：不用 Google 大頭照
  const featHtml = feat.items.length
    ? feat.items.map(b => `<span class="bdg-feat-item" data-key="${escapeHtml(b.key)}">${_bdgCoin(b, 40)}</span>`).join('')
    : '<span class="bdg-feat-empty">拿到獎章後會出現在這裡</span>';
  body.innerHTML = `
    <div class="bdg-profile">
      <div class="bdg-profile-top">
        <img class="bdg-avatar" src="${escapeHtml(avatar)}" alt="" onerror="this.onerror=null;this.src='assets/icons/03.png'">
        <div class="bdg-profile-main">
          <div class="bdg-profile-name">${escapeHtml(currentDisplayName || '')}<span class="bdg-lv">Lv.${_bdgResult.level}</span></div>
          <div class="bdg-profile-sub">稱號：${title ? `<b>${escapeHtml(title.text)}</b>` : '未設定（點獎章設定）'}｜已收集 ${earnedN} 枚</div>
        </div>
      </div>
      <div class="bdg-feat">
        <div class="bdg-feat-head"><span>精選 ${BDG_FEATURED_MAX} 枚（分享圖卡用）</span>${feat.custom ? '<a data-act="feat-reset">恢復自動挑選</a>' : '<span>自動挑選</span>'}</div>
        <div class="bdg-feat-row">${featHtml}</div>
      </div>
    </div>
    ${sec('🚩 進行中的活動', activeEv)}
    ${sec('🏅 活動獎章', endedEv.concat(actFixed))}
    ${sec('🍜 累積獎章', passive)}
    ${sec('👨‍🍳 職人', craft)}
    ${missed.length ? `<button type="button" class="bdg-missed" data-act="missed">${_bdgMissedOpen ? '▾' : '▸'} 錯過的活動（${missed.length}）</button>${_bdgMissedOpen ? grid(missed) : ''}` : ''}
    <div class="bdg-foot">Lv＝所有獎章點數加總（${cfg.tiers.map(t => escapeHtml(t.name) + ' ' + t.points).join('・')}；活動獎章 ×${cfg.activityMultiplier}）</div>`;
}

// ── 詳細資訊（點獎章）────────────────────────────────────────────────────────
function _bdgDetailHtml(b) {
  const cfg = _bdgConfig;
  const u = b.unit ? ' ' + b.unit : '';
  const maxTier = b.thresholds.length;
  const custom = b.tier > 0 ? (b.tierNames || [])[b.tier - 1] : '';
  const head = b.tier === 0 ? '未取得'
    : maxTier === 1 ? '已取得'
    : _bdgTierTag(b.tier) + (custom ? `「${escapeHtml(custom)}」` : '');
  const nextName = badgeTierName(cfg, b.tier + 1);

  let prog = '';
  if (b.kind === 'event' && b.tier === 0) {
    prog = b.pending ? '有投稿在審核中，通過後就會拿到'
         : b.status === 'ended' ? '活動已結束'
         : b.thresholds[0] === 1 ? (b.countBy === 'shop' ? '完成任一間店就拿到' : '完成任一項任務就拿到')
         : `完成 ${b.thresholds[0]}${u}就拿到（目前 ${b.value}${u}）`;
  } else if (b.kind !== 'craft' && b.tier < maxTier) {
    prog = `目前 ${b.value}${u}，再 ${b.thresholds[b.tier] - b.value}${u}${b.tier === 0 ? '就拿到' : '升' + escapeHtml(nextName)}`;
  } else if (maxTier > 1) {
    prog = `已達最高級（${b.value}${u}）`;
  }

  const notes = [];
  if (b.kind === 'event') {
    const p = b.period || {};
    if (p.start && p.end) notes.push(`活動期間 ${escapeHtml(p.start)} ～ ${escapeHtml(p.end)}`);
    if (b.countBy === 'shop' && maxTier > 1) notes.push('以不重複店家計算');
  }
  if (b.kind === 'fixed' && b.source === 'craftsman' && (b.shops || []).length) {
    const names = b.shops.map(id => { const s = _bdgShopOf(id); return (s && s['店名']) || id; });
    notes.push(`你標記「從業過」的店家（只有你看得到）：${escapeHtml(names.join('、'))}`);
    notes.push('經協會確認後，會另外出現「曾於〇〇服務」獎章');
  }
  if (b.kind === 'craft') notes.push('經協會確認');
  if (b.tier > 0) notes.push(`點數 +${b.points}` + (b.activity ? `（活動獎章 ×${cfg.activityMultiplier}）` : ''));

  const ladder = maxTier > 1 ? `<div class="bdg-ladder">${b.thresholds.map((th, i) => {
    const t = i + 1, name = (b.tierNames || [])[i];
    return `<div class="bdg-ladder-row${b.tier >= t ? ' got' : ''}"><span>${_bdgTierTag(t)}</span>` +
      `<span>${th}${escapeHtml(u)}${name ? `｜「${escapeHtml(name)}」` : ''}</span><span>${b.tier >= t ? '✓' : ''}</span></div>`;
  }).join('')}</div>` : '';

  let actions = '';
  if (b.tier > 0) {
    const cur = _bdgTitleOf();
    const isTitle = !!(cur && cur.b.key === b.key);
    const inFeat = _bdgFeatured().items.some(x => x.key === b.key);
    actions = `<div class="bdg-sheet-actions">` +
      `<button type="button" class="bdg-btn${isTitle ? ' on' : ''}" data-act="title">${isTitle ? '取消稱號' : '設為稱號'}</button>` +
      `<button type="button" class="bdg-btn${inFeat ? ' on' : ''}" data-act="feat">${inFeat ? '移出精選' : '加入精選'}</button></div>`;
  }

  return `<button type="button" class="bdg-sheet-close" data-act="sheet-close" aria-label="關閉">✕</button>` +
    _bdgCoin(b, 96) +
    `<div class="bdg-sheet-name">${escapeHtml(b.name)}</div>` +
    `<div class="bdg-sheet-tier">${head}</div>` +
    (prog ? `<div class="bdg-sheet-line">${prog}</div>` : '') +
    notes.map(n => `<div class="bdg-sheet-note">${n}</div>`).join('') +
    ladder + actions;
}

function _bdgOpenDetail(key) {
  const b = _bdgResult && _bdgResult.list.find(x => x.key === key && !x.hidden);
  if (!b) { _bdgCloseDetail(); return; }
  _bdgSheetKey = key;
  document.getElementById('badgeSheetBody').innerHTML = _bdgDetailHtml(b);
  document.getElementById('badgeSheet').classList.add('open');
}

function _bdgCloseDetail() {
  _bdgSheetKey = null;
  const s = document.getElementById('badgeSheet');
  if (s) s.classList.remove('open');
}

function _bdgOnPanelClick(e) {
  const t = e.target;
  if (t.id === 'badgePanel') { badgesClosePanel(); return; }   // 桌機：點面板兩側的暗區
  if (t.id === 'badgeSheet') { _bdgCloseDetail(); return; }    // 點詳細資訊外面的暗區
  const act = t.closest('[data-act]');
  if (act) {
    switch (act.dataset.act) {
      case 'close':       badgesClosePanel(); break;
      case 'sheet-close': _bdgCloseDetail(); break;
      case 'missed':      _bdgMissedOpen = !_bdgMissedOpen; _bdgRenderPanel(); break;
      case 'feat-reset':  _bdgSaveUser({ badgeFeatured: [] }, '已恢復自動挑選'); break;
      case 'title':       _bdgToggleTitle(); break;
      case 'feat':        _bdgToggleFeatured(); break;
    }
    return;
  }
  const tile = t.closest('[data-key]');
  if (tile) _bdgOpenDetail(tile.dataset.key);
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (_bdgPopupOpen()) { _bdgClosePopup(); return; }
  if (!_bdgPanelOpen()) return;
  if (_bdgSheetKey) _bdgCloseDetail();
  else badgesClosePanel();
});
