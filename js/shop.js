// ── shop.js ──────────────────────────────────────────────────────────────────
// 店家主頁：載入 data.json 找店家、渲染靜態資訊、tabs（評論/菜單/照片）
// 依賴全域（shop.html inline script 提供）：
//   auth, db, storage, firebase
//   currentUserRole, currentDisplayName, currentAvatarUrl, isWarned
//   stampMap, reviewMap, favSet, _currentShop
//   canView, canUse, showAccessToast
//   escapeHtml, escapeAttr, isValidUrl, showStampToast
//   getShopById, findShopById, render
// 依賴模組：reviews.js, menus.js, photos.js

const ALL_DAYS = ['一','二','三','四','五','六','日'];
const _tabLoaded = { reviews: false, menus: false, photos: false };

// ── Entry point（shop.html inline script 呼叫）────────────────────────────────
async function initShop() {
  const params = new URLSearchParams(location.search);
  const shopId = params.get('id');

  // 關閉按鈕（新分頁開啟，無返回意義）
  const backBtn = document.getElementById('backBtn');
  if (backBtn) {
    backBtn.addEventListener('click', e => { e.preventDefault(); window.close(); });
  }

  if (!shopId) { showShopState('notFoundState'); return; }

  // 載入 data.json
  let shop = null;
  try {
    const res  = await fetch('data/data.json');
    const list = await res.json();
    shop = list.find(s => s['ID'] === shopId) || null;
  } catch(e) {
    console.error('data.json 載入失敗', e);
  }

  if (!shop) { showShopState('notFoundState'); return; }

  // 設定全域（供 getShopById / findShopById 使用）
  _currentShop = shop;

  document.title = (shop['店名'] || '店家') + ' | 台灣拉麵協會';

  renderShopPage(shop);
  showShopState('shopContent');

  bindTabs(shopId, shop);
  // 不預載 tab — 等 onShopAuthChange 確認登入狀態後再載入，避免重複渲染
}

// ── Auth state 改變（shop.html inline 第二次呼叫）──────────────────────────────
function onShopAuthChange(user) {
  // 重設當前 tab 的載入狀態，讓登入後的 tab 能重新載入
  const activePane = document.querySelector('.tab-pane.active');
  if (!activePane) return;
  const tab    = activePane.dataset.pane;
  const shopId = _currentShop?.['ID'];
  if (!shopId || !['reviews','menus','photos'].includes(tab)) return;

  _tabLoaded[tab] = false;
  activePane.innerHTML = '';
  loadTabContent(tab, shopId, _currentShop);
}

// ── State display ─────────────────────────────────────────────────────────────
function showShopState(id) {
  ['loadingState','notFoundState','shopContent'].forEach(s => {
    const el = document.getElementById(s);
    if (el) el.style.display = s === id ? '' : 'none';
  });
}

// ── Render static shop info ───────────────────────────────────────────────────
function renderShopPage(shop) {
  // Name
  document.getElementById('shopName').textContent = shop['店名'] || '';

  // Status badge（非現存）
  const statusBadge = document.getElementById('shopStatusBadge');
  const status = shop['營業狀態'];
  if (status && status !== '營業中') {
    const cls = status === '暫停營業' ? 's-pause' : status === '籌備中' ? 's-prep' : 'nl-closed';
    statusBadge.outerHTML =
      `<span id="shopStatusBadge" class="shop-status-badge ${cls}">${escapeHtml(status)}</span>`;
  }

  // Address
  const addrLink = document.getElementById('shopAddressLink');
  if (shop['地址']) {
    document.getElementById('shopAddress').textContent = shop['地址'];
    addrLink.href = isValidUrl(shop['Map'])
      ? shop['Map']
      : `https://www.google.com/maps/search/${encodeURIComponent(shop['地址'])}`;
    addrLink.style.display = '';
  }

  // Hours
  document.getElementById('shopHoursWrap').innerHTML = renderHours(shop);

  // Tags
  const types    = (shop['類型']  || '').split(',').map(t => t.trim()).filter(Boolean);
  const factions = (shop['派系']  || '').split(',').map(t => t.trim()).filter(Boolean);
  if (types.length || factions.length) {
    const tagsEl = document.getElementById('shopTags');
    tagsEl.innerHTML =
      types.map(t    => `<span class="tag">${escapeHtml(t)}</span>`).join('') +
      factions.map(t => `<span class="tag tag-gray">${escapeHtml(t)}</span>`).join('');
    tagsEl.style.display = '';
  }

  // Detail table
  const detailItems = [
    shop['支付方式']                                                           ? { l:'支付',  v: shop['支付方式']  } : null,
    shop['排隊方式']                                                           ? { l:'排隊',  v: shop['排隊方式']  } : null,
    shop['點餐方式']                                                           ? { l:'點餐',  v: shop['點餐方式']  } : null,
    shop['醬底']                                                               ? { l:'醬底',  v: shop['醬底']      } : null,
    (shop['吧台數'] || shop['桌位數'])                                         ? { l:'座位',  v:
      [shop['吧台數'] && shop['吧台數'] !== '0' ? `吧台 ${shop['吧台數']}` : '',
       shop['桌位數'] && shop['桌位數'] !== '0' ? `桌位 ${shop['桌位數']}` : ''].filter(Boolean).join('　') || '無'
    } : null,
    shop['洗手間'] && shop['洗手間'] !== '未知'                                ? { l:'洗手間', v: shop['洗手間']   } : null,
  ].filter(Boolean);

  if (detailItems.length) {
    const tbl = document.getElementById('shopDetailTable');
    tbl.innerHTML = detailItems.map(d =>
      `<tr><td class="info-label">${escapeHtml(d.l)}</td><td>${escapeHtml(d.v)}</td></tr>`
    ).join('');
    tbl.style.display = '';
  }

  // Notes
  if (shop['營業備註']) {
    const noteEl = document.getElementById('shopNoteBox');
    noteEl.innerHTML = escapeHtml(shop['營業備註']).replace(/\n/g,'<br>');
    noteEl.style.display = '';
  }

  // Social links
  const links = [];
  if (isValidUrl(shop['Instagram'])) links.push(`<a href="${escapeHtml(shop['Instagram'])}" target="_blank" class="link-btn link-ig">📷 Instagram</a>`);
  if (isValidUrl(shop['Facebook']))  links.push(`<a href="${escapeHtml(shop['Facebook'])}"  target="_blank" class="link-btn link-fb">👥 Facebook</a>`);
  if (links.length) {
    const linksEl = document.getElementById('shopLinksRow');
    linksEl.innerHTML = links.join('');
    linksEl.style.display = '';
  }
}

// ── Hours table ───────────────────────────────────────────────────────────────
function renderHours(shop) {
  const hasWeekData = ALL_DAYS.some(d => shop['週' + d]);
  const todayDow    = new Date().getDay();              // 0=Sun
  const todayIdx    = todayDow === 0 ? 6 : todayDow - 1; // 轉 0=Mon

  if (hasWeekData) {
    const rows = ALL_DAYS.map((d, i) => {
      const hours   = shop['週' + d];
      const isToday = i === todayIdx;
      const timeStr = hours ? hours.replace(/\n/g,'　') : '公休';
      return `<tr${isToday ? ' class="hours-today"' : ''}>
        <td class="hours-day">週${d}${isToday ? '<span class="today-badge">今天</span>' : ''}</td>
        <td class="hours-time${!hours ? ' hours-closed' : ''}">${escapeHtml(timeStr)}</td>
      </tr>`;
    }).join('');
    return `<table class="hours-table"><tbody>${rows}</tbody></table>`;
  }

  const ts = shop['營業時段'];
  if (ts) {
    return `<div class="hours-simple">📅 ${escapeHtml(ts.replace(/\n/g,'　'))}</div>`;
  }
  return '';
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function bindTabs(shopId, shop) {
  document.querySelectorAll('#shopTabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('#shopTabs .tab-btn').forEach(b =>
        b.classList.toggle('active', b === btn)
      );
      document.querySelectorAll('.tab-pane').forEach(p =>
        p.classList.toggle('active', p.dataset.pane === tab)
      );
      loadTabContent(tab, shopId, shop);
    });
  });
}

// ── Lazy tab load ─────────────────────────────────────────────────────────────
function loadTabContent(tab, shopId, shop) {
  const pane = document.getElementById(tab + 'Pane');
  if (!pane) return;

  if (tab === 'reviews') {
    if (!canView('reviews')) { pane.innerHTML = loginPromptHtml('登入後查看評論'); return; }
    if (_tabLoaded.reviews) return;
    _tabLoaded.reviews = true;
    loadReviews(shopId, pane);

  } else if (tab === 'menus') {
    if (!canView('menuTab')) { pane.innerHTML = loginPromptHtml('登入後查看菜單'); return; }
    if (_tabLoaded.menus) return;
    _tabLoaded.menus = true;
    loadShopMenu(shop, pane);

  } else if (tab === 'photos') {
    if (!canView('photosTab')) { pane.innerHTML = loginPromptHtml('登入後查看照片'); return; }
    if (_tabLoaded.photos) return;
    _tabLoaded.photos = true;
    loadShopPhotos(shop, pane);
  }
}

// ── Login prompt ──────────────────────────────────────────────────────────────
function loginPromptHtml(msg) {
  return `<div class="login-prompt">
    <div class="login-prompt-icon">🔒</div>
    <p>${escapeHtml(msg)}</p>
    <button class="login-prompt-btn" onclick="doShopLogin()">以 Google 帳號登入</button>
  </div>`;
}

function doShopLogin() {
  const p = new firebase.auth.GoogleAuthProvider();
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
  if (isStandalone) { auth.signInWithRedirect(p); return; }
  auth.signInWithPopup(p).catch(err => {
    if (err.code === 'auth/popup-blocked') auth.signInWithRedirect(p);
    else if (err.code !== 'auth/popup-closed-by-user') console.error('登入失敗', err);
  });
}
