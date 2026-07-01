// ── challenges.js ────────────────────────────────────────────────────────────
// 挑戰任務系統：列表渲染、送出 modal、進度追蹤
// 依賴全域變數（finder.html 提供）：
//   db, auth, firebase, storage, ALL_DATA, currentUserRole
// 依賴全域函式：
//   findShopById, escapeHtml, compressImage, showStampToast, canUse, haversineDistance
// 依賴外部資源：
//   exifr（CDN 載入；讀取照片 EXIF 拍攝時間）
// 提供全域變數：
//   _chPageLoaded（switchPage 用，避免重複載入）
// 提供全域函式：
//   loadChallengesPage, openChSubmitModal, closeChSubmitModal

// ── 狀態 ────────────────────────────────────────────────────────────────────
var _chChallenges       = [];     // 進行中的挑戰列表
var _chUserProgress     = {};     // {challengeId: {completedTaskIds: [...]}}
var _chPageLoaded       = false;  // 頁面是否已載入
let _chCurrentChallenge = null;
let _chCurrentFile      = null;
let _chCurrentShop      = null;
let _chCurrentTask      = null;      // 點圖鑑格開送出 modal 時記住的 task（供 submission 記 taskId）
let _chPendingTaskIds   = new Set(); // 本人有 pending submission 的 taskId（顯示「審查中」）
let _chRejectedTaskIds  = new Set(); // 本人有 rejected submission 的 taskId（顯示「已駁回」）

// ── 條件比對：計算這筆 submission 自動完成哪些 task ───────────────────────
function chComputeAutoTaskIds(submission, challenge) {
  const matched = [];
  for (const group of (challenge.groups || [])) {
    for (const task of (group.tasks || [])) {
      const cond = task.condition || {};
      if (!cond.field) continue;
      // 客觀條件：shopId / shopCity 等可自動判斷
      // 主觀條件（如 soupBase）→ requiresReview=true，不在這裡 match
      if (task.requiresReview) continue;
      // scanShop 型：靠店家掃描驗證（challengeCheckins），不由自助上傳 auto-match
      if (cond.field === 'scanShop') continue;
      if (submission[cond.field] === cond.value) matched.push(task.id);
    }
  }
  return matched;
}

// ── 時間驗證 ───────────────────────────────────────────────────────────────
function chValidateTime(diningDate, challenge, task) {
  // 1. 必須在挑戰期間內
  const start = challenge.period?.start ? new Date(challenge.period.start + 'T00:00:00') : null;
  const end   = challenge.period?.end   ? new Date(challenge.period.end   + 'T23:59:59') : null;
  if (start && diningDate < start) return '用餐時間早於挑戰開始日';
  if (end && diningDate > end)     return '用餐時間晚於挑戰結束日';

  // 2. 若 task 有 timeWindow，diningDate 必須在 window 內，且 createdAt（now）不超過 window.end + 1 天
  if (task && task.timeWindow) {
    const ws = new Date(task.timeWindow.start + 'T00:00:00');
    const we = new Date(task.timeWindow.end   + 'T23:59:59');
    if (diningDate < ws || diningDate > we) return `不在指定時間區間（${task.timeWindow.start}~${task.timeWindow.end}）`;
    const now = new Date();
    const deadline = new Date(we.getTime() + 24 * 60 * 60 * 1000);
    if (now > deadline) return '已過上傳期限（最晚為 window.end 的隔天）';
  }
  return null;
}

// ── 載入挑戰列表 ───────────────────────────────────────────────────────────
async function loadChallengesPage() {
  const list = document.getElementById('challengesList');
  if (!list) return;
  if (!auth.currentUser) {
    list.innerHTML = '<p class="ch-empty">請先登入</p>';
    return;
  }
  list.innerHTML = '<p class="ch-empty">載入中…</p>';

  try {
    const snap = await db.collection('challenges').where('status', '==', 'active').get();
    _chChallenges = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // 載入每個挑戰的使用者進度
    _chUserProgress = {};
    const uid = auth.currentUser.uid;
    await Promise.all(_chChallenges.map(async c => {
      try {
        const ref = db.collection('userChallengeProgress').doc(uid).collection('challenges').doc(c.id);
        const doc = await ref.get();
        _chUserProgress[c.id] = doc.exists ? doc.data() : { completedTaskIds: [] };
      } catch (e) {
        _chUserProgress[c.id] = { completedTaskIds: [] };
      }
    }));

    // 附加：店家掃描驗證（challengeCheckins）union 進 completedTaskIds
    // （不動審查路徑；壞了現有審查進度照常顯示）
    try {
      const ckSnap = await db.collection('challengeCheckins').where('uid', '==', uid).get();
      ckSnap.docs.forEach(d => {
        const ck = d.data();
        if (!ck.challengeId || !ck.taskId) return;
        const prog = _chUserProgress[ck.challengeId];
        if (!prog) return;
        if (!prog.completedTaskIds) prog.completedTaskIds = [];
        if (!prog.completedTaskIds.includes(ck.taskId)) prog.completedTaskIds.push(ck.taskId);
      });
    } catch (e) { console.warn('[challenges] checkins 聯集失敗（不影響審查進度）', e); }

    // 附加：客人自助尋寶（questCheckins）union 進 completedTaskIds（情境2）
    try {
      const qSnap = await db.collection('questCheckins').where('uid', '==', uid).get();
      qSnap.docs.forEach(d => {
        const q = d.data();
        if (!q.challengeId || !q.taskId) return;
        const prog = _chUserProgress[q.challengeId];
        if (!prog) return;
        if (!prog.completedTaskIds) prog.completedTaskIds = [];
        if (!prog.completedTaskIds.includes(q.taskId)) prog.completedTaskIds.push(q.taskId);
      });
    } catch (e) { console.warn('[challenges] questCheckins 聯集失敗', e); }

    // 附加：載入本人 submission → 標記「審查中」(pending) / 「已駁回」(rejected) 的 task
    _chPendingTaskIds  = new Set();
    _chRejectedTaskIds = new Set();
    try {
      const subSnap = await db.collection('challengeSubmissions').where('uid', '==', uid).get();
      subSnap.docs.forEach(d => {
        const s = d.data();
        const ids = [];
        if (s.taskId) ids.push(s.taskId);
        (s.autoTaskIds || []).forEach(tid => ids.push(tid));
        if (s.status === 'pending')       ids.forEach(tid => _chPendingTaskIds.add(tid));
        else if (s.status === 'rejected') ids.forEach(tid => _chRejectedTaskIds.add(tid));
      });
    } catch (e) { console.warn('[challenges] submission 狀態載入失敗', e); }

    renderChallenges();
    _chPageLoaded = true;
  } catch (e) {
    console.error('[challenges] loadChallengesPage 失敗', e);
    list.innerHTML = `<p class="ch-empty">載入失敗：${escapeHtml(e.message)}</p>`;
  }
}

// ── 渲染挑戰列表 ───────────────────────────────────────────────────────────
function renderChallenges() {
  const list = document.getElementById('challengesList');
  if (!list) return;
  // reveal 過濾：discover（掃到才解鎖）僅在玩家於該活動有進度時顯示；announced 一律顯示
  const visible = _chChallenges.filter(ch => {
    if (ch.reveal === 'discover') {
      return ((_chUserProgress[ch.id]?.completedTaskIds) || []).length > 0;
    }
    return true;
  });
  if (!visible.length) {
    list.innerHTML = '<p class="ch-empty">目前沒有進行中的挑戰</p>';
    return;
  }
  list.innerHTML = visible.map(ch => renderChallengeCard(ch)).join('');

  // 綁定送出按鈕
  list.querySelectorAll('.ch-submit-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openChSubmitModal(btn.dataset.challengeId); });
  });
  // 綁定圖鑑格點擊：拍照型開送出 modal 並預填；quest / scanShop 顯示提示（quest 已完成則揭示下一站線索）
  list.querySelectorAll('.ch-dex-card').forEach(card => {
    card.addEventListener('click', e => {
      e.stopPropagation();
      const { cid, tid, field } = card.dataset;
      const ch   = _chChallenges.find(c => c.id === cid);
      const task = ch && (ch.groups || []).flatMap(g => g.tasks || []).find(t => t.id === tid);
      if (field === 'quest') {
        if (card.classList.contains('done') && task && task.hint && task.hint.text) showStampToast('🧭 ' + task.hint.text);
        else showStampToast('掃描店家立牌即可完成此關卡');
        return;
      }
      if (field === 'scanShop') { showStampToast('請由店家掃描你的會員卡完成'); return; }
      openChSubmitModal(cid, task);
    });
  });
  // 綁定卡片展開（點 header 切換）
  list.querySelectorAll('.ch-toggle').forEach(h => {
    h.addEventListener('click', () => h.closest('.ch-card')?.classList.toggle('expanded'));
  });
}

// 環狀順序：找「下一個該掃的 quest task」= frontier（已完成但環後繼未完成）的環後繼
function chNextQuestTask(ring, doneSet) {
  for (let i = 0; i < ring.length; i++) {
    const next = ring[(i + 1) % ring.length];
    if (doneSet.has(ring[i].id) && !doneSet.has(next.id)) return next;
  }
  return null;
}

function renderChallengeCard(challenge) {
  const completed  = (_chUserProgress[challenge.id]?.completedTaskIds) || [];
  const allTasks   = (challenge.groups || []).flatMap(g => g.tasks || []);
  const totalTasks = allTasks.length;
  const doneTasks  = allTasks.filter(t => completed.includes(t.id)).length;
  const pct        = totalTasks ? Math.round(doneTasks / totalTasks * 100) : 0;

  const period    = challenge.period || {};
  const periodStr = period.start && period.end ? `${period.start} ~ ${period.end}` : '';

  // quest 尋寶「下一站」提示（環狀）
  const questTasks = allTasks
    .filter(t => t.condition && t.condition.field === 'quest')
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  let nextHtml = '';
  if (questTasks.length) {
    const doneSet = new Set(completed);
    if (questTasks.every(t => doneSet.has(t.id))) {
      nextHtml = `<div class="ch-next done">🎉 已完成整圈尋寶！</div>`;
    } else if (doneSet.size === 0) {
      nextHtml = `<div class="ch-next">🧭 掃描任一店家立牌，開始尋寶</div>`;
    } else {
      const next = chNextQuestTask(questTasks, doneSet);
      const ei   = next ? questTasks.findIndex(t => t.id === next.id) : -1;
      const frontier = ei >= 0 ? questTasks[(ei - 1 + questTasks.length) % questTasks.length] : null;
      const hint = (frontier && doneSet.has(frontier.id) && frontier.hint?.text) ? frontier.hint.text : '';
      nextHtml = `<div class="ch-next">🧭 ${hint ? escapeHtml(hint) : '下一站：依現場提示前往'}</div>`;
    }
  }

  // 是否有需「拍照送出」的任務（quest / scanShop 不需自助上傳）
  const hasUploadTask = allTasks.some(t => {
    const f = t.condition && t.condition.field;
    return f && f !== 'quest' && f !== 'scanShop';
  });

  return `
    <div class="ch-card">
      ${challenge.image ? `<img class="ch-cover" src="${escapeHtml(challenge.image)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
      <div class="ch-card-header ch-toggle">
        <div class="ch-title">${escapeHtml(challenge.title || '')}</div>
        ${periodStr ? `<div class="ch-period">📅 ${escapeHtml(periodStr)}</div>` : ''}
        <span class="ch-chevron" aria-hidden="true"></span>
      </div>
      <div class="ch-progress-row">
        <div class="ch-progress-bar"><div class="ch-progress-fill" style="width:${pct}%"></div></div>
        <span class="ch-progress-text">${doneTasks}/${totalTasks}　${pct}%</span>
      </div>
      ${nextHtml}
      <div class="ch-detail">
        <div class="ch-detail-inner">
          <div class="ch-groups">
            ${(challenge.groups || []).map(g => renderGroup(g, completed, challenge)).join('')}
          </div>
          ${hasUploadTask ? `<button class="ch-submit-btn" data-challenge-id="${challenge.id}">📷 送出新紀錄(點圖示快速帶入)</button>` : ''}
        </div>
      </div>
    </div>
  `;
}

function renderGroup(group, completed, challenge) {
  return `
    <div class="ch-group">
      <div class="ch-group-title">${escapeHtml(group.title || '')}</div>
      <div class="ch-dex-grid">
        ${(group.tasks || []).map(t => renderDexCard(t, completed, challenge)).join('')}
      </div>
    </div>
  `;
}

// 圖鑑卡片：麵照（未完成灰階 / 完成彩色）＋ 店家 ＋ 品項(title) ＋ 日期 ＋ 完成郵戳
function renderDexCard(t, completed, challenge) {
  const done     = completed.includes(t.id);
  const pending  = !done && _chPendingTaskIds && _chPendingTaskIds.has(t.id);
  const rejected = !done && !pending && _chRejectedTaskIds && _chRejectedTaskIds.has(t.id);
  const field    = (t.condition && t.condition.field) || '';
  const val   = (t.condition && t.condition.value) || '';
  // 店家標籤依 field：shopId/quest/scanShop 查店名；shopCity 顯示縣市；manual 不限店家
  let shopLabel;
  if (field === 'shopId' || field === 'quest' || field === 'scanShop') {
    const shop = (typeof findShopById === 'function') ? findShopById(val) : null;
    shopLabel = (shop && shop['店名']) ? shop['店名'] : (val || '');
  } else if (field === 'shopCity') {
    shopLabel = val || '';
  } else {
    shopLabel = '不限店家';
  }
  // 日期區間：task.timeWindow 優先，否則活動期間
  const tw = t.timeWindow, p = challenge.period || {};
  const dateLabel = (tw && tw.start && tw.end) ? `${tw.start} ~ ${tw.end}`
    : (p.start && p.end) ? `${p.start} ~ ${p.end}` : '活動期間內';
  // 麵照：有 image 顯示圖，無則 fallback 佔位（no-img）
  const noodle = t.image
    ? `<div class="ch-dex-noodle"><img src="${escapeHtml(t.image)}" alt="" loading="lazy" onerror="this.parentElement.classList.add('no-img');this.remove()"></div>`
    : `<div class="ch-dex-noodle no-img"></div>`;
  const stateClass = done ? 'done' : pending ? 'pending' : rejected ? 'rejected' : '';
  return `<div class="ch-dex-card ${stateClass}" data-tid="${escapeHtml(t.id || '')}" data-cid="${escapeHtml(challenge.id || '')}" data-field="${escapeHtml(field)}">
    ${noodle}
    <div class="ch-dex-shop">${escapeHtml(shopLabel)}</div>
    <div class="ch-dex-item">${escapeHtml(t.title || '')}</div>
    <div class="ch-dex-date">${escapeHtml(dateLabel)}</div>
    <div class="ch-dex-stamp">已完成</div>
    <div class="ch-dex-stamp-review">審查中</div>
    <div class="ch-dex-stamp-reject">已駁回</div>
  </div>`;
}

// ── 送出 Modal ─────────────────────────────────────────────────────────────
function openChSubmitModal(challengeId, task) {
  const challenge = _chChallenges.find(c => c.id === challengeId);
  if (!challenge) return;
  _chCurrentChallenge = challenge;
  _chCurrentFile      = null;
  _chCurrentShop      = null;
  _chCurrentTask      = task || null;

  document.getElementById('chSubmitTitle').textContent = `📷 送出紀錄 — ${challenge.title || ''}`;
  document.getElementById('chShopInput').value          = '';
  document.getElementById('chShopInput').dataset.shopId = '';
  document.getElementById('chShopAc').style.display     = 'none';
  document.getElementById('chDiningTime').value         = toLocalDateTimeStr(new Date());
  document.getElementById('chItemName').value           = '';
  document.getElementById('chPrice').value              = '';
  document.getElementById('chPreview').innerHTML        = '';
  document.getElementById('chProgress').textContent     = '';
  document.getElementById('chSubmitBtn').disabled       = true;

  // 點圖鑑格帶入：品項(title) 一律帶；店家僅 shopId 型能帶特定店（shopCity/manual 由玩家自選）
  if (task) {
    document.getElementById('chItemName').value = task.title || '';
    if (task.condition && task.condition.field === 'shopId') {
      const shop = (typeof findShopById === 'function') ? findShopById(task.condition.value) : null;
      if (shop) {
        const inp = document.getElementById('chShopInput');
        inp.value          = shop['店名'] || '';
        inp.dataset.shopId = shop['ID'] || '';
        _chCurrentShop     = shop;
      }
    }
    document.getElementById('chSubmitTitle').textContent = `📷 ${task.title || challenge.title || ''}`;
  }

  resetChUploadArea();
  checkChReady();

  document.getElementById('chSubmitBackdrop').classList.add('open');
  document.getElementById('chSubmitModal').classList.add('open');
}

function closeChSubmitModal() {
  document.getElementById('chSubmitBackdrop').classList.remove('open');
  document.getElementById('chSubmitModal').classList.remove('open');
}

function resetChUploadArea() {
  const area = document.getElementById('chUploadArea');
  if (!area) return;
  area.innerHTML = `<input type="file" id="chFileInput" accept="image/jpeg,image/png,image/webp,image/heic,image/heif">📷 點擊上傳照片`;
  area.querySelector('#chFileInput').addEventListener('change', onChFileChange);
}

function toLocalDateTimeStr(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── EXIF 讀取 ──────────────────────────────────────────────────────────────
async function extractExifDate(file) {
  if (typeof exifr === 'undefined') return null;
  try {
    const exif = await exifr.parse(file, { pick: ['DateTimeOriginal', 'CreateDate', 'ModifyDate'] });
    return exif?.DateTimeOriginal || exif?.CreateDate || exif?.ModifyDate || null;
  } catch (e) {
    return null;
  }
}

async function onChFileChange(e) {
  const file = e.target.files[0];
  if (!file) return;
  _chCurrentFile = file;

  const preview = document.getElementById('chPreview');
  const url     = URL.createObjectURL(file);
  preview.innerHTML = `
    <div class="rv-preview-item">
      <img src="${url}" alt="">
      <button class="rv-preview-remove" id="chPreviewRemove">✕</button>
    </div>`;
  preview.querySelector('#chPreviewRemove').addEventListener('click', () => {
    _chCurrentFile = null;
    preview.innerHTML = '';
    resetChUploadArea();
    checkChReady();
  });

  // 嘗試從 EXIF 讀取拍攝時間
  document.getElementById('chProgress').textContent = '正在讀取照片資訊…';
  const exifDate = await extractExifDate(file);
  if (exifDate instanceof Date && !isNaN(exifDate)) {
    document.getElementById('chDiningTime').value = toLocalDateTimeStr(exifDate);
    document.getElementById('chProgress').textContent = `✓ 已從照片讀取拍攝時間：${exifDate.toLocaleString('zh-TW')}`;
  } else {
    document.getElementById('chProgress').textContent = '（照片無拍攝時間資訊，請手動輸入用餐時間）';
  }

  checkChReady();
}

function checkChReady() {
  const hasShop  = !!document.getElementById('chShopInput').dataset.shopId;
  const hasPhoto = !!_chCurrentFile;
  const hasTime  = !!document.getElementById('chDiningTime').value;
  const hasItem  = !!document.getElementById('chItemName').value.trim();
  document.getElementById('chSubmitBtn').disabled = !(hasShop && hasPhoto && hasTime && hasItem);
}

// ── 店家 Autocomplete ──────────────────────────────────────────────────────
function initChShopAutocomplete() {
  const inp = document.getElementById('chShopInput');
  const ac  = document.getElementById('chShopAc');
  if (!inp || !ac) return;

  inp.addEventListener('input', () => {
    inp.dataset.shopId = '';
    _chCurrentShop     = null;
    checkChReady();
    const q = inp.value.trim().toLowerCase();
    if (q.length < 1 || typeof ALL_DATA === 'undefined' || !ALL_DATA.length) {
      ac.style.display = 'none'; return;
    }
    const matches = ALL_DATA.filter(s =>
      (s['店名'] || '').toLowerCase().includes(q)
    ).slice(0, 8);
    if (!matches.length) { ac.style.display = 'none'; return; }
    ac.innerHTML = matches.map(s => `
      <div class="ch-ac-item" data-id="${s['ID'] || ''}">
        <div class="ch-ac-name">${escapeHtml(s['店名'] || '')}</div>
        <div class="ch-ac-sub">${escapeHtml([s['縣市'], (s['地址'] || '').slice(0, 20)].filter(Boolean).join('・'))}</div>
      </div>
    `).join('');
    ac.style.display = 'block';
  });

  ac.addEventListener('click', e => {
    const item = e.target.closest('.ch-ac-item');
    if (!item) return;
    const shop = ALL_DATA.find(s => s['ID'] === item.dataset.id);
    if (!shop) return;
    inp.value          = shop['店名'];
    inp.dataset.shopId = shop['ID'];
    _chCurrentShop     = shop;
    ac.style.display   = 'none';
    checkChReady();
  });

  document.addEventListener('click', e => {
    if (!inp.contains(e.target) && !ac.contains(e.target)) {
      ac.style.display = 'none';
    }
  });
}

// ── GPS 驗證：確認在所選店家附近（比照排隊回報 openQueueModal）───────────────
// 回傳 null=通過；字串=錯誤訊息（擋下送出）。店家無 lat/lng 則略過驗證（放行）。
// 半徑共用排隊回報的後台設定 queueSettings.gpsRadiusMeters（meta/queueSettings），fallback 500。
async function chVerifyGpsNearShop(shop) {
  const lat = shop && shop['lat'], lng = shop && shop['lng'];
  if (lat == null || lng == null || lat === '' || lng === '') return null; // 無座標→不驗
  if (!navigator.geolocation) return '此裝置不支援定位，無法送出';
  document.getElementById('chProgress').textContent = '📍 取得定位中…';
  const gps = await new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ ok: true, lat: pos.coords.latitude, lng: pos.coords.longitude }),
      ()  => resolve({ ok: false }),
      { timeout: 10000, maximumAge: 60000 }
    );
  });
  if (!gps.ok) return '需要開啟定位才能送出（請允許定位權限）';
  const radius = (typeof queueSettings !== 'undefined' && queueSettings.gpsRadiusMeters) || 500;
  const dist = haversineDistance(gps.lat, gps.lng, Number(lat), Number(lng));
  if (dist > radius) return `距離「${shop['店名'] || ''}」約 ${Math.round(dist)} 公尺，需在 ${radius} 公尺內才能送出`;
  return null;
}

// ── 送出紀錄 ───────────────────────────────────────────────────────────────
async function submitChallengeRecord() {
  if (!_chCurrentFile || !_chCurrentShop || !auth.currentUser || !_chCurrentChallenge) return;

  const diningStr = document.getElementById('chDiningTime').value;
  const itemName  = document.getElementById('chItemName').value.trim();
  const priceStr  = document.getElementById('chPrice').value.trim();
  const price     = priceStr ? parseInt(priceStr, 10) : 0;

  const diningDate = new Date(diningStr);
  if (isNaN(diningDate.getTime())) {
    document.getElementById('chProgress').textContent = '❌ 用餐時間格式錯誤';
    return;
  }

  // 時間驗證（僅檢查挑戰期間，task timeWindow 由 admin 審查時把關）
  const err = chValidateTime(diningDate, _chCurrentChallenge, null);
  if (err) {
    document.getElementById('chProgress').textContent = '❌ ' + err;
    return;
  }

  // GPS 驗證：必須在所選店家附近才能送出（擋下；店家無座標則略過）
  const gpsErr = await chVerifyGpsNearShop(_chCurrentShop);
  if (gpsErr) {
    document.getElementById('chProgress').textContent = '❌ ' + gpsErr;
    return;
  }

  const btn      = document.getElementById('chSubmitBtn');
  const progress = document.getElementById('chProgress');
  btn.disabled         = true;
  progress.textContent = '壓縮中…';

  try {
    const user       = auth.currentUser;
    const compressed = await compressImage(_chCurrentFile, { maxPx: 1200, maxKB: 280 });

    progress.textContent = '上傳照片…';
    const docRef = db.collection('challengeSubmissions').doc();
    const path   = `challengeSubmissions/${user.uid}/${docRef.id}.webp`;
    const ref    = storage.ref(path);
    await ref.put(compressed, { contentType: compressed.type });
    const photoUrl = await ref.getDownloadURL();

    // 構造 submission + 計算自動匹配的 task
    const submission = {
      uid:         user.uid,
      displayName: user.displayName || '匿名',
      challengeId: _chCurrentChallenge.id,
      shopId:      _chCurrentShop['ID']   || '',
      shopName:    _chCurrentShop['店名'] || '',
      shopCity:    _chCurrentShop['縣市'] || '',
      itemName,
      price,
      diningTime:  firebase.firestore.Timestamp.fromDate(diningDate),
      photoUrl,
      photoPath:   path,
      taskId:      _chCurrentTask ? _chCurrentTask.id : '',
      status:      'pending',
      autoTaskIds: [],
      createdAt:   firebase.firestore.FieldValue.serverTimestamp(),
    };
    submission.autoTaskIds = chComputeAutoTaskIds(submission, _chCurrentChallenge);

    progress.textContent = '送出中…';
    await docRef.set(submission);

    showStampToast('✅ 已送出，等待審查');
    if (typeof gtag !== 'undefined') {
      gtag('event', 'challenge_submit', {
        challenge_id: _chCurrentChallenge.id,
        shop_id:      _chCurrentShop['ID'],
        shop_name:    _chCurrentShop['店名'],
      });
    }
    closeChSubmitModal();
    loadChallengesPage();  // 送出後自動重載，圖鑑格即時更新為「審查中」
  } catch (e) {
    console.error('[challenges] submit failed', e);
    progress.textContent = '❌ 送出失敗：' + e.message;
    btn.disabled = false;
  }
}

// ── 初始化（綁定事件） ─────────────────────────────────────────────────────
(function initChallengesModule() {
  const cancelBtn  = document.getElementById('chCancelBtn');
  const closeBtn   = document.getElementById('chCloseBtn');
  const submitBtn  = document.getElementById('chSubmitBtn');
  const backdrop   = document.getElementById('chSubmitBackdrop');
  const uploadArea = document.getElementById('chUploadArea');
  const itemName   = document.getElementById('chItemName');
  const diningTime = document.getElementById('chDiningTime');

  if (cancelBtn)  cancelBtn.addEventListener('click', closeChSubmitModal);
  if (closeBtn)   closeBtn.addEventListener('click', closeChSubmitModal);
  if (submitBtn)  submitBtn.addEventListener('click', submitChallengeRecord);
  if (backdrop)   backdrop.addEventListener('click', e => {
    if (e.target === backdrop) closeChSubmitModal();
  });
  if (uploadArea) uploadArea.addEventListener('click', e => {
    // 點選擇檔案 input 時不要重複觸發
    if (e.target.tagName !== 'INPUT') document.getElementById('chFileInput')?.click();
  });
  if (itemName)   itemName.addEventListener('input', checkChReady);
  if (diningTime) diningTime.addEventListener('input', checkChReady);

  initChShopAutocomplete();
})();
