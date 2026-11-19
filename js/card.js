// ── card.js ──────────────────────────────────────────────────────────────────
// 店家卡片：渲染、展開/收起、tab 切換、卡片內按鈕（收藏/踩點/導航/複製地址/分享/排隊/問題回報）
// 依賴全域（其他 JS 模組）：
//   getFiltered, ALL_DAYS（filter.js）
//   renderMap, shopDist, formatDist（map.js）
//   canView, canUse, showAccessToast, isWarned, auth, db（auth.js）
//   favSet, stampMap, toggleFav, openStampModal, showStampToast（stamps.js）
//   loadShopMenu（menus.js）
//   loadShopPhotos（photos.js）
//   loadReviews（reviews.js）
// 依賴全域（finder.html 主 inline script）：
//   isValidUrl, isNewOpen, isBirthday, isUpcoming, parseOpenDate,
//   isOpenNow, parseHours, serverNow, icHtml,
//   escapeAttr, escapeHtml, findShopById, refreshQueueSection,
//   openQueueModal, openIrModal, currentView
// 提供全域：
//   renderCard, render, _filtered, expandedCard（其他模組未直接讀寫，僅 card.js 內部用）
//
// 【2026-08-20 重構】清單渲染改為「可實例化」：createCardList(containerId, opts) 工廠，
// 每個實例各自持有 items / displayedCount / scrollObserver / expanded。
// 動機：收藏頁要獨立成頁，需要第二份互不干擾的清單狀態；
//       舊寫法這四個狀態是模組層單一變數、容器 id 又寫死 #cardList，全站只能有一份清單。
// 對外介面不變：render() / _appendCards() / _filtered / _displayedCount / expandedCard
// 仍是同名全域，由下方薄包裝代理到 mainList 實例，其餘 19 處呼叫端一行都不用改。
//
// 【2026-11-19 卡片改版】收合時四排：
//   1. 店家主頁圖示（有 shopPage 權限才有）＋店名＋導航｜收藏｜踩點。四顆都是同一種透明方框（.card-ic），
//      排在高度＝店名一行的列裡 → 大小、間距、跟店名第一行的上下位置都固定（CSS 在 finder.html「店家卡片改版」）
//   2. 稱號：協會會員 → 🎂 本日壽星 → 新開幕（都沒有就整排不出現）
//   3. 狀態句＋距離（_cardStatus）；營業狀態不是「營業中」的店直接寫營業狀態
//   4. 標籤只排一行，放不下收成「+N」（_fitCardTags），展開後全部顯示
//   點卡片任何地方（含店名）＝展開／收合；店家主頁、導航、地址是連結，點了不會順便展開。
//   展開後「資訊」：整週營業時間 → 資訊表（地址可點開地圖＋複製）→ 備註 → IG／FB／分享。
//   導航、分享、店家主頁的 GA 都在下面「容器層事件委派」記。

// 圖示（2026-11-18）：finder.html 有 icHtml（PulsoIcon 圖示表）就畫線條圖示；
// 沒有（快取裡的舊版 finder.html）就照舊用 emoji／字元
function _cdIc(name, ch, cls) { return typeof icHtml === 'function' ? icHtml(name, cls) : ch; }

// ── 清單實例工廠 ─────────────────────────────────────────────────────────────
// opts.batchSize   每批渲染筆數（預設 20）；Infinity = 一次渲染完、不掛 IntersectionObserver
// opts.emptyHTML   空清單時顯示的內容
// opts.onFavToggle 收藏鈕按下後的額外行為（收藏頁用；Phase 4 接灰卡）
function createCardList(containerId, opts = {}) {
  const batchSize = opts.batchSize ?? 20;
  const emptyHTML = opts.emptyHTML
    ?? '<div class="empty-state"><div class="big">' + _cdIc('noodles', '\u{1F35C}') + '</div><p>找不到符合的店家<br>請調整篩選條件</p></div>';

  // 以下四個以前是模組層全域，現在是「這個實例自己的」
  let items          = [];
  let displayedCount = 0;
  let scrollObserver = null;
  let expanded       = null;

  const getList = () => document.getElementById(containerId);

  function renderList(newItems) {
    if (scrollObserver) { scrollObserver.disconnect(); scrollObserver = null; }
    items = newItems || [];
    const list = getList();
    if (!list) return;
    expanded = null;
    list.innerHTML = '';
    displayedCount = 0;
    if (!items.length) { list.innerHTML = emptyHTML; return; }
    appendCards();
  }

  function appendCards() {
    if (scrollObserver) { scrollObserver.disconnect(); scrollObserver = null; }
    const list = getList();
    if (!list) return;
    const batch = items.slice(displayedCount, displayedCount + batchSize);
    if (!batch.length) return;

    const frag = document.createElement('div');
    frag.innerHTML = batch.map(renderCard).join('');
    bindCardEvents(frag);
    const added = [...frag.children];
    while (frag.firstChild) list.appendChild(frag.firstChild);
    _fitCardTags(added);   // 2026-11-19：標籤放不下收成 +N（要先放進畫面才量得到寬度）
    displayedCount += batch.length;
    // 相容層鏡像值同步。必須放在這裡而非只在薄包裝裡：無限捲動是由 observer
    // 直接呼叫 appendCards()、不經過 _appendCards() 包裝，漏掉就會讓 _displayedCount 卡在舊值。
    if (typeof _syncCardListGlobals === 'function') _syncCardListGlobals();

    if (displayedCount < items.length) {
      const sentinel = document.createElement('div');
      sentinel.className = 'scroll-sentinel';
      list.appendChild(sentinel);
      scrollObserver = new IntersectionObserver(([entry]) => {
        if (entry.isIntersecting) appendCards();
      }, { rootMargin: '200px' });
      scrollObserver.observe(sentinel);
    }
  }

  // 卡片內事件綁定。展開狀態 expanded 是實例私有的，故定義在工廠內。
  function bindCardEvents(scope) {
    scope.querySelectorAll('.card').forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.closest('a') || e.target.closest('.fav-btn') || e.target.closest('.stamp-btn') || e.target.closest('.queue-report-btn') || e.target.closest('.write-review-btn') || e.target.closest('.review-del-btn') || e.target.closest('.review-photo-thumb') || e.target.closest('.review-load-more') || e.target.closest('.review-comment-form') || e.target.closest('.review-comments-more') || e.target.closest('.card-tab') || e.target.closest('.mnu-thumb') || e.target.closest('.mnu-del-btn') || e.target.closest('.photo-grid-item') || e.target.closest('.addr-copy-btn') || e.target.closest('.card-share-btn')) return;
        // 已展開時點 card-detail 內部不縮起
        if (card.classList.contains('expanded') && e.target.closest('.card-detail')) return;
        const prev = expanded && expanded !== card ? expanded : null;
        if (prev) prev.classList.remove('expanded');
        card.classList.toggle('expanded');
        expanded = card.classList.contains('expanded') ? card : null;
        _syncCardListGlobals();
        // 收起來的卡：標籤回到一行（展開時若重排過，+N 要重算）
        if (prev) _fitCardTags([prev]);
        if (!expanded) _fitCardTags([card]);
        if (expanded) {
          setTimeout(() => card.scrollIntoView({behavior:'smooth',block:'nearest'}), 50);
          const shopId = card.dataset.shopId;
          if (shopId) refreshQueueSection(shopId);
        }
      });
      card.querySelectorAll('.card-tab').forEach(tab => {
        tab.addEventListener('click', e => {
          e.stopPropagation();
          if (tab.classList.contains('ff-locked')) { showAccessToast(); return; }
          const target = tab.dataset.tabTarget;
          const detail = card.querySelector('.card-detail');
          detail.querySelectorAll('.card-tab').forEach(t => t.classList.toggle('active', t.dataset.tabTarget === target));
          detail.querySelectorAll('.card-tab-panel').forEach(p => p.classList.toggle('active', p.dataset.tabPanel === target));
          if (target === 'info') {
            const shopId = card.dataset.shopId;
            if (shopId) refreshQueueSection(shopId);
          }
          if (target === 'menu' && canView('menuTab')) {
            const shopId = card.dataset.shopId;
            const shop = findShopById(shopId);
            const menuPanel = detail.querySelector('[data-tab-panel="menu"] .menu-tab-inner');
            if (shop && menuPanel && !menuPanel.dataset.loaded) {
              menuPanel.dataset.loaded = '1';
              loadShopMenu(shop, menuPanel);
            }
          }
          if (target === 'photos' && canView('photosTab')) {
            const shopId = card.dataset.shopId;
            const shop = findShopById(shopId);
            const photoPanel = detail.querySelector('[data-tab-panel="photos"]');
            if (shop && photoPanel) loadShopPhotos(shop, photoPanel);
          }
          if (target === 'reviews') {
            const shopId = card.dataset.shopId;
            const rvPanel = detail.querySelector('[data-tab-panel="reviews"]');
            if (shopId && rvPanel && canView('reviews') && !rvPanel.dataset.loaded) {
              rvPanel.dataset.loaded = '1';
              loadReviews(shopId, rvPanel);
            }
          }
        });
      });
    });
    scope.querySelectorAll('.fav-btn').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        if (btn.classList.contains('locked')) { showAccessToast(); return; }
        const id = btn.dataset.id;
        if (!id) return;
        await toggleFav(id);
        btn.innerHTML = favSet.has(id) ? _cdIc('heart-solid', '♥') : _cdIc('heart', '♡');
        if (typeof opts.onFavToggle === 'function') opts.onFavToggle(id, btn);
      });
    });
    scope.querySelectorAll('.stamp-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (btn.classList.contains('locked')) { showAccessToast(); return; }
        openStampModal(btn.dataset.id, btn.dataset.name);
      });
    });
    scope.querySelectorAll('.queue-report-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (btn.classList.contains('ff-locked')) { showAccessToast(); return; }
        openQueueModal(btn.dataset.id, btn.dataset.name);
      });
    });
  }

  // 容器層事件委派：店家主頁連結、導航／地址連結、複製地址、分享、ir-btn-card。
  // 取代舊的「對 #cardList 寫死一次」，改成每個實例綁自己的容器。
  const listEl = getList();
  if (listEl) {
    listEl.addEventListener('click', e => {
      const t = e.target;
      const shopOf = () => { const c = t.closest('.card'); return c ? findShopById(c.dataset.shopId) : null; };
      // 店家主頁連結：perm 不足（ff-locked）時攔截導頁 + 提示
      // 2026-11-19：GA shop_page_open 從 inline onclick 搬來（店名有「'」時 inline 那段語法錯、事件送不出去）；鎖住的不記
      const shopLink = t.closest('.shop-link-btn');
      if (shopLink) {
        if (shopLink.classList.contains('ff-locked')) { e.preventDefault(); showAccessToast(); return; }
        const s = shopOf();
        if (s) _cardGa('shop_page_open', { shop_id: s['ID'], shop_name: s['店名'] });
        return;
      }
      // 導航（第一排）、地址（展開後）：連結照常開地圖，這裡只記 GA（source 分開記）
      const nav = t.closest('.nav-btn, .addr-link');
      if (nav) {
        const s = shopOf();
        if (s) _cardGa('nav_open', { shop_id: s['ID'], shop_name: s['店名'], source: nav.classList.contains('nav-btn') ? 'card_top' : 'address' });
        return;
      }
      if (t.closest('.addr-copy-btn')) { const s = shopOf(); if (s) _cardCopyAddr(s); return; }
      if (t.closest('.card-share-btn')) { const s = shopOf(); if (s) _cardShare(s); return; }
      const btn = t.closest('.ir-btn-card');
      if (!btn) return;
      if (btn.classList.contains('ff-locked')) { showAccessToast(); return; }
      openIrModal(btn.dataset.id, btn.dataset.name);
    });
    // 2026-11-19：清單變寬變窄（手機轉向、收藏頁第一次顯示）→ 標籤重排
    if (typeof ResizeObserver === 'function') {
      let lastW = -1;
      new ResizeObserver(([entry]) => {
        const w = Math.round(entry.contentRect.width);
        if (w === lastW) return;
        lastW = w;
        if (w) _fitCardTags([listEl]);
      }).observe(listEl);
    }
  }

  return {
    render: renderList,
    appendCards,
    get items()          { return items; },
    get displayedCount() { return displayedCount; },
    get expandedCard()   { return expanded; },
    set expandedCard(v)  { expanded = v; },
  };
}

// ── State ────────────────────────────────────────────────────────────────────
// 搜尋頁的清單實例（分批 20 筆 + 無限捲動）
const mainList = createCardList('cardList', { batchSize: 20 });

// 收藏頁的清單實例。不分批：實測全站最多收藏者為 32 家（≥50 家 0 人），
// 一次渲染完就永遠不會有高度塌縮、捲動位置天然穩定。
const favList = createCardList('favCardList', {
  batchSize: Infinity,
  emptyHTML: '<div class="empty-state"><div class="big">' + _cdIc('heart', '♡') + '</div>'
    + '<p>還沒有收藏的店家<br>在搜尋頁點愛心就能加入</p>'
    + '<button class="empty-cta" id="favEmptyCta">去找店家</button></div>',
  // 在收藏頁取消收藏：卡片留在原位變灰，不整份重畫（重畫會塌高度、吃掉捲動位置）。
  // 再按一次愛心即復原；真正移除延到下次進入收藏頁時的 renderFavorites()。
  onFavToggle: (id, btn) => {
    const card = btn.closest('.card');
    if (card) card.classList.toggle('fav-removed', !favSet.has(id));
    if (typeof updateFavCount === 'function') updateFavCount();
  },
});

// 相容層：舊全域名稱維持存在並代理到 mainList，讓既有呼叫端與偵錯習慣不變。
// 這三個是「鏡像值」，於渲染/展開狀態變動時由 _syncCardListGlobals() 同步。
var _filtered        = [];
let _displayedCount  = 0;
let expandedCard     = null;
function _syncCardListGlobals() {
  expandedCard    = mainList.expandedCard;
  _displayedCount = mainList.displayedCount;
}

// ── 卡片用的小函式（2026-11-19）──────────────────────────────────────────────
// 營業狀態不是「營業中」：狀態列直接寫資料原文。顏色沿用以前店名後面的小標籤（.nl-*）；
// 停售拉麵、以後新出現的狀態用灰色（同已歇業）
const _CARD_NA_CLS = { '已歇業': 'closed', '停售拉麵': 'closed', '已搬遷': 'moved', '暫時關閉': 'pause', '暫停營業': 'pause', '籌備中': 'prep', '準備中': 'prep' };

function _cardHm(m) {
  m = ((m % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

// 狀態句（第三排）：{ cls, word＝粗體、狀態色；rest＝逗號後面 }
// 例：營業中，21:30 打烊／休息中，17:00 再開／還沒開，11:00 開／已打烊，明天 11:00 開／今天公休，週六 17:00 開
// 「營業中」跟以前的營業中小標籤、首頁「附近營業中」同一個判斷（isOpenNow：看今天的時段，跨午夜的時段凌晨也算）
function _cardStatus(shop) {
  const st = String(shop['營業狀態'] || '').trim();
  if (st && st !== '營業中') return { cls: 'st-na-' + (_CARD_NA_CLS[st] || 'closed'), word: st, rest: '' };
  if (isUpcoming(shop)) {
    const d = parseOpenDate(shop['開幕日']);
    return { cls: 'st-na-prep', word: (d.getMonth() + 1) + '/' + d.getDate() + ' 開幕', rest: '' };
  }
  const open = typeof isOpenNow === 'function' ? isOpenNow(shop) : null;
  if (open === null) return { cls: 'st-off', word: '', rest: '營業時間未提供' };
  const now  = serverNow();
  const mins = now.getHours() * 60 + now.getMinutes();
  const ti   = (now.getDay() + 6) % 7;   // 在 ALL_DAYS 的位置（週一＝0）
  const hasWeek  = ALL_DAYS.some(d => shop['週' + d]);
  const hoursOf  = d => shop['週' + d] || (hasWeek ? '' : (shop['營業時段'] || ''));
  const todayStr = hoursOf(ALL_DAYS[ti]);
  const slots    = parseHours(todayStr).sort((a, b) => a.start - b.start);
  if (open) {
    const cur = slots.find(s => mins >= s.start && mins < s.end)
             || slots.find(s => s.end > 1440 && mins + 1440 >= s.start && mins + 1440 < s.end);
    return { cls: 'st-open', word: '營業中', rest: cur ? _cardHm(cur.end) + ' 打烊' : '' };
  }
  // 下一次開門：從明天往後找 7 天
  const nextOpen = () => {
    for (let k = 1; k <= 7; k++) {
      const d  = ALL_DAYS[(ti + k) % 7];
      const sl = parseHours(hoursOf(d));
      if (sl.length) return (k === 1 ? '明天 ' : '週' + d + ' ') + _cardHm(Math.min(...sl.map(s => s.start))) + ' 開';
    }
    return '';
  };
  if (!todayStr)     return { cls: 'st-off', word: '今天公休', rest: nextOpen() };
  if (!slots.length) return { cls: 'st-off', word: '', rest: String(todayStr).trim().replace(/\s*\n\s*/g, '、') };
  const nx = slots.find(s => s.start > mins);
  if (nx) return mins < slots[0].start
    ? { cls: 'st-break', word: '還沒開', rest: _cardHm(nx.start) + ' 開' }
    : { cls: 'st-break', word: '休息中', rest: _cardHm(nx.start) + ' 再開' };
  return { cls: 'st-off', word: '已打烊', rest: nextOpen() };
}

// 展開後「資訊」最上面：整週營業時間。連續幾天時段一樣就併成一行（週一～五／週六、日／每天），今天那一行標紅。
// 完全沒有營業時間資料就不出現（狀態列已經寫「營業時間未提供」）
function _cardWeekHtml(shop) {
  const clean   = s => escapeHtml(String(s || '').trim().replace(/\s*\n\s*/g, '、'));
  const hasWeek = ALL_DAYS.some(d => shop['週' + d]);
  if (!hasWeek) {
    // 只有「營業時段」、沒有週一～日的舊資料（目前 0 間）：照原文列，店休日另列一行
    if (!shop['營業時段']) return '';
    return '<div class="card-week-label">營業時間</div><div class="card-week">'
      + `<span class="wd">時段</span><span>${clean(shop['營業時段'])}</span>`
      + (shop['店休日'] ? `<span class="wd">店休</span><span>${clean(String(shop['店休日']).replace(/,/g, '、'))}</span>` : '')
      + '</div>';
  }
  const today  = ALL_DAYS[(serverNow().getDay() + 6) % 7];
  const groups = [];
  ALL_DAYS.forEach(d => {
    const v = clean(shop['週' + d]);
    const g = groups[groups.length - 1];
    if (g && g.v === v) g.days.push(d); else groups.push({ v, days: [d] });
  });
  const label = d => d.length === 7 ? '每天' : d.length >= 3 ? '週' + d[0] + '～' + d[d.length - 1] : '週' + d.join('、');
  return '<div class="card-week-label">營業時間</div><div class="card-week">' + groups.map(g => {
    const t = g.days.includes(today) ? ' today' : '';
    return `<span class="wd${t}">${label(g.days)}</span><span class="${g.v ? '' : 'off'}${t}">${g.v || '公休'}</span>`;
  }).join('') + '</div>';
}

// 標籤只排一行（第四排）：放不下的藏起來（hidden），最後補一顆「+N」；展開後全部顯示（CSS）。
// 卡片要先放進畫面才量得到寬度；先全部量完再一起改，不會一直重算版面。
// scopes：卡片或清單元素。寬度是 0（清單所在的頁還沒顯示）就先跳過，等 ResizeObserver 通知寬度變了再排；
// 展開中的卡（標籤會換行）也跳過，收起來時再排（見卡片 click）。
function _fitCardTags(scopes) {
  const boxes = [];
  scopes.forEach(sc => { if (sc) sc.querySelectorAll('.card-tags').forEach(b => boxes.push(b)); });
  if (!boxes.length) return;
  // 1. 還原
  boxes.forEach(b => {
    b.querySelectorAll('.tag[hidden]').forEach(t => { t.hidden = false; });
    b.querySelectorAll('.tag-more').forEach(t => t.remove());
  });
  // 2. 量
  const jobs = [];
  boxes.forEach(b => {
    const avail = b.clientWidth;
    if (!avail || b.scrollWidth <= avail + 1) return;
    const left = b.getBoundingClientRect().left;
    const tags = [...b.querySelectorAll('.tag')];
    jobs.push({ b, avail, tags, rights: tags.map(t => t.getBoundingClientRect().right - left) });
  });
  if (!jobs.length) return;
  // 「+N」多寬：先放一顆「+9」量一次
  const probe = document.createElement('span');
  probe.className = 'tag tag-gray';
  probe.textContent = '+9';
  jobs[0].b.appendChild(probe);
  const moreW = probe.getBoundingClientRect().width;
  const gap   = parseFloat(getComputedStyle(jobs[0].b).columnGap) || 0;
  probe.remove();
  // 3. 改：留得下幾顆就留幾顆（至少收一顆）
  jobs.forEach(({ b, avail, tags, rights }) => {
    let k = tags.length - 1;
    while (k > 0 && rights[k - 1] + gap + moreW > avail) k--;
    tags.slice(k).forEach(t => { t.hidden = true; });
    const more = document.createElement('span');
    more.className = 'tag tag-gray tag-more';
    more.textContent = '+' + (tags.length - k);
    b.appendChild(more);
  });
}

// 字型（Google Fonts 依畫面用到的字分段載入）載完，標籤寬度會變 → 兩個清單重排一次
if (document.fonts && typeof document.fonts.addEventListener === 'function') {
  let _cardFontT = 0;
  document.fonts.addEventListener('loadingdone', () => {
    clearTimeout(_cardFontT);
    _cardFontT = setTimeout(() => _fitCardTags([document.getElementById('cardList'), document.getElementById('favCardList')]), 150);
  });
}

// GA4 自訂事件（gtag 沒載到就不送）
function _cardGa(name, params) {
  if (typeof gtag === 'function') gtag('event', name, params);
}

// 複製文字：先用 Clipboard API，不行再用舊方法（選取隱藏的 textarea）。成功回 true
async function _cardCopy(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch (e) { /* 改用舊方法 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

// 地址後面的「複製」
async function _cardCopyAddr(shop) {
  const addr = String(shop['地址'] || '');
  if (!addr) return;
  showStampToast(await _cardCopy(addr) ? '✓ 已複製地址' : '複製失敗');
}

// 分享（展開後「資訊」最下面）：店名＋深連結 finder.html?shop=ID（網域跟著現在開的網址，www 或 web.app）。
// 有系統分享選單就用它（同 shop.html）；沒有就複製連結。GA shop_share：分享完成或複製成功才記，method＝share／copy（同 badge_share）
async function _cardShare(shop) {
  const id   = String(shop['ID'] || '');
  const name = String(shop['店名'] || '');
  const url  = location.origin + '/finder.html?shop=' + encodeURIComponent(id);
  if (navigator.share) {
    try {
      await navigator.share({ title: name, text: name, url });
      _cardGa('shop_share', { shop_id: id, shop_name: name, method: 'share' });
    } catch (e) {
      if (!e || e.name !== 'AbortError') showStampToast('分享失敗');   // AbortError＝自己取消
    }
    return;
  }
  if (await _cardCopy(name + '\n' + url)) {
    showStampToast('✓ 已複製連結');
    _cardGa('shop_share', { shop_id: id, shop_name: name, method: 'copy' });
  } else showStampToast('複製失敗');
}

// ── 1. renderCard：產生單一卡片 HTML ─────────────────────────────────────────
function renderCard(shop) {
  const id       = String(shop['ID'] || '');
  const idA      = escapeAttr(id);
  const name     = String(shop['店名'] || '');
  const addr     = String(shop['地址'] || '');
  const dist     = shopDist(shop);
  const types    = (shop['類型']     || '').split(',').map(t=>t.trim()).filter(Boolean);
  const factions = (shop['派系']     || '').split(',').map(t=>t.trim()).filter(Boolean);

  // 導航（第一排）、地址（展開後）：同以前展開後的地圖鈕（Map 網址，沒有就用 Google 地圖搜尋地址）
  const mapUrl = isValidUrl(shop['Map']) ? shop['Map']
    : `https://www.google.com/maps/search/${encodeURIComponent(addr || name)}`;

  const links = [];
  if (isValidUrl(shop['Instagram'])) links.push(`<a href="${escapeHtml(shop['Instagram'])}" target="_blank" class="link-btn link-ig">${_cdIc('brand-instagram', '📷')} Instagram</a>`);
  if (isValidUrl(shop['Facebook']))  links.push(`<a href="${escapeHtml(shop['Facebook'])}"  target="_blank" class="link-btn link-fb">${_cdIc('brand-facebook', '👥')} Facebook</a>`);
  // 分享：跟 IG／FB 同一種按鈕、排最後（沒有 IG／FB 就只有它）
  links.push(`<button type="button" class="link-btn link-share card-share-btn">${_cdIc('share-2', '↗')} 分享</button>`);

  const detailItems = [
    shop['支付方式'] ? {l:'支付', v:shop['支付方式']} : null,
    shop['排隊方式'] ? {l:'排隊', v:shop['排隊方式']} : null,
    shop['點餐方式'] ? {l:'點餐', v:shop['點餐方式']} : null,
    shop['醬底']     ? {l:'醬底', v:shop['醬底']}     : null,
    (shop['吧台數'] || shop['桌位數']) ? {l:'座位', v:
      [shop['吧台數'] && shop['吧台數'] !== '0' ? `吧台 ${shop['吧台數']}` : '',
       shop['桌位數'] && shop['桌位數'] !== '0' ? `桌位 ${shop['桌位數']}` : ''].filter(Boolean).join('　') || '無'} : null,
    (shop['洗手間'] && shop['洗手間'] !== '未知') ? {l:'洗手間', v:shop['洗手間']} : null,
  ].filter(Boolean);
  // 地址：本身可點（開地圖），後面「複製」
  const addrRow = addr
    ? `<tr><td class="info-label">地址</td><td><div class="addr-cell"><a class="addr-link" href="${escapeHtml(mapUrl)}" target="_blank">${escapeHtml(addr)}</a><button type="button" class="addr-copy-btn">${_cdIc('copy', '⧉')} 複製</button></div></td></tr>`
    : '';

  const birthday = isBirthday(shop);
  const member   = shop['會員'] === 'Y';
  // 稱號：順序同清單置頂＝協會會員 → 本日壽星 → 新開幕
  const titles = (member          ? '<span class="card-title member-badge">協會會員</span>' : '')
               + (birthday        ? '<span class="card-title birthday-badge">🎂 本日壽星</span>' : '')
               + (isNewOpen(shop) ? '<span class="card-title new-open-badge">新開幕</span>' : '');
  const st = _cardStatus(shop);
  const stText = st.word
    ? `<b>${escapeHtml(st.word)}</b>${st.rest ? `<span class="card-st-rest">，${escapeHtml(st.rest)}</span>` : ''}`
    : `<span class="card-st-rest">${escapeHtml(st.rest)}</span>`;
  return `
  <div class="card${member ? ' member' : ''}${birthday ? ' birthday' : ''}" data-shop-id="${idA}">
    <div class="card-top">
      ${canView('shopPage') ? `<span class="card-ic-row card-lead"><a class="card-ic shop-link-btn${canUse('shopPage') ? '' : ' ff-locked'}" href="shop.html?id=${idA}" target="_blank" title="店家主頁" aria-label="店家主頁">${_cdIc('store', '✈')}</a></span>` : ''}
      <div class="card-shopname">${escapeHtml(name)}</div>
      <span class="card-ic-row card-acts">
        <span class="queue-badge-header" data-id="${idA}" hidden></span>
        <a class="card-ic nav-btn" href="${escapeHtml(mapUrl)}" target="_blank" title="導航" aria-label="導航">${_cdIc('map-pin', '📍')}</a>
        ${canView('favorites') ? `<button type="button" class="card-ic fav-btn${isWarned || !canUse('favorites') ? ' locked' : ''}" data-id="${idA}" title="收藏" aria-label="收藏">${favSet.has(id) ? _cdIc('heart-solid', '♥') : _cdIc('heart', '♡')}</button>` : ''}
        ${canView('stamps') ? `<button type="button" class="card-ic stamp-btn${isWarned || !canUse('stamps') ? ' locked' : ' can-stamp'}${(stampMap[id] ?? 0) >= 1 ? ' stamped' : ''}" data-id="${idA}" data-name="${escapeAttr(name)}" title="踩點" aria-label="踩點">${_cdIc('footprints', '👣')}</button>` : ''}
      </span>
    </div>
    ${titles ? `<div class="card-titles">${titles}</div>` : ''}
    <div class="card-status">
      <span class="card-st ${st.cls}"><span>${stText}</span></span>
      ${dist !== null ? `<span class="card-dist">${formatDist(dist)}</span>` : ''}
    </div>
    <div class="card-bottom">
      <div class="card-tags">${types.map(t=>`<span class="tag">${escapeHtml(t)}</span>`).join('')}${factions.map(t=>`<span class="tag tag-gray">${escapeHtml(t)}</span>`).join('')}</div>
      <span class="card-chevron" aria-hidden="true"></span>
    </div>
    <div class="card-detail">
      <div class="card-detail-inner">
      <div class="card-detail-body">
      <div class="card-tabs">
        <button class="card-tab active" data-tab-target="info">資訊</button>
        ${canView('menuTab')   ? `<button class="card-tab${canUse('menuTab')   ? '' : ' ff-locked'}" data-tab-target="menu">菜單</button>`   : ''}
        ${canView('photosTab') ? `<button class="card-tab${canUse('photosTab') ? '' : ' ff-locked'}" data-tab-target="photos">照片</button>` : ''}
        ${canView('reviews')   ? `<button class="card-tab${canUse('reviews')   ? '' : ' ff-locked'}" data-tab-target="reviews">評論</button>` : ''}
      </div>
      <div class="card-tab-panel active" data-tab-panel="info">
        ${_cardWeekHtml(shop)}
        ${addrRow || detailItems.length ? `<table class="info-table">${addrRow}${detailItems.map(d=>`<tr><td class="info-label">${d.l}</td><td>${d.v}</td></tr>`).join('')}</table>` : ''}
        ${shop['營業備註'] ? `<div class="note-box">${shop['營業備註'].replace(/\n/g,'<br>')}</div>` : ''}
        <div class="link-row card-social-row">${links.join('')}</div>
        ${canView('queueReport') ? `<div class="queue-section" data-shop-id="${idA}">
          <span class="queue-sec-label">🕐 目前排隊狀況</span>
          <div class="queue-count-row"><span class="queue-no-data">展開後載入...</span></div>
          <button class="queue-report-btn${canUse('queueReport') ? '' : ' ff-locked'}" data-id="${idA}" data-name="${escapeAttr(name)}">我要回報</button>
        </div>` : ''}
        ${canView('issueReport') ? `<button class="ir-btn-card${canUse('issueReport') ? '' : ' ff-locked'}" data-id="${idA}" data-name="${escapeAttr(name)}">${_cdIc('circle-alert', '⚑')} 回報問題</button>` : ''}
      </div>
      <div class="card-tab-panel" data-tab-panel="menu">
        ${canView('menuTab') ? `<div class="menu-tab-inner"></div>` : `<p class="tab-placeholder">${_cdIc('utensils', '🍜')} 菜單功能<br>暫不開放</p>`}
      </div>
      <div class="card-tab-panel" data-tab-panel="photos">
        <p class="tab-placeholder">${_cdIc('camera', '📷')} 照片功能<br>即將上線</p>
      </div>
      <div class="card-tab-panel" data-tab-panel="reviews">
        ${canView('reviews') ? '<div class="review-loading">點擊「評論」頁籤載入…</div>' : '<p class="tab-placeholder">' + _cdIc('message-square-text', '💬') + ' 評論功能<br>暫不開放</p>'}
      </div>
      </div>
      </div>
    </div>
  </div>`;
}

// ── 2. render：主入口（清單 / 地圖切換 + 重新渲染） ─────────────────────────
// 薄包裝：對外行為與重構前相同，實際渲染委派給 mainList 實例。
function render() {
  _filtered = getFiltered();
  document.getElementById('resultCount').textContent = _filtered.length;

  if (currentView === 'map') {
    renderMap();
    return;
  }
  mainList.render(_filtered);
  _syncCardListGlobals();
}

// ── 3. _appendCards：薄包裝（維持舊全域名，代理到 mainList） ────────────────
function _appendCards() {
  mainList.appendCards();
  _syncCardListGlobals();
}
