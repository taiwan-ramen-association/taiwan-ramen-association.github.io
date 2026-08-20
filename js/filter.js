// ── filter.js ────────────────────────────────────────────────────────────────
// 搜尋篩選模組：Filter 邏輯、Search Filter Modal、Autocomplete
// 依賴全域變數（finder.html 主 script 提供）：
//   ALL_DATA, NON_ACTIVE_DATA, favSet, stampMap
//   showNonActive, showUnvisited, selectedCities, selectedTypes,
//   selectedDays, mealTime, isNowOpen, locEnabled, locRadius,
//   userLat, userLng, currentView
// 依賴全域函式：
//   toMins, isOpenAt, isNewOpen, isThisMonth, isBirthday,
//   shopDist, switchView, render, showStampToast, serverNow, locateUser

// ── Filter ───────────────────────────────────────────────────────────────────

const DAY_ORDER = {'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'日':7};
const ALL_DAYS  = ['一','二','三','四','五','六','日'];

function shopDays(shop) {
  const days = ALL_DAYS.filter(d => shop['週'+d]);
  if (days.length) return days;
  const raw = shop['營業日'] || '';
  if (!raw || raw === '不固定') return [];
  return raw.split(',').map(d => d.trim()).filter(d => d in DAY_ORDER);
}

function formatDayStr(shop) {
  const days = shopDays(shop);
  if (!days.length) return shop['營業日'] || '';
  return '週' + days.sort((a,b) => DAY_ORDER[a]-DAY_ORDER[b]).join('、');
}

function getFiltered() {
  const query = document.getElementById('searchInput').value.trim().toLowerCase();

  const nonActiveQuery = query === '非營業' || query === '非現存';
  const source = (showNonActive || nonActiveQuery) ? [...ALL_DATA, ...NON_ACTIVE_DATA] : ALL_DATA;
  const result = source.filter(shop => {
    if (showUnvisited && (stampMap[shop['ID']] ?? 0) >= 1) return false;

    // 地區（多選 OR）
    if (selectedCities.size && !selectedCities.has(shop['縣市'])) return false;

    // 類型（多選 OR）
    if (selectedTypes.size) {
      const shopTypes = (shop['類型'] || '').split(',').map(t => t.trim()).filter(Boolean);
      if (!shopTypes.some(t => selectedTypes.has(t))) return false;
    }

    // 附近距離過濾
    if (locEnabled && locRadius > 0 && userLat !== null) {
      const d = shopDist(shop);
      if (d === null || d * 1000 > locRadius) return false;
    }

    if (!showNonActive) {
      // 營業日（多選 OR：任一選中日有開）
      if (selectedDays.size) {
        if (!ALL_DAYS.some(d => selectedDays.has(d) && shop['週' + d])) return false;
      }

      // 用餐時間
      if (mealTime) {
        const mins = toMins(mealTime);
        if (mins === null) return false;
        if (selectedDays.size) {
          if (![...selectedDays].some(d => isOpenAt(shop['週' + d], mins))) return false;
        } else {
          const hasWeekData = ALL_DAYS.some(d => shop['週' + d]);
          const open = hasWeekData
            ? ALL_DAYS.some(d => isOpenAt(shop['週' + d], mins))
            : isOpenAt(shop['營業時段'], mins);
          if (!open) return false;
        }
      }
    }

    if (query) {
      const newOpenQuery  = query === 'new open'    || query === '新開幕';
      const memberQuery   = query === 'member shop' || query === '會員';
      const birthdayQuery = query === '本月壽星';
      if (nonActiveQuery) {
        if (shop['營業狀態'] === '營業中') return false;
      } else if (newOpenQuery) {
        if (!isNewOpen(shop)) return false;
      } else if (memberQuery) {
        if (shop['會員'] !== 'Y') return false;
      } else if (birthdayQuery) {
        if (!isThisMonth(shop)) return false;
      } else {
        const hay = [shop['店名'],shop['地址'],shop['派系'],shop['類型'],shop['醬底']].join(' ').toLowerCase();
        if (!hay.includes(query)) return false;
      }
    }
    return true;
  });

  const sortScore = s => s['會員'] === 'Y' ? 0 : isBirthday(s) ? 1 : 2;
  result.sort((a, b) => {
    const diff = sortScore(a) - sortScore(b);
    if (diff !== 0) return diff;
    if (locEnabled && userLat !== null) return (shopDist(a) ?? Infinity) - (shopDist(b) ?? Infinity);
    return 0;
  });
  return result;
}

// ── 用餐時間 Select 初始化 ────────────────────────────────────────────────────

(function () {
  const sel = document.getElementById('sfMealTime');
  if (!sel) return;
  const opts = ['<option value="">不限</option>'];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 30) {
      const hh = String(h).padStart(2, '0');
      const mm = String(m).padStart(2, '0');
      opts.push(`<option value="${hh}:${mm}">${hh}:${mm}</option>`);
    }
  }
  sel.innerHTML = opts.join('');
})();

// ── Search Filter Modal ───────────────────────────────────────────────────────

function openSfModal() {
  syncSfModal();
  document.getElementById('sfModal').classList.add('open');
  document.getElementById('sfBackdrop').style.display = 'block';
  const inp = document.getElementById('searchInput');
  if (inp) setTimeout(() => inp.focus(), 100);
}

function closeSfModal() {
  document.getElementById('sfModal').classList.remove('open');
  document.getElementById('sfBackdrop').style.display = 'none';
}

function syncSfModal() {
  document.querySelectorAll('#sfCityChips .sf-chip').forEach(btn =>
    btn.classList.toggle('active', selectedCities.has(btn.dataset.city))
  );
  document.querySelectorAll('#sfTypeChips .sf-chip').forEach(btn =>
    btn.classList.toggle('active', selectedTypes.has(btn.dataset.type))
  );
  document.querySelectorAll('#sfDayChips .sf-chip').forEach(btn => {
    btn.classList.toggle('active', selectedDays.has(btn.dataset.day));
    btn.disabled = isNowOpen;
  });
  const mt = document.getElementById('sfMealTime');
  if (mt) { mt.value = mealTime; mt.disabled = isNowOpen; }
  const nowOpenBtn = document.getElementById('sfNowOpen');
  if (nowOpenBtn) nowOpenBtn.classList.toggle('active', isNowOpen);
  const locSel = document.getElementById('sfLocModeSelect');
  if (locSel) { locSel.value = locMode; locSel.classList.toggle('located', locMode !== 'none'); }
  const customRow = document.getElementById('sfCustomLocRow');
  if (customRow) {
    customRow.classList.toggle('visible', locMode === 'custom');
    if (locMode === 'custom') {
      const ci = document.getElementById('sfCustomLocInput');
      const cb = document.getElementById('sfCustomLocConfirm');
      const cl = document.getElementById('sfCustomLocLabel');
      const cr = document.getElementById('sfCustomLocReset');
      if (customLocLabel) {
        if (ci) ci.style.display = 'none';
        if (cb) cb.style.display = 'none';
        if (cl) { cl.textContent = '📍 ' + customLocLabel; cl.style.display = ''; }
        if (cr) cr.style.display = '';
      } else {
        if (ci) { ci.style.display = ''; ci.classList.remove('error'); }
        if (cb) { cb.textContent = '定位'; cb.disabled = false; cb.style.display = ''; }
        if (cl) cl.style.display = 'none';
        if (cr) cr.style.display = 'none';
      }
    }
  }
  const distSel = document.getElementById('sfDistSelect');
  if (distSel) {
    distSel.disabled = !(locEnabled && userLat !== null);
    distSel.value = locRadius ? String(locRadius) : '';
  }
  const sfNonActive = document.getElementById('sfShowNonActive');
  if (sfNonActive) sfNonActive.checked = showNonActive;
  const sfUnvisited = document.getElementById('sfShowUnvisited');
  if (sfUnvisited) sfUnvisited.checked = showUnvisited;
  const sfMap = document.getElementById('sfShowMap');
  if (sfMap) sfMap.checked = (currentView === 'map');
}

function applySfFilters() {
  selectedCities.clear();
  document.querySelectorAll('#sfCityChips .sf-chip.active').forEach(btn =>
    selectedCities.add(btn.dataset.city)
  );
  selectedTypes.clear();
  document.querySelectorAll('#sfTypeChips .sf-chip.active').forEach(btn =>
    selectedTypes.add(btn.dataset.type)
  );
  if (!isNowOpen) {
    selectedDays.clear();
    document.querySelectorAll('#sfDayChips .sf-chip.active').forEach(btn =>
      selectedDays.add(btn.dataset.day)
    );
    const mt = document.getElementById('sfMealTime');
    mealTime = mt ? mt.value : '';
  }
  const distSel = document.getElementById('sfDistSelect');
  if (distSel && locEnabled) locRadius = distSel.value ? parseInt(distSel.value) : 0;
  const sfNonActive = document.getElementById('sfShowNonActive');
  if (sfNonActive) {
    showNonActive = sfNonActive.checked;
    if (showNonActive) { selectedDays.clear(); mealTime = ''; isNowOpen = false; }
  }
  const sfUnvisited = document.getElementById('sfShowUnvisited');
  if (sfUnvisited) showUnvisited = sfUnvisited.checked;
  let viewSwitched = false;
  const sfMap = document.getElementById('sfShowMap');
  if (sfMap) {
    const wantMap = sfMap.checked;
    if (wantMap && currentView !== 'map')  { switchView('map');  viewSwitched = true; }
    else if (!wantMap && currentView !== 'list') { switchView('list'); viewSwitched = true; }
  }
  updateSfTrigger();
  closeSfModal();
  if (!viewSwitched) render();
}

function clearSfFilters() {
  selectedCities.clear();
  selectedTypes.clear();
  selectedDays.clear();
  mealTime     = '';
  isNowOpen    = false;
  showNonActive  = false;
  showUnvisited  = false;
  document.querySelectorAll('.sf-chip.active').forEach(c => c.classList.remove('active'));
  document.querySelectorAll('#sfDayChips .sf-chip').forEach(c => { c.disabled = false; });
  const mt = document.getElementById('sfMealTime');
  if (mt) { mt.value = ''; mt.disabled = false; }
  const nowOpenBtn = document.getElementById('sfNowOpen');
  if (nowOpenBtn) nowOpenBtn.classList.remove('active');
  const sfNonActive = document.getElementById('sfShowNonActive');
  if (sfNonActive) sfNonActive.checked = false;
  const sfUnvisited = document.getElementById('sfShowUnvisited');
  if (sfUnvisited) sfUnvisited.checked = false;
  const inp = document.getElementById('searchInput');
  if (inp) inp.value = '';
  // 清除定位
  deactivateLocate();
  const customRow = document.getElementById('sfCustomLocRow');
  if (customRow) {
    customRow.classList.remove('visible');
    const ci = document.getElementById('sfCustomLocInput');
    const cb = document.getElementById('sfCustomLocConfirm');
    const cl = document.getElementById('sfCustomLocLabel');
    const cr = document.getElementById('sfCustomLocReset');
    if (ci) { ci.value = ''; ci.style.display = ''; ci.classList.remove('error'); }
    if (cb) { cb.textContent = '定位'; cb.disabled = false; cb.style.display = ''; }
    if (cl) cl.style.display = 'none';
    if (cr) cr.style.display = 'none';
  }
  updateSfTrigger();
}

function updateSfTrigger() {
  const badge    = document.getElementById('sfBadge');
  const trigText = document.getElementById('sfTriggerText');
  const query    = (document.getElementById('searchInput') || {}).value?.trim() || '';

  const tags = [];
  if (query)                            tags.push(query);
  if (isNowOpen)                        tags.push('現在營業中');
  if (selectedCities.size)             [...selectedCities].forEach(c => tags.push(c));
  if (selectedTypes.size)              [...selectedTypes].forEach(t => tags.push(t));
  if (selectedDays.size && !isNowOpen) {
    const sorted = ALL_DAYS.filter(d => selectedDays.has(d));
    tags.push('週' + sorted.join(''));
  }
  if (mealTime && !isNowOpen)           tags.push(mealTime);
  if (locEnabled && userLat !== null) {
    const locTag = locMode === 'custom'
      ? ('🗺️ ' + (customLocLabel || '指定位置'))
      : '📍 附近';
    tags.push(locTag + (locRadius >= 1000 ? ' ' + locRadius/1000 + 'km' : locRadius ? ' ' + locRadius + 'm' : ''));
  }
  if (showNonActive)                    tags.push('含非現存');
  if (showUnvisited)                    tags.push('未踩點');

  let count = 0;
  if (query)                            count++;
  if (isNowOpen)                        count++;
  else { if (selectedDays.size) count++; if (mealTime) count++; }
  if (selectedCities.size)             count++;
  if (selectedTypes.size)              count++;
  if (locEnabled && userLat !== null)  count++;
  if (showNonActive)                   count++;
  if (showUnvisited)                   count++;

  if (tags.length) {
    if (badge)    { badge.textContent = count; badge.style.display = ''; }
    if (trigText) { trigText.textContent = tags.join(' · '); trigText.classList.add('has-query'); }
  } else {
    if (badge)    badge.style.display = 'none';
    if (trigText) { trigText.textContent = '搜尋店名、地址、派系…'; trigText.classList.remove('has-query'); }
  }
  renderFilterChips();
}

// ── 主畫面篩選 chip（finder.html 專用；finder-beta 無 #filterChips → 早退）────
function renderFilterChips() {
  const wrap = document.getElementById('filterChips');
  if (!wrap) return;
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const query = (document.getElementById('searchInput') || {}).value?.trim() || '';
  const chips = [];
  if (query)               chips.push({ label: query, type: 'query' });
  if (isNowOpen)           chips.push({ label: '🟢 現在營業中', type: 'nowOpen' });
  if (selectedCities.size) [...selectedCities].forEach(c => chips.push({ label: c, type: 'city', value: c }));
  if (selectedTypes.size)  [...selectedTypes].forEach(t => chips.push({ label: t, type: 'type', value: t }));
  if (selectedDays.size && !isNowOpen)
    chips.push({ label: '週' + ALL_DAYS.filter(d => selectedDays.has(d)).join(''), type: 'days' });
  if (mealTime && !isNowOpen) chips.push({ label: mealTime, type: 'meal' });
  if (locEnabled && userLat !== null) {
    const base = locMode === 'custom' ? ('🗺️ ' + (customLocLabel || '指定位置')) : '📍 附近';
    const r = locRadius >= 1000 ? ' ' + locRadius/1000 + 'km' : locRadius ? ' ' + locRadius + 'm' : '';
    chips.push({ label: base + r, type: 'loc' });
  }
  if (showNonActive) chips.push({ label: '含非現存', type: 'nonActive' });
  if (showUnvisited) chips.push({ label: '未踩點', type: 'unvisited' });

  if (!chips.length) { wrap.innerHTML = ''; return; }
  let html = chips.map(c =>
    `<button class="fchip" data-ctype="${c.type}" data-cvalue="${escapeAttr(c.value || '')}">` +
    `<span>${esc(c.label)}</span><span class="fchip-x">✕</span></button>`
  ).join('');
  if (chips.length > 1) html += `<button class="fchip-clear">清除全部</button>`;
  wrap.innerHTML = html;
}

function removeFilterChip(type, value) {
  switch (type) {
    case 'query':     { const i = document.getElementById('searchInput'); if (i) i.value = ''; break; }
    case 'nowOpen':   isNowOpen = false; selectedDays.clear(); mealTime = ''; break;
    case 'city':      selectedCities.delete(value); break;
    case 'type':      selectedTypes.delete(value); break;
    case 'days':      selectedDays.clear(); break;
    case 'meal':      mealTime = ''; break;
    case 'loc':       deactivateLocate(); break;   // 內含 render()
    case 'nonActive': showNonActive = false; break;
    case 'unvisited': showUnvisited = false; break;
  }
  if (typeof syncSfModal === 'function') syncSfModal();
  updateSfTrigger();
  render();
}

(function () {
  const wrap = document.getElementById('filterChips');
  if (!wrap) return;
  wrap.addEventListener('click', e => {
    if (e.target.closest('.fchip-clear')) { clearSfFilters(); render(); return; }
    const chip = e.target.closest('.fchip');
    if (chip) removeFilterChip(chip.dataset.ctype, chip.dataset.cvalue);
  });
})();

function toggleNowOpen() {
  isNowOpen = !isNowOpen;
  const btn = document.getElementById('sfNowOpen');
  if (btn) btn.classList.toggle('active', isNowOpen);
  if (isNowOpen) {
    const now = serverNow();
    const DAY_NAMES = ['日','一','二','三','四','五','六'];
    const day = DAY_NAMES[now.getDay()];
    const rounded = Math.floor((now.getHours() * 60 + now.getMinutes()) / 30) * 30;
    const hh = String(Math.floor(rounded / 60)).padStart(2, '0');
    const mm = String(rounded % 60).padStart(2, '0');
    selectedDays.clear();
    selectedDays.add(day);
    mealTime = `${hh}:${mm}`;
    document.querySelectorAll('#sfDayChips .sf-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.day === day);
    });
    const mt = document.getElementById('sfMealTime');
    if (mt) { mt.value = mealTime; mt.disabled = true; }
    document.querySelectorAll('#sfDayChips .sf-chip').forEach(c => c.disabled = true);
  } else {
    selectedDays.clear();
    mealTime = '';
    document.querySelectorAll('#sfDayChips .sf-chip').forEach(c => {
      c.classList.remove('active');
      c.disabled = false;
    });
    const mt = document.getElementById('sfMealTime');
    if (mt) { mt.value = ''; mt.disabled = false; }
  }
}

// ── Autocomplete ─────────────────────────────────────────────────────────────

(function () {
  const inp = document.getElementById('searchInput');
  const ac  = document.getElementById('searchAutocomplete');
  if (!inp || !ac) return;
  let acActive = -1;

  function getItems() { return ac.querySelectorAll('.sf-autocomplete-item'); }

  function setActive(idx) {
    getItems().forEach((el, i) => el.classList.toggle('ac-active', i === idx));
    acActive = idx;
  }

  function updateAc() {
    const q = inp.value.trim().toLowerCase();
    acActive = -1;
    if (q.length < 1 || typeof ALL_DATA === 'undefined' || !ALL_DATA.length) { ac.style.display = 'none'; return; }
    const matches = ALL_DATA.filter(s =>
      (s['店名'] || '').toLowerCase().includes(q)
    ).slice(0, 8);
    if (!matches.length) { ac.style.display = 'none'; return; }
    ac.innerHTML = matches.map(s => `
      <div class="sf-autocomplete-item" data-id="${s['ID'] || ''}">
        <div class="sf-autocomplete-name">${s['店名'] || ''}</div>
        <div class="sf-autocomplete-sub">${[s['縣市'], s['地址'] ? s['地址'].slice(0, 20) : ''].filter(Boolean).join('・')}</div>
      </div>
    `).join('');
    ac.style.display = 'block';
  }

  function selectItem(item) {
    const shop = ALL_DATA.find(s => s['ID'] === item.dataset.id);
    if (!shop) return;
    inp.value = shop['店名'];
    ac.style.display = 'none';
    acActive = -1;
    updateSfTrigger();
    render();
  }

  inp.addEventListener('input', updateAc);

  inp.addEventListener('keydown', e => {
    const items = getItems();
    if (ac.style.display === 'none' || !items.length) {
      if (e.key === 'Escape') inp.blur();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(Math.min(acActive + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(acActive - 1, -1));
    } else if (e.key === 'Enter' && acActive >= 0) {
      e.preventDefault();
      selectItem(items[acActive]);
    } else if (e.key === 'Escape') {
      ac.style.display = 'none';
      acActive = -1;
    }
  });

  ac.addEventListener('click', e => {
    const item = e.target.closest('.sf-autocomplete-item');
    if (item) selectItem(item);
  });

  document.addEventListener('click', e => {
    if (!inp.contains(e.target) && !ac.contains(e.target)) {
      ac.style.display = 'none';
      acActive = -1;
    }
  });
})();

// ── 指定位置 Geocoding ────────────────────────────────────────────────────────

async function geocodeQuery(q) {
  // GPS 格式直接解析，不打 API
  const gps = q.match(/^(-?\d+\.?\d*)\s*[,，]\s*(-?\d+\.?\d*)$/);
  if (gps) {
    const lat = parseFloat(gps[1]), lng = parseFloat(gps[2]);
    return { lat, lng, label: `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
  }
  // Places API (New) Text Search — 與照片功能共用同一把 key，支援 referrer 限制
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': PLACES_KEY,
      'X-Goog-FieldMask': 'places.displayName,places.location'
    },
    body: JSON.stringify({ textQuery: q, languageCode: 'zh-TW', regionCode: 'TW', maxResultCount: 1 })
  });
  if (!res.ok) throw new Error('查詢失敗');
  const data = await res.json();
  if (!data.places?.length) throw new Error('找不到此地點');
  const place = data.places[0];
  return {
    lat:   place.location.latitude,
    lng:   place.location.longitude,
    label: place.displayName?.text || q
  };
}

async function handleCustomLocConfirm() {
  const inp = document.getElementById('sfCustomLocInput');
  const btn = document.getElementById('sfCustomLocConfirm');
  const lbl = document.getElementById('sfCustomLocLabel');
  const rst = document.getElementById('sfCustomLocReset');
  const q   = inp.value.trim();
  if (!q) return;
  inp.classList.remove('error');
  btn.textContent = '⏳';
  btn.disabled = true;
  try {
    const { lat, lng, label } = await geocodeQuery(q);
    inp.style.display = 'none';
    btn.style.display = 'none';
    lbl.textContent   = '📍 ' + label;
    lbl.style.display = '';
    rst.style.display = '';
    activateCustomLocate(lat, lng, label);
    updateSfTrigger();
  } catch (err) {
    inp.classList.add('error');
    btn.textContent = '定位';
    btn.disabled = false;
    showStampToast(err.message || '找不到地點');
  }
}

// ── Event Listeners ──────────────────────────────────────────────────────────

// sf-day chips
document.querySelectorAll('#sfDayChips .sf-chip').forEach(btn => {
  btn.addEventListener('click', () => btn.classList.toggle('active'));
});

// sf-chips-scroll: 滑鼠滾輪轉橫向捲動（桌面版）
document.querySelectorAll('.sf-chips-scroll').forEach(el => {
  el.addEventListener('wheel', e => {
    if (e.deltaY === 0) return;
    e.preventDefault();
    el.scrollLeft += e.deltaY;
  }, { passive: false });
});

// sf-modal open/close
document.getElementById('sfTrigger').addEventListener('click', openSfModal);
document.getElementById('sfBackdrop').addEventListener('click', closeSfModal);
document.getElementById('sfClose').addEventListener('click', closeSfModal);
document.getElementById('sfApplyBtn').addEventListener('click', applySfFilters);
document.getElementById('sfClearBtn').addEventListener('click', clearSfFilters);

// search input — live filter as user types
document.getElementById('searchInput').addEventListener('input', () => {
  updateSfTrigger();
  render();
});

// Now open
document.getElementById('sfNowOpen').addEventListener('click', toggleNowOpen);

// 定位模式切換
document.getElementById('sfLocModeSelect').addEventListener('change', e => {
  const mode = e.target.value;
  locMode = mode;
  const row = document.getElementById('sfCustomLocRow');
  if (mode === 'none') {
    deactivateLocate();
    if (row) row.classList.remove('visible');
  } else if (mode === 'device') {
    if (row) row.classList.remove('visible');
    startDeviceLocate();
  } else { // custom
    deactivateLocate();
    if (row) {
      row.classList.add('visible');
      if (!customLocLabel) {
        const ci = document.getElementById('sfCustomLocInput');
        if (ci) setTimeout(() => ci.focus(), 50);
      }
    }
  }
});

// 指定位置：確認 / Enter / ✕
document.getElementById('sfCustomLocConfirm').addEventListener('click', handleCustomLocConfirm);
document.getElementById('sfCustomLocInput').addEventListener('keydown', e => {
  if (e.isComposing || e.keyCode === 229) return; // 忽略 IME 輸入法組字中（macOS 注音/倉頡）
  if (e.key === 'Enter') { e.preventDefault(); handleCustomLocConfirm(); }
});
document.getElementById('sfCustomLocReset').addEventListener('click', () => {
  customLocLabel = '';
  deactivateLocate();
  const sel = document.getElementById('sfLocModeSelect');
  if (sel) { sel.value = 'custom'; sel.classList.remove('located'); }
  locMode = 'custom';
  const ci = document.getElementById('sfCustomLocInput');
  const cb = document.getElementById('sfCustomLocConfirm');
  const cl = document.getElementById('sfCustomLocLabel');
  const rst = document.getElementById('sfCustomLocReset');
  if (ci) { ci.value = ''; ci.style.display = ''; ci.classList.remove('error'); setTimeout(() => ci.focus(), 50); }
  if (cb) { cb.textContent = '定位'; cb.disabled = false; cb.style.display = ''; }
  if (cl) cl.style.display = 'none';
  if (rst) rst.style.display = 'none';
});

document.getElementById('sfDistSelect').addEventListener('change', e => {
  locRadius = e.target.value ? parseInt(e.target.value) : 0;
  if (locEnabled && userLat !== null) render();
});

// Meal time (select — value read on Apply)
document.getElementById('sfMealTime').addEventListener('change', e => {
  mealTime = e.target.value;
});

// 其他設定 expand/collapse（整列可點）
document.getElementById('sfOtherHeader').addEventListener('click', () => {
  const body = document.getElementById('sfOtherBody');
  const btn  = document.getElementById('sfExpandBtn');
  const open = body.classList.toggle('open');
  btn.textContent = open ? '收起 ▴' : '展開 ▾';
});
