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
//   openQueueModal, openIrModal, showFavOnly, currentView
// 提供全域：
//   renderCard, render, _filtered, expandedCard（其他模組未直接讀寫，僅 card.js 內部用）

// ── State ────────────────────────────────────────────────────────────────────
var _filtered        = [];
let _displayedCount  = 0;
let _scrollObserver  = null;
let expandedCard     = null;

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
        ${canView('shopPage') ? `<a class="shop-link-btn" href="shop.html?id=${escapeAttr(shop['ID'] || '')}" target="_blank" title="店家主頁" onclick="if(typeof gtag!=='undefined')gtag('event','shop_page_open',{shop_id:'${escapeAttr(shop['ID'] || '')}',shop_name:'${escapeAttr(shop['店名'] || '')}'})">✈</a>` : ''}
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
function render() {
  if (_scrollObserver) { _scrollObserver.disconnect(); _scrollObserver = null; }
  _filtered = getFiltered();
  document.getElementById('resultCount').textContent = _filtered.length;

  if (currentView === 'map') {
    renderMap();
    return;
  }

  const list = document.getElementById('cardList');
  expandedCard = null;
  list.innerHTML = '';
  _displayedCount = 0;

  if (!_filtered.length) {
    list.innerHTML = `<div class="empty-state"><div class="big">🍜</div><p>找不到符合的店家<br>請調整篩選條件</p></div>`;
    return;
  }
  _appendCards();
}

// ── 3. _appendCards：分批渲染 + 無限滾動 ─────────────────────────────────────
function _appendCards() {
  if (_scrollObserver) { _scrollObserver.disconnect(); _scrollObserver = null; }
  const list = document.getElementById('cardList');
  const batch = _filtered.slice(_displayedCount, _displayedCount + 20);
  if (!batch.length) return;

  const frag = document.createElement('div');
  frag.innerHTML = batch.map(renderCard).join('');
  _bindCardEvents(frag);
  while (frag.firstChild) list.appendChild(frag.firstChild);
  _displayedCount += batch.length;

  if (_displayedCount < _filtered.length) {
    const sentinel = document.createElement('div');
    sentinel.className = 'scroll-sentinel';
    list.appendChild(sentinel);
    _scrollObserver = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) _appendCards();
    }, { rootMargin: '200px' });
    _scrollObserver.observe(sentinel);
  }
}

// ── 4. _bindCardEvents：卡片內所有事件綁定 ───────────────────────────────────
function _bindCardEvents(scope) {
  scope.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('a') || e.target.closest('.fav-btn') || e.target.closest('.stamp-btn') || e.target.closest('.queue-report-btn') || e.target.closest('.write-review-btn') || e.target.closest('.review-del-btn') || e.target.closest('.review-photo-thumb') || e.target.closest('.review-load-more') || e.target.closest('.review-comment-form') || e.target.closest('.review-comments-more') || e.target.closest('.card-tab') || e.target.closest('.mnu-thumb') || e.target.closest('.mnu-del-btn') || e.target.closest('.photo-grid-item')) return;
      // 已展開時點 card-detail 內部不縮起
      if (card.classList.contains('expanded') && e.target.closest('.card-detail')) return;
      if (expandedCard && expandedCard !== card) expandedCard.classList.remove('expanded');
      card.classList.toggle('expanded');
      expandedCard = card.classList.contains('expanded') ? card : null;
      if (expandedCard) {
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
      btn.textContent = favSet.has(id) ? '♥' : '♡';
      if (showFavOnly) render();
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

// ── 5. ir-btn-card 事件委派（整個 cardList） ─────────────────────────────────
document.getElementById('cardList').addEventListener('click', e => {
  const btn = e.target.closest('.ir-btn-card');
  if (!btn) return;
  if (btn.classList.contains('ff-locked')) { showAccessToast(); return; }
  openIrModal(btn.dataset.id, btn.dataset.name);
});
