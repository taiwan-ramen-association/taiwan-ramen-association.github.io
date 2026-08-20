// ── card.js ──────────────────────────────────────────────────────────────────
// 店家卡片：渲染、展開/收起、tab 切換、卡片內按鈕（收藏/踩點/排隊/問題回報）
// 依賴全域（其他 JS 模組）：
//   getFiltered, ALL_DAYS, selectedDays（filter.js）
//   renderMap（map.js）
//   canView, canUse, showAccessToast, isWarned, auth, db（auth.js）
//   favSet, stampMap, toggleFav, openStampModal（stamps.js）
//   loadShopMenu（menus.js）
//   loadShopPhotos（photos.js）
//   loadReviews（reviews.js）
// 依賴全域（finder.html 主 inline script）：
//   shopDist, formatDayStr, isValidUrl, isNewOpen, isBirthday, nonActiveLabel,
//   formatDist, escapeAttr, findShopById, refreshQueueSection,
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

// ── 清單實例工廠 ─────────────────────────────────────────────────────────────
// opts.batchSize   每批渲染筆數（預設 20）；Infinity = 一次渲染完、不掛 IntersectionObserver
// opts.emptyHTML   空清單時顯示的內容
// opts.onFavToggle 收藏鈕按下後的額外行為（收藏頁用；Phase 4 接灰卡）
function createCardList(containerId, opts = {}) {
  const batchSize = opts.batchSize ?? 20;
  const emptyHTML = opts.emptyHTML
    ?? '<div class="empty-state"><div class="big">\u{1F35C}</div><p>找不到符合的店家<br>請調整篩選條件</p></div>';

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
    while (frag.firstChild) list.appendChild(frag.firstChild);
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
        if (e.target.closest('a') || e.target.closest('.fav-btn') || e.target.closest('.stamp-btn') || e.target.closest('.queue-report-btn') || e.target.closest('.write-review-btn') || e.target.closest('.review-del-btn') || e.target.closest('.review-photo-thumb') || e.target.closest('.review-load-more') || e.target.closest('.review-comment-form') || e.target.closest('.review-comments-more') || e.target.closest('.card-tab') || e.target.closest('.mnu-thumb') || e.target.closest('.mnu-del-btn') || e.target.closest('.photo-grid-item')) return;
        // 已展開時點 card-detail 內部不縮起
        if (card.classList.contains('expanded') && e.target.closest('.card-detail')) return;
        if (expanded && expanded !== card) expanded.classList.remove('expanded');
        card.classList.toggle('expanded');
        expanded = card.classList.contains('expanded') ? card : null;
        _syncCardListGlobals();
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
        btn.textContent = favSet.has(id) ? '\u2665' : '\u2661';
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

  // 容器層事件委派：ir-btn-card + 店家主頁連結。
  // 取代舊的「對 #cardList 寫死一次」，改成每個實例綁自己的容器。
  const listEl = getList();
  if (listEl) {
    listEl.addEventListener('click', e => {
      // 店家主頁連結：perm 不足（ff-locked）時攔截導頁 + 提示
      if (e.target.closest('.shop-link-btn.ff-locked')) { e.preventDefault(); showAccessToast(); return; }
      const btn = e.target.closest('.ir-btn-card');
      if (!btn) return;
      if (btn.classList.contains('ff-locked')) { showAccessToast(); return; }
      openIrModal(btn.dataset.id, btn.dataset.name);
    });
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
  emptyHTML: '<div class="empty-state"><div class="big">♡</div>'
    + '<p>還沒有收藏的店家<br>在搜尋頁點愛心就能加入</p>'
    + '<button class="empty-cta" id="favEmptyCta">去找店家</button></div>',
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

// ── 1. renderCard：產生單一卡片 HTML ─────────────────────────────────────────
function renderCard(shop) {
  const dist    = shopDist(shop);
  const dayStr  = formatDayStr(shop);
  const openTimes = [...new Set(ALL_DAYS.map(d => shop['週'+d]).filter(Boolean))];
  const hours = openTimes.length === 1 ? openTimes[0].replace(/\n/g, '　')
    : openTimes.length > 1 ? (selectedDays.size === 1 ? (shop['週'+ [...selectedDays][0]] || '依日而異') : '依日而異')
    : (shop['營業時段'] || '').replace(/\n/g, '　');
  const hasWeekData = ALL_DAYS.some(d => shop['週'+d]);
  const offDay = hasWeekData
    ? ALL_DAYS.filter(d => !shop['週'+d]).join('、')
    : (shop['店休日'] || '').replace(/,/g, '、');
  const types   = (shop['類型']     || '').split(',').map(t=>t.trim()).filter(Boolean);
  const factions= (shop['派系']     || '').split(',').map(t=>t.trim()).filter(Boolean);

  // Map button
  const hasMap  = isValidUrl(shop['Map']);
  const mapUrl  = hasMap ? shop['Map']
    : `https://www.google.com/maps/search/${encodeURIComponent(shop['地址'] || shop['店名'])}`;
  const mapBtn  = shop['地址']
    ? `<a href="${escapeHtml(mapUrl)}" target="_blank" class="map-btn">
         <span class="map-btn-icon">📍</span>
         ${shop['地址']}
       </a>`
    : '';

  const links = [];
  if (isValidUrl(shop['Instagram'])) links.push(`<a href="${escapeHtml(shop['Instagram'])}" target="_blank" class="link-btn link-ig">📷 Instagram</a>`);
  if (isValidUrl(shop['Facebook']))  links.push(`<a href="${escapeHtml(shop['Facebook'])}"  target="_blank" class="link-btn link-fb">👥 Facebook</a>`);

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

  const birthday = isBirthday(shop);
  const member   = shop['會員'] === 'Y';
  const openNow  = typeof isOpenNow === 'function' ? isOpenNow(shop) : null;
  const isActiveShop = !shop['營業狀態'] || shop['營業狀態'] === '營業中';
  const nowPill  = (!isActiveShop || openNow === null) ? ''
    : openNow ? '<span class="now-pill is-open">營業中</span>'
              : '<span class="now-pill is-closed">已打烊</span>';
  return `
  <div class="card${member ? ' member' : ''}${birthday ? ' birthday' : ''}" data-shop-id="${escapeAttr(shop['ID'] || '')}">
    <div class="card-header">
      <div class="card-name">${shop['店名']}${nonActiveLabel(shop['營業狀態'])}${nowPill}</div>
      <div style="display:flex;gap:5px;align-items:center;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end">
        ${dist !== null ? `<span class="dist-badge">${formatDist(dist)}</span>` : ''}
        ${birthday ? '<span class="birthday-badge">🎂 本日壽星</span>' : ''}
        ${shop['會員'] === 'Y' ? '<span class="member-badge">MEMBER SHOP</span>' : ''}
        ${isNewOpen(shop) ? '<span class="new-open-badge">NEW OPEN</span>' : ''}
        ${canView('shopPage') ? `<a class="shop-link-btn${canUse('shopPage') ? '' : ' ff-locked'}" href="shop.html?id=${escapeAttr(shop['ID'] || '')}" target="_blank" title="店家主頁" onclick="if(typeof gtag!=='undefined')gtag('event','shop_page_open',{shop_id:'${escapeAttr(shop['ID'] || '')}',shop_name:'${escapeAttr(shop['店名'] || '')}'})">✈</a>` : ''}
        <span class="queue-badge-header" data-id="${escapeAttr(shop['ID'] || '')}" hidden></span>
        ${canView('favorites') ? `<button class="fav-btn${isWarned || !canUse('favorites') ? ' locked' : ''}" data-id="${escapeAttr(shop['ID'] || '')}">${favSet.has(shop['ID']) ? '♥' : '♡'}</button>` : ''}
        ${canView('stamps') ? `<button class="stamp-btn${isWarned || !canUse('stamps') ? ' locked' : ' can-stamp'}${(stampMap[shop['ID']] ?? 0) >= 1 ? ' stamped' : ''}" data-id="${escapeAttr(shop['ID'] || '')}" data-name="${escapeAttr(shop['店名'] || '')}" title="踩點">👣</button>` : ''}
      </div>
    </div>
    <div class="card-meta">
      <div class="card-meta-main">
        <div class="meta-row">
          ${dayStr ? `<span><span class="meta-icon">📅</span><span class="meta-text">${dayStr}${hours ? '　' + hours : ''}${offDay && offDay !== '無' ? '　休：' + offDay : ''}</span></span>` : ''}
        </div>
      </div>
      <span class="card-chevron" aria-hidden="true"></span>
    </div>
    ${types.length || factions.length ? `
    <div class="tags">
      ${types.map(t=>`<span class="tag">${t}</span>`).join('')}
      ${factions.map(t=>`<span class="tag tag-gray">${t}</span>`).join('')}
    </div>` : ''}
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
        ${mapBtn}
        ${detailItems.length ? `<table class="info-table">${detailItems.map(d=>`<tr><td class="info-label">${d.l}</td><td>${d.v}</td></tr>`).join('')}</table>` : ''}
        ${shop['營業備註'] ? `<div class="note-box">${shop['營業備註'].replace(/\n/g,'<br>')}</div>` : ''}
        ${links.length ? `<div class="link-row card-social-row">${links.join('')}</div>` : ''}
        ${canView('queueReport') ? `<div class="queue-section" data-shop-id="${escapeAttr(shop['ID'] || '')}">
          <span class="queue-sec-label">🕐 目前排隊狀況</span>
          <div class="queue-count-row"><span class="queue-no-data">展開後載入...</span></div>
          <button class="queue-report-btn${canUse('queueReport') ? '' : ' ff-locked'}" data-id="${escapeAttr(shop['ID'] || '')}" data-name="${escapeAttr(shop['店名'] || '')}">我要回報</button>
        </div>` : ''}
        ${canView('issueReport') ? `<button class="ir-btn-card${canUse('issueReport') ? '' : ' ff-locked'}" data-id="${escapeAttr(shop['ID'] || '')}" data-name="${escapeAttr(shop['店名'] || '')}">⚑ 回報問題</button>` : ''}
      </div>
      <div class="card-tab-panel" data-tab-panel="menu">
        ${canView('menuTab') ? `<div class="menu-tab-inner"></div>` : `<p class="tab-placeholder">🍜 菜單功能<br>暫不開放</p>`}
      </div>
      <div class="card-tab-panel" data-tab-panel="photos">
        <p class="tab-placeholder">📷 照片功能<br>即將上線</p>
      </div>
      <div class="card-tab-panel" data-tab-panel="reviews">
        ${canView('reviews') ? '<div class="review-loading">點擊「評論」頁籤載入…</div>' : '<p class="tab-placeholder">💬 評論功能<br>暫不開放</p>'}
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
