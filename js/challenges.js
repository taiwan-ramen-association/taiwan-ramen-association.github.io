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
var _chProgressUid      = null;   // _chUserProgress 屬於哪個帳號（每一份進度都讀成功才填；未登入／有讀取失敗＝null）。獎章比對新獎章用（js/badges.js）
let _chCurrentChallenge = null;
let _chCurrentFile      = null;
let _chCurrentShop      = null;
let _chCurrentTask      = null;      // 點圖鑑格開送出 modal 時記住的 task（供 submission 記 taskId）
let _chPendingTaskIds   = new Set(); // 本人有 pending submission 的 key（顯示「審查中」）；key=chKey(challengeId,taskId)
let _chRejectedTaskIds  = new Set(); // 本人有 rejected submission 的 key（顯示「已駁回」）；key=chKey(challengeId,taskId)
let _chLoadSeq          = 0;         // 載入序號：登入後的背景重抓可能與使用者操作同時觸發，只讓最後一次請求得以寫入狀態並渲染

// 分頁載入：預設顯 2 則 → 滾輪自動載到 5 則 → 超過 5 則改按「載入更多」手動展開
const CH_PAGE_INIT = 2, CH_PAGE_SCROLL_MAX = 5, CH_PAGE_MORE_STEP = 5;
let _chVisibleCount = CH_PAGE_INIT;
let _chScrollObserver = null;

// pending/rejected 以「活動+任務」為鍵，避免不同活動間 taskId 撞號誤判（如兩活動都有 t1）
// 分隔符用 NUL（id 裡不可能出現）。務必寫成轉義字面，直接嵌入 NUL 位元組會讓 git 把整個檔案當 binary、diff 整個消失
function chKey(cid, tid) { return `${cid}\u0000${tid}`; }

// 活動排序：① 進行中(active) 一律排在 結束(ended) 之前 → ② sortOrder 升冪（未填＝最後）→ ③ createdAt 降冪（新在前）
function chCompareOrder(a, b) {
  const ea = a.status === 'ended' ? 1 : 0, eb = b.status === 'ended' ? 1 : 0;
  if (ea !== eb) return ea - eb;
  const num = v => (v === '' || v == null || !Number.isFinite(+v)) ? Infinity : +v;
  const oa = num(a.sortOrder), ob = num(b.sortOrder);
  if (oa !== ob) return oa - ob;
  return (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0);
}

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
// opts.keepView=true → 背景重抓模式（Google 登入後用）：不清空列表、不顯示「載入中…」、
// 不重置分頁，資料到齊才一次換上，避免畫面又跳一次。重抓期間列表加 is-refreshing
// （半透明＋擋點擊），否則這段空窗期舊 DOM 還是「未完成」狀態，點得開送出 modal 造成重複提交。
async function loadChallengesPage(opts) {
  const keepView = !!(opts && opts.keepView);
  const list = document.getElementById('challengesList');
  if (!list) return;

  const seq = ++_chLoadSeq;
  const hasContent = keepView && !!list.querySelector('.ch-card');
  if (hasContent) list.classList.add('is-refreshing');
  else            list.innerHTML = '<p class="ch-empty">載入中…</p>';

  // 全部先收在 local，最後確認自己仍是最新一次請求才寫回模組狀態，
  // 避免慢的舊請求後到、把新請求的結果蓋掉
  const progress = {};
  const pending  = new Set();
  const rejected = new Set();
  let complete = true;   // 進度（含掃描、尋寶聯集）每一份都讀成功

  try {
    // 載入 active + ended（結束的活動不消失，靠排序沉到最下面）；draft 仍不對前台顯示
    const snap = await db.collection('challenges').where('status', 'in', ['active', 'ended']).get();
    const challenges = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    challenges.sort(chCompareOrder);

    // 個人進度／審查狀態：僅登入時載入；未登入以空進度渲染（內容可瀏覽、互動才要登入）
    const user = auth.currentUser;
    if (user) {
      const uid = user.uid;
      // 載入每個挑戰的使用者進度
      await Promise.all(challenges.map(async c => {
        try {
          const ref = db.collection('userChallengeProgress').doc(uid).collection('challenges').doc(c.id);
          const doc = await ref.get();
          progress[c.id] = doc.exists ? doc.data() : { completedTaskIds: [] };
        } catch (e) {
          progress[c.id] = { completedTaskIds: [] };
          complete = false;
        }
      }));

      // 附加：店家掃描驗證（challengeCheckins）union 進 completedTaskIds
      // （不動審查路徑；壞了現有審查進度照常顯示）
      try {
        const ckSnap = await db.collection('challengeCheckins').where('uid', '==', uid).get();
        ckSnap.docs.forEach(d => {
          const ck = d.data();
          if (!ck.challengeId || !ck.taskId) return;
          const prog = progress[ck.challengeId];
          if (!prog) return;
          if (!prog.completedTaskIds) prog.completedTaskIds = [];
          if (!prog.completedTaskIds.includes(ck.taskId)) prog.completedTaskIds.push(ck.taskId);
        });
      } catch (e) { complete = false; console.warn('[challenges] checkins 聯集失敗（不影響審查進度）', e); }

      // 附加：客人自助尋寶（questCheckins）union 進 completedTaskIds（情境2）
      try {
        const qSnap = await db.collection('questCheckins').where('uid', '==', uid).get();
        qSnap.docs.forEach(d => {
          const q = d.data();
          if (!q.challengeId || !q.taskId) return;
          const prog = progress[q.challengeId];
          if (!prog) return;
          if (!prog.completedTaskIds) prog.completedTaskIds = [];
          if (!prog.completedTaskIds.includes(q.taskId)) prog.completedTaskIds.push(q.taskId);
        });
      } catch (e) { complete = false; console.warn('[challenges] questCheckins 聯集失敗', e); }

      // 附加：載入本人 submission → 標記「審查中」(pending) / 「已駁回」(rejected) 的 task
      try {
        const subSnap = await db.collection('challengeSubmissions').where('uid', '==', uid).get();
        subSnap.docs.forEach(d => {
          const s = d.data();
          if (!s.challengeId) return; // 舊資料無 challengeId 無法歸屬活動，略過以免跨活動誤判
          const ids = [];
          if (s.taskId) ids.push(s.taskId);
          (s.autoTaskIds || []).forEach(tid => ids.push(tid));
          const set = s.status === 'pending' ? pending : s.status === 'rejected' ? rejected : null;
          if (set) ids.forEach(tid => set.add(chKey(s.challengeId, tid)));
        });
      } catch (e) { console.warn('[challenges] submission 狀態載入失敗', e); }
    } else {
      // 未登入：所有挑戰以空進度顯示（互動時再導引登入）
      challenges.forEach(c => { progress[c.id] = { completedTaskIds: [] }; });
    }

    if (seq !== _chLoadSeq) return;   // 已被更新的請求蓋過 → 整包丟棄，不寫狀態也不渲染
    _chChallenges      = challenges;
    _chUserProgress    = progress;
    _chProgressUid     = (user && complete) ? user.uid : null;
    _chPendingTaskIds  = pending;
    _chRejectedTaskIds = rejected;
    if (!keepView) _chVisibleCount = CH_PAGE_INIT; // 每次進頁重置分頁；背景重抓則維持使用者已展開的則數

    list.classList.remove('is-refreshing');
    renderChallenges();
    _chPageLoaded = true;
  } catch (e) {
    if (seq !== _chLoadSeq) return;
    list.classList.remove('is-refreshing');
    console.error('[challenges] loadChallengesPage 失敗', e);
    // 背景重抓失敗時維持原畫面即可，不要把使用者正在看的列表換成紅字
    if (!hasContent) list.innerHTML = `<p class="ch-empty">載入失敗：${escapeHtml(e.message)}</p>`;
  }
}

// ── 渲染挑戰列表 ───────────────────────────────────────────────────────────
function renderChallenges() {
  const list = document.getElementById('challengesList');
  if (!list) return;
  if (typeof badgesRefresh === 'function') badgesRefresh();   // 標題下方的獎章橫幅跟著進度更新（js/badges.js）
  if (_chScrollObserver) { _chScrollObserver.disconnect(); _chScrollObserver = null; }
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
  // 分頁：只渲染前 _chVisibleCount 則，其餘用滾輪 sentinel 自動載入（到 5 則）或「載入更多」按鈕
  const total = visible.length;
  if (_chVisibleCount > total) _chVisibleCount = total;
  const shown = visible.slice(0, _chVisibleCount);
  // 重渲染前記下展開中的卡片，渲染後還原：登入後背景重抓、按「載入更多」都會走到這裡，
  // 不還原的話使用者展開的卡片會突然收合＝畫面跳一次
  const expandedIds = new Set(
    [...list.querySelectorAll('.ch-card.expanded')].map(el => el.dataset.cid).filter(Boolean)
  );
  let html = shown.map(ch => renderChallengeCard(ch)).join('');
  const remaining = total - _chVisibleCount;
  if (remaining > 0) {
    html += _chVisibleCount < CH_PAGE_SCROLL_MAX
      ? '<div id="chScrollSentinel" aria-hidden="true"></div>'
      : `<button type="button" class="ch-load-more" id="chLoadMore">＋ 載入更多任務（剩 ${remaining} 則）</button>`;
  }
  list.innerHTML = html;
  if (expandedIds.size) {
    list.querySelectorAll('.ch-card').forEach(el => {
      if (expandedIds.has(el.dataset.cid)) el.classList.add('expanded');
    });
  }

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
      if (card.classList.contains('done'))    { showStampToast('已完成，無需重複提交'); return; }
      if (card.classList.contains('pending')) { showStampToast('審查中，請勿重複提交'); return; }
      openChSubmitModal(cid, task);
    });
  });
  // 綁定排行榜按鈕
  list.querySelectorAll('.ch-rank-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openChRankModal(btn.dataset.cid); });
  });
  // 綁定卡片展開（點 header 切換）；結束(ended)卡片無 .ch-toggle，故不會展開
  list.querySelectorAll('.ch-toggle').forEach(h => {
    h.addEventListener('click', () => h.closest('.ch-card')?.classList.toggle('expanded'));
  });

  // 滾輪 sentinel：捲到底自動一次載到 5 則（2+3）
  const sentinel = document.getElementById('chScrollSentinel');
  if (sentinel) {
    _chScrollObserver = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) {
        _chVisibleCount = Math.min(CH_PAGE_SCROLL_MAX, _chChallenges.length);
        renderChallenges();
      }
    }, { rootMargin: '150px' });
    _chScrollObserver.observe(sentinel);
  }
  // 超過 5 則：手動「載入更多」，每次多展開 CH_PAGE_MORE_STEP 則
  const moreBtn = document.getElementById('chLoadMore');
  if (moreBtn) moreBtn.addEventListener('click', () => { _chVisibleCount += CH_PAGE_MORE_STEP; renderChallenges(); });
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

  // 進度顯示：里程碑模式（milestone.step>0，每 N 個/間 +1，可封頂）；否則原始 完成/總 %
  // milestone 物件優先，向下相容舊頂層 goalStep/Label/Unit/Max；countBy:'shop' 以不重複店家計數（同店多碗算一間）
  let barPct = pct, progText = `${doneTasks}/${totalTasks}　${pct}%`;
  const ms      = challenge.milestone || {};
  const gStep   = Number(ms.step ?? challenge.goalStep) || 0;
  const countBy = ms.countBy || challenge.goalCountBy || 'task';
  if (gStep > 0) {
    const shopOf    = t => (t.condition && ['shopId', 'scanShop', 'quest'].includes(t.condition.field)) ? t.condition.value : null;
    const unitDone  = countBy === 'shop'
      ? new Set(allTasks.filter(t => completed.includes(t.id)).map(shopOf).filter(Boolean)).size
      : doneTasks;
    const unitTotal = countBy === 'shop'
      ? new Set(allTasks.map(shopOf).filter(Boolean)).size
      : totalTasks;
    const gMax   = Number(ms.max ?? challenge.goalMax) || 0;
    const maxAch = gMax > 0 ? gMax : Math.floor(unitTotal / gStep);
    if (maxAch > 0) {
      const ach   = Math.min(Math.floor(unitDone / gStep), maxAch);
      const label = escapeHtml((ms.label ?? challenge.goalLabel) || '達成');
      const unit  = escapeHtml((ms.unit ?? challenge.goalUnit) || (countBy === 'shop' ? '間' : '個'));
      if (ach >= maxAch) {
        barPct = 100;
        progText = `🎟️ ${label} ×${ach}　（完成 ${unitDone} ${unit}｜已達上限 🎉）`;
      } else {
        const inCycle = unitDone % gStep;
        barPct = Math.round(inCycle / gStep * 100);
        progText = `🎟️ ${label} ×${ach}　（完成 ${unitDone} ${unit}｜再 ${gStep - inCycle} ${unit} +1）`;
      }
    }
  }

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

  const ended = challenge.status === 'ended';
  // 排行榜鈕：per-activity 開關（showLeaderboard；未設＝顯示）。有封面圖或結束卡疊在右上（結束卡要浮在遮罩之上仍可看最終榜），否則嵌標題列
  const showRank = challenge.showLeaderboard !== false;
  const rankBtn  = showRank ? `<button class="ch-rank-btn" data-cid="${escapeHtml(challenge.id)}">🏆 排行榜</button>` : '';
  const rankOverlay = showRank && (ended || challenge.image) ? rankBtn : '';
  const rankInline  = showRank && !ended && !challenge.image ? `<span class="ch-rank-inline">${rankBtn}</span>` : '';
  return `
    <div class="ch-card${ended ? ' ch-ended' : ''}" data-cid="${escapeHtml(challenge.id || '')}">
      ${challenge.image ? `<img class="ch-cover" src="${escapeHtml(challenge.image)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
      ${rankOverlay}
      ${ended ? '<div class="ch-ended-mask"><span>活動已結束</span></div>' : ''}
      <div class="ch-card-header${ended ? '' : ' ch-toggle'}">
        <div class="ch-title">${escapeHtml(challenge.title || '')}</div>
        ${periodStr ? `<div class="ch-period">📅 ${escapeHtml(periodStr)}</div>` : ''}
        ${rankInline}
        ${ended ? '' : '<span class="ch-chevron" aria-hidden="true"></span>'}
      </div>
      <div class="ch-progress-row">
        <div class="ch-progress-bar"><div class="ch-progress-fill" style="width:${barPct}%"></div></div>
        <span class="ch-progress-text">${progText}</span>
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

// 日期區間縮寫：圖鑑格最窄只有 96px，完整的 2026-07-13 ~ 2026-08-31 佔 112px 會斷成兩行。
// 一律只留月/日（7/13 ~ 8/31）；年份不顯示，靠活動本身的期間脈絡判斷。單日限定只顯示一個日期。
function chFmtDateRange(start, end) {
  const isYmd = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isYmd(start) || !isYmd(end)) return `${start} ~ ${end}`;  // 格式非預期就原樣顯示
  const md = s => `${+s.slice(5, 7)}/${+s.slice(8, 10)}`;
  return start === end ? md(end) : `${md(start)} ~ ${md(end)}`;
}

// 圖鑑卡片：麵照（未完成灰階 / 完成彩色）＋ 店家 ＋ 品項(title) ＋ 日期 ＋ 完成郵戳
function renderDexCard(t, completed, challenge) {
  const done     = completed.includes(t.id);
  const k        = chKey(challenge.id, t.id);
  const pending  = !done && _chPendingTaskIds && _chPendingTaskIds.has(k);
  const rejected = !done && !pending && _chRejectedTaskIds && _chRejectedTaskIds.has(k);
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
  const dateLabel = (tw && tw.start && tw.end) ? chFmtDateRange(tw.start, tw.end)
    : (p.start && p.end) ? chFmtDateRange(p.start, p.end) : '活動期間內';
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

// ── 挑戰排行榜 ─────────────────────────────────────────────────────────────
// email 去識別化：前2後2＋中間固定星（越短遮越多，不洩漏原長度）
function maskEmail(email) {
  if (!email || email.indexOf('@') < 0) return '匿名';
  const [local, domain] = email.split('@');
  let m;
  if (local.length <= 2)      m = local.slice(0, 1) + '****';
  else if (local.length <= 4) m = local.slice(0, 1) + '****' + local.slice(-1);
  else                        m = local.slice(0, 2) + '****' + local.slice(-2);
  return m + '@' + domain;
}
// 開排行榜：讀 challengeLeaderboards/{cid}（admin batch 彙總），dense 名次 + 凍結自己
async function openChRankModal(cid) {
  const modal    = document.getElementById('chRankModal');
  const playerEl = document.getElementById('chRankList-player');
  const taskEl   = document.getElementById('chRankList-task');
  const shopEl   = document.getElementById('chRankList-shop');
  const selfEl   = document.getElementById('chRankSelf');
  document.getElementById('chRankTitle').textContent = '🏆 ' + ((_chChallenges.find(c => c.id === cid) || {}).title || '排行榜');
  playerEl.innerHTML = '<div class="ch-rank-empty">載入中…</div>';
  taskEl.innerHTML = shopEl.innerHTML = '';
  selfEl.style.display = 'none';
  modal.style.display = 'flex';
  document.getElementById('chRankClose').onclick = closeChRankModal;
  modal.onclick = e => { if (e.target === modal) closeChRankModal(); };
  // 分頁切換（資料一次載齊，純顯示切換）
  modal.querySelectorAll('.ch-rank-mtab').forEach(tab => {
    tab.onclick = () => {
      const key = tab.dataset.tab;
      modal.querySelectorAll('.ch-rank-mtab').forEach(t => t.classList.toggle('active', t === tab));
      modal.querySelectorAll('.ch-rank-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === key));
    };
  });
  // 每次開啟都回到「玩家」分頁
  modal.querySelectorAll('.ch-rank-mtab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'player'));
  modal.querySelectorAll('.ch-rank-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === 'player'));

  // 排行榜維持登入才可看（challengeLeaderboards rules 需登入）；未登入顯示友善提示，不拋權限錯誤紅字
  if (!auth.currentUser) {
    playerEl.innerHTML = '<div class="ch-rank-empty">登入後即可查看排行榜 🏆</div>';
    return;
  }

  const MEDALS = ['🥇', '🥈', '🥉'];
  // 通用 dense 名次渲染（rows 已由後端 count 多→少排序）；nameOf 決定顯示名，selfUid 有值才凍結自己
  const renderRanked = (rows, nameOf, opt) => {
    opt = opt || {};
    if (!rows || !rows.length) return { html: `<div class="ch-rank-empty">${opt.emptyMsg || '尚未產生'}</div>`, selfHtml: null };
    let rank = 0, prev = null, selfHtml = null;
    const html = rows.map(r => {
      if (r.count !== prev) { rank++; prev = r.count; }  // dense：同碗數並列、不跳號
      const isSelf = opt.selfUid && r.uid === opt.selfUid;
      const num = rank <= 3 ? `<span class="ch-rank-medal">${MEDALS[rank - 1]}</span>` : rank;
      const h = `<div class="ch-rank-row${isSelf ? ' is-self' : ''}">
        <div class="ch-rank-num">${num}</div>
        ${opt.colOf ? `<div class="ch-rank-shop">${escapeHtml(opt.colOf(r) || '')}</div>` : ''}
        <div class="ch-rank-name">${escapeHtml(nameOf(r))}${isSelf ? '<span class="ch-rank-you">（你）</span>' : ''}</div>
        <div class="ch-rank-count">${r.count}<span class="ch-rank-count-unit">碗</span></div>
      </div>`;
      if (isSelf) selfHtml = h;
      return h;
    }).join('');
    return { html, selfHtml };
  };
  try {
    const doc  = await db.collection('challengeLeaderboards').doc(cid).get();
    const data = doc.exists ? doc.data() : {};
    const uid  = auth.currentUser ? auth.currentUser.uid : '';
    // ① 玩家榜（凍結自己）
    const player = renderRanked(data.rows, r => r.emailMasked || '匿名',
      { selfUid: uid, emptyMsg: '排行榜尚未產生<br><small>管理員彙總後即會顯示</small>' });
    playerEl.innerHTML = player.html;
    if (player.selfHtml) { selfEl.innerHTML = player.selfHtml; selfEl.style.display = ''; }
    // ②③ 品項榜 / 店家榜（不凍結自己）；舊 doc 無這兩欄位 → 提示重新彙總
    const subEmpty = ('taskRows' in data) ? '尚無資料' : '請管理員重新彙總排行榜';
    taskEl.innerHTML = renderRanked(data.taskRows, r => r.title || r.taskId,
      { emptyMsg: subEmpty, colOf: r => (r.shopName && r.shopName !== r.shopId) ? r.shopName : '' }).html;
    shopEl.innerHTML = renderRanked(data.shopRows, r => r.shopName || r.shopId, { emptyMsg: subEmpty }).html;
  } catch (e) {
    playerEl.innerHTML = `<div class="ch-rank-empty">載入失敗：${escapeHtml(e.message)}</div>`;
  }
}
function closeChRankModal() {
  document.getElementById('chRankModal').style.display = 'none';
}

// ── 送出 Modal ─────────────────────────────────────────────────────────────
function openChSubmitModal(challengeId, task) {
  // 互動才要登入：未登入按送出 → 導引登入，不開表單
  if (!auth.currentUser) { showAccessToast(); return; }
  // 警示用戶：firestore rules 會擋下 challengeSubmissions 寫入，但擋在最後一步時
  // 照片已經上傳到 Storage（白花流量）。這裡先擋，別讓他走完整個流程。
  if (typeof isWarned !== 'undefined' && isWarned) { showStampToast('您的帳號目前受到限制'); return; }
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
      err => resolve({ ok: false, code: err.code }),
      { timeout: 10000, maximumAge: 60000 }
    );
  });
  if (!gps.ok) {
    if (gps.code === 1) return (typeof gpsDeniedHint === 'function') ? gpsDeniedHint('送出') : '定位權限被拒，請到瀏覽器／裝置設定開啟定位後重試';
    if (gps.code === 3) return '定位逾時，請確認訊號後重試';
    return '無法取得定位，請確認裝置定位已開啟';
  }
  const radius = (typeof queueSettings !== 'undefined' && queueSettings.gpsRadiusMeters) || 500;
  const dist = haversineDistance(gps.lat, gps.lng, Number(lat), Number(lng));
  if (dist > radius) return `距離「${shop['店名'] || ''}」約 ${Math.round(dist)} 公尺，需在 ${radius} 公尺內才能送出`;
  return null;
}

// ── 送出紀錄 ───────────────────────────────────────────────────────────────
async function submitChallengeRecord() {
  if (!_chCurrentFile || !_chCurrentShop || !auth.currentUser || !_chCurrentChallenge) return;
  // 第二道 warned 檢查：擋掉 modal 開啟後才被設為警示、或繞過 openChSubmitModal 的情況
  if (typeof isWarned !== 'undefined' && isWarned) {
    document.getElementById('chProgress').textContent = '❌ 您的帳號目前受到限制';
    return;
  }

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
    loadChallengesPage({ keepView: true });  // 送出後自動重載，圖鑑格即時更新為「審查中」；keepView 避免列表閃「載入中…」並把分頁縮回
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
