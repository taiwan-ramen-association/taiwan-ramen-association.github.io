// ── map.js ────────────────────────────────────────────────────────────────────
// 地圖與定位模組：Geolocation helpers、Leaflet map、GPS locate、地圖 render
// 依賴全域變數（finder-beta.html 主 script 提供）：
//   userLat, userLng, userMarker, userAccCircle
//   leafletMap, markerLayer
//   locEnabled, locRadius, locMode, customLocLabel
//   watchId, followMode, currentView
//   ALL_DAYS, selectedDays
// 依賴全域函式：
//   render, showStampToast, getFiltered, formatDayStr, isValidUrl

// ── Geolocation helpers ───────────────────────────────────────────────────────

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDist(km) {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

function shopDist(shop) {
  if (userLat === null || !shop.lat || !shop.lng) return null;
  return haversine(userLat, userLng, parseFloat(shop.lat), parseFloat(shop.lng));
}

// ── Map markers ───────────────────────────────────────────────────────────────

function showUserMarker(accuracy) {
  if (!leafletMap || userLat === null) return;
  if (userMarker)    leafletMap.removeLayer(userMarker);
  if (userAccCircle) leafletMap.removeLayer(userAccCircle);
  userMarker = L.circleMarker([userLat, userLng], {
    radius: 8, color: '#fff', weight: 2.5, fillColor: '#1a73e8', fillOpacity: 1
  }).addTo(leafletMap).bindPopup('你在這裡');
  if (accuracy && accuracy < 800) {
    userAccCircle = L.circle([userLat, userLng], {
      radius: accuracy,
      color: '#1a73e8', weight: 1, fillColor: '#1a73e8', fillOpacity: 0.1,
      interactive: false
    }).addTo(leafletMap);
  }
}

function fitLocate() {
  if (!leafletMap || userLat === null) return;
  leafletMap.invalidateSize();
  const R    = 900;
  const dLat = R / 111320;
  const dLng = R / (111320 * Math.cos(userLat * Math.PI / 180));
  leafletMap.fitBounds([
    [userLat - dLat, userLng - dLng],
    [userLat + dLat, userLng + dLng]
  ]);
}

// ── 定位模式切換 ───────────────────────────────────────────────────────────────

function deactivateLocate() {
  locEnabled = false;
  userLat = userLng = null;
  locMode = 'none';
  customLocLabel = '';
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; followMode = false; }
  if (userMarker    && leafletMap) { leafletMap.removeLayer(userMarker);    userMarker    = null; }
  if (userAccCircle && leafletMap) { leafletMap.removeLayer(userAccCircle); userAccCircle = null; }
  const distSel = document.getElementById('sfDistSelect');
  if (distSel) distSel.disabled = true;
  const sel = document.getElementById('sfLocModeSelect');
  if (sel) { sel.value = 'none'; sel.classList.remove('located'); sel.disabled = false; }
  render();
}

function activateCustomLocate(lat, lng, label) {
  locEnabled = true;
  locMode = 'custom';
  userLat = lat;
  userLng = lng;
  customLocLabel = label;
  const distSel = document.getElementById('sfDistSelect');
  if (distSel) { distSel.disabled = false; if (!distSel.value) distSel.value = '2000'; }
  locRadius = distSel && distSel.value ? parseInt(distSel.value) : 2000;
  const sel = document.getElementById('sfLocModeSelect');
  if (sel) sel.classList.add('located');
  render();
}

function startDeviceLocate() {
  const sel     = document.getElementById('sfLocModeSelect');
  const distSel = document.getElementById('sfDistSelect');
  if (!navigator.geolocation) {
    showStampToast('此瀏覽器不支援 GPS 定位');
    if (sel) { sel.value = 'none'; sel.classList.remove('located'); }
    locMode = 'none';
    return;
  }
  if (sel) { sel.disabled = true; sel.classList.remove('located'); }
  navigator.geolocation.getCurrentPosition(pos => {
    locEnabled = true;
    locMode = 'device';
    userLat = pos.coords.latitude;
    userLng = pos.coords.longitude;
    locRadius = distSel && distSel.value ? parseInt(distSel.value) : 2000;
    if (sel) { sel.disabled = false; sel.classList.add('located'); }
    if (distSel) { distSel.disabled = false; if (!distSel.value) distSel.value = '2000'; }
    if (leafletMap) { showUserMarker(pos.coords.accuracy); fitLocate(); }
    render();
  }, () => {
    if (sel) { sel.disabled = false; sel.value = 'none'; sel.classList.remove('located'); }
    locMode = 'none';
    showStampToast('無法取得位置，請確認已允許定位權限');
  });
}

// ── GPS 跟隨模式 ───────────────────────────────────────────────────────────────

function toggleFollow() {
  if (!navigator.geolocation) { alert('此瀏覽器不支援 GPS 定位'); return; }
  if (followMode) {
    navigator.geolocation.clearWatch(watchId);
    watchId    = null;
    followMode = false;
    const btn = document.querySelector('.map-ctrl-btn.following');
    if (btn) btn.classList.remove('following');
  } else {
    followMode = true;
    const followBtn = document.getElementById('followMapBtn');
    if (followBtn) followBtn.classList.add('following');
    let firstFix = true;
    watchId = navigator.geolocation.watchPosition(pos => {
      userLat = pos.coords.latitude;
      userLng = pos.coords.longitude;
      const sfLb = document.getElementById('sfLocModeSelect');
      if (sfLb) { sfLb.value = 'device'; sfLb.classList.add('located'); }
      locMode = 'device';
      showUserMarker(pos.coords.accuracy);
      if (followMode && leafletMap) {
        if (firstFix) { fitLocate(); firstFix = false; }
        else leafletMap.panTo([userLat, userLng]);
      }
      render();
    }, () => {
      followMode = false;
      if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
      const followBtn = document.getElementById('followMapBtn');
      if (followBtn) followBtn.classList.remove('following');
      showStampToast('定位失敗，請確認定位權限');
    }, { enableHighAccuracy: true });
  }
}

// ── 地圖初始化與渲染 ───────────────────────────────────────────────────────────

function switchView(v) {
  currentView = v;
  document.getElementById('cardList').style.display     = v === 'list' ? '' : 'none';
  document.getElementById('mapContainer').style.display = v === 'map'  ? 'block' : 'none';
  const sfShowMap = document.getElementById('sfShowMap');
  if (sfShowMap) sfShowMap.checked = (v === 'map');
  if (v === 'map' && !leafletMap) initMap();
  render();
}

function initMap() {
  leafletMap  = L.map('mapContainer').setView([23.97, 120.97], 8);
  markerLayer = L.layerGroup().addTo(leafletMap);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 19
  }).addTo(leafletMap);

  // 左下角：縮放到自身位置（約 1km）
  const LocateMeControl = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd() {
      const btn = L.DomUtil.create('button', 'map-ctrl-btn map-ctrl-locate');
      btn.title = '縮放到我的位置（約 1 公里範圍）';
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/></svg>`;
      L.DomEvent.on(btn, 'click', L.DomEvent.stop);
      L.DomEvent.on(btn, 'click', () => {
        if (!navigator.geolocation) { showStampToast('此瀏覽器不支援 GPS 定位'); return; }
        btn.style.opacity = '0.5';
        btn.disabled = true;
        navigator.geolocation.getCurrentPosition(pos => {
          userLat = pos.coords.latitude;
          userLng = pos.coords.longitude;
          btn.style.opacity = '';
          btn.disabled = false;
          showUserMarker(pos.coords.accuracy);
          fitLocate();
          const sfLb = document.getElementById('sfLocModeSelect');
          if (sfLb) { sfLb.value = 'device'; sfLb.classList.add('located'); }
          locEnabled = true;
          locMode = 'device';
          render();
        }, () => {
          btn.style.opacity = '';
          btn.disabled = false;
          showStampToast('無法取得位置，請確認已允許定位權限');
        }, { enableHighAccuracy: true, timeout: 8000 });
      });
      return btn;
    }
  });
  new LocateMeControl().addTo(leafletMap);

  leafletMap.on('dragstart', () => { if (followMode) toggleFollow(); });

  showUserMarker();
}

function renderMap() {
  if (!leafletMap) return;
  markerLayer.clearLayers();

  const icon = L.divIcon({
    className: '',
    html: '<div style="width:13px;height:13px;background:#C8272D;border:2px solid white;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.4)"></div>',
    iconSize: [13, 13], iconAnchor: [6, 6], popupAnchor: [0, -8]
  });

  const filtered = getFiltered().filter(s => s.lat && s.lng);
  if (!filtered.length) return;

  const bounds = [];
  filtered.forEach(shop => {
    const lat = parseFloat(shop.lat);
    const lng = parseFloat(shop.lng);
    if (isNaN(lat) || isNaN(lng)) return;

    const dayStr = formatDayStr(shop);
    const openTimes = [...new Set(ALL_DAYS.map(d => shop['週'+d]).filter(Boolean))];
    const hours = openTimes.length === 1 ? openTimes[0].replace(/\n/g, '　')
      : openTimes.length > 1 ? (selectedDays.size === 1 ? (shop['週'+ [...selectedDays][0]] || '依日而異') : '依日而異')
      : (shop['營業時段'] || '').replace(/\n/g, '　');
    const mapUrl = isValidUrl(shop['Map']) ? shop['Map']
      : `https://www.google.com/maps/search/${encodeURIComponent(shop['地址'] || shop['店名'])}`;

    const popup = `
      <div>
        <div class="map-popup-name">${shop['店名']}</div>
        ${dayStr ? `<div class="map-popup-meta">📅 ${dayStr}${hours ? '　' + hours : ''}</div>` : ''}
        ${shop['地址'] ? `<div class="map-popup-meta">📍 ${shop['地址']}</div>` : ''}
        ${shop['營業備註'] ? `<div class="map-popup-note">${shop['營業備註']}</div>` : ''}
        <a href="${escapeHtml(mapUrl)}" target="_blank" class="map-popup-link">開啟 Google 地圖 →</a>
      </div>`;

    L.marker([lat, lng], { icon }).bindPopup(popup, { maxWidth: 250 }).addTo(markerLayer);
    bounds.push([lat, lng]);
  });

  if (bounds.length === 1) {
    leafletMap.setView(bounds[0], 15);
  } else if (bounds.length > 1) {
    leafletMap.fitBounds(bounds, { padding: [30, 30] });
  }
}
