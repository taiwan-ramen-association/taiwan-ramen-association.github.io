// ── profile.js ─────────────────────────────────────────────────────────────
// 個人頁主邏輯：載入 profile、5 個 tab 內容（評論/踩點/菜單/地圖/挑戰）、隱私設定
// 依賴全域（profile.html 提供）：
//   auth, db, firebase, targetUid, viewerUid, isSelf
//   showState(id), openPv(url), canView(feature), currentUserRole

// ── 共用：跳脫 HTML ────────────────────────────────────────────────────────
function pfEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ── 共用：店家資料快取 ─────────────────────────────────────────────────────
let _pfShopMap = null;       // ID → shop 物件
async function getShopMap() {
  if (_pfShopMap) return _pfShopMap;
  try {
    const res = await fetch('data/data.json');
    const list = await res.json();
    _pfShopMap = {};
    list.forEach(s => { if (s.ID) _pfShopMap[s.ID] = s; });
    return _pfShopMap;
  } catch (e) {
    console.error('載入 data.json 失敗', e);
    return {};
  }
}

// ── 入口 ────────────────────────────────────────────────────────────────────
async function initProfile(viewerUid, targetUid, isSelf, currentUser) {
  // 1. 讀 userProfiles/{targetUid}
  let profileDoc = null;
  try {
    const snap = await db.collection('userProfiles').doc(targetUid).get();
    if (!snap.exists) { showState('notFoundState'); return; }
    profileDoc = snap.data();
  } catch (e) {
    console.error('讀取 profile 失敗', e);
    showState('notFoundState');
    return;
  }

  // 2. 隱私檢查：profilePublic !== true（未設定也視為私人）且非本人 → 私人
  if (!isSelf && profileDoc.profilePublic !== true) {
    showState('privateState');
    return;
  }

  // 3. 顯示 profile content
  showState('profileContent');
  renderHeader(profileDoc, isSelf);

  // 4. 非本人 → 隱藏「踩點」「地圖」「挑戰」tab 與 踩點 stat
  //    （userVisits / challengeSubmissions / userChallengeProgress 皆為私人，僅本人可讀）
  if (!isSelf) {
    document.querySelector('.tab-btn[data-tab="visits"]')?.style.setProperty('display', 'none');
    document.querySelector('.tab-btn[data-tab="map"]')?.style.setProperty('display', 'none');
    document.querySelector('.tab-btn[data-tab="challenges"]')?.style.setProperty('display', 'none');
    const visitStat = document.getElementById('statVisits')?.closest('.stat');
    if (visitStat) visitStat.style.display = 'none';
  } else {
    // 本人 + canView('challengesNav') → 顯示挑戰 tab
    // canView 通過但 canUse 不過 → 加 ff-locked 樣式（與 nav bar 一致）
    if (typeof canView === 'function' && canView('challengesNav')) {
      const tabBtn = document.getElementById('pfChallengesTabBtn');
      if (tabBtn) {
        tabBtn.style.setProperty('display', '');
        if (typeof canUse === 'function' && !canUse('challengesNav')) {
          tabBtn.classList.add('ff-locked');
        }
      }
    }
  }

  // 5. 統計數字
  loadStats(targetUid, isSelf);

  // 6. 預設啟動評論 tab
  loadReviewsTab(targetUid);
  bindTabSwitching(targetUid);

  // 6. 本人 → 顯示 self-actions 區塊（Google 帳號資訊、登出、設定）
  if (isSelf) {
    // 會員卡顯示用暱稱（不顯示編號，避免曝光註冊人數）
    _mcNickname = profileDoc.nickname || profileDoc.displayName ||
                  (currentUser && currentUser.displayName) || '會員';
    renderSelfActions(currentUser);
    bindSettingsModal(targetUid, profileDoc);
    // 自助領券：登入後自動派發（背景執行，不阻塞畫面）
    runSelfServeDispatch(viewerUid, currentUser);
  }
}

// ── Self-actions（設定按鈕顯示；Google 帳號資訊 + 登出已移入 settings modal）──
function renderSelfActions(user) {
  const selfActions = document.getElementById('selfActions');
  if (!selfActions) return;
  selfActions.style.display = '';

  // 會員卡按鈕
  const memberCardBtn = document.getElementById('memberCardBtn');
  if (memberCardBtn) {
    memberCardBtn.style.display = '';
    memberCardBtn.addEventListener('click', () => {
      // viewerUid / currentUserRole 是 profile.html 的全域變數
      openMemberCardModal(viewerUid, currentUserRole);
    });
  }

  // 設定按鈕顯示
  const settingsBtn = document.getElementById('settingsBtn');
  if (settingsBtn) settingsBtn.style.display = '';

  // Settings modal 內的 Google 帳號資訊
  const googleAvatar = document.getElementById('pfGoogleAvatar');
  if (googleAvatar) {
    googleAvatar.src = user.photoURL || 'assets/icons/03.png';
    googleAvatar.onerror = () => { googleAvatar.src = 'assets/icons/03.png'; };
  }
  const el = id => document.getElementById(id);
  if (el('pfGoogleName'))  el('pfGoogleName').textContent  = user.displayName || '';
  if (el('pfGoogleEmail')) el('pfGoogleEmail').textContent = user.email || '';

  // Settings modal 內的登出按鈕
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      try {
        await firebase.auth().signOut();
        location.href = 'finder.html';
      } catch (e) {
        alert('登出失敗：' + e.message);
      }
    });
  }
}

// ── Header（頭像、暱稱）────────────────────────────────────────────────────
function renderHeader(profile, isSelf) {
  const avatar = document.getElementById('profileAvatar');
  avatar.src = profile.avatarUrl || profile.photoURL || 'assets/icons/03.png';
  avatar.onerror = () => { avatar.src = 'assets/icons/03.png'; };
  document.getElementById('profileNickname').textContent =
    profile.nickname || profile.displayName || '匿名用戶';
  document.title = (profile.nickname || profile.displayName || '個人頁') + ' | 台灣拉麵協會';
}

// ── 統計數字（評論、踩點、菜單）────────────────────────────────────────────
async function loadStats(uid, isSelf) {
  // 評論數（公開）
  db.collection('reviews').where('uid', '==', uid).get()
    .then(snap => { document.getElementById('statReviews').textContent = snap.size; })
    .catch(() => { document.getElementById('statReviews').textContent = '?'; });

  // 踩點數（私人，僅本人可讀）
  if (isSelf) {
    db.collection('userVisits').doc(uid).get()
      .then(snap => {
        const visits = snap.exists ? (snap.data().visits || {}) : {};
        const count = Object.values(visits).filter(v => v && v > 0).length;
        document.getElementById('statVisits').textContent = count;
      })
      .catch(() => { document.getElementById('statVisits').textContent = '?'; });
  }

  // 菜單數（公開）
  db.collection('menus').where('uid', '==', uid).get()
    .then(snap => { document.getElementById('statMenus').textContent = snap.size; })
    .catch(() => { document.getElementById('statMenus').textContent = '?'; });
}

// ── Tab 切換 ────────────────────────────────────────────────────────────────
const _tabLoaded = { reviews: false, visits: false, menus: false, map: false, challenges: false };

function bindTabSwitching(uid) {
  _tabLoaded.reviews = true; // 已預載
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      // 切換 active 狀態
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === tab));
      // lazy load
      if (!_tabLoaded[tab]) {
        _tabLoaded[tab] = true;
        if (tab === 'visits') loadVisitsTab(uid);
        else if (tab === 'menus') loadMenusTab(uid);
        else if (tab === 'map')  loadMapTab(uid);
        else if (tab === 'challenges') loadChallengesTab(uid);
      }
    });
  });
}

// ── Tab 1：評論 ────────────────────────────────────────────────────────────
async function loadReviewsTab(uid) {
  const pane = document.getElementById('reviewsTabPane');
  pane.innerHTML = '<div class="item-loading">載入中…</div>';
  try {
    const snap = await db.collection('reviews')
      .where('uid', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();
    if (!snap.docs.length) {
      pane.innerHTML = '<div class="item-empty">尚未發表評論</div>';
      return;
    }
    pane.innerHTML = snap.docs.map(doc => {
      const d = doc.data();
      const ts = d.createdAt?.toDate?.();
      const dateStr = ts ? ts.toLocaleDateString('zh-TW', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
      const stars = '★'.repeat(d.rating || 0) + '☆'.repeat(5 - (d.rating || 0));
      const photosHtml = (d.photos || []).map(p =>
        `<img class="pf-review-photo" data-url="${pfEscape(p.original)}" src="${pfEscape(p.thumb || p.original)}" alt="">`
      ).join('');
      const shopLink = d.shopId
        ? `<a href="finder.html?id=${pfEscape(d.shopId)}">📍 ${pfEscape(d.shopName || '')}</a>`
        : `📍 ${pfEscape(d.shopName || '')}`;
      return `
        <div class="pf-review-card">
          <div class="pf-review-shop">${shopLink}<span class="pf-review-stars">${stars}</span><span class="pf-review-date">${dateStr}</span></div>
          ${d.text ? `<div class="pf-review-text">${pfEscape(d.text)}</div>` : ''}
          ${photosHtml ? `<div class="pf-review-photos">${photosHtml}</div>` : ''}
        </div>`;
    }).join('');
    // 照片點擊
    pane.querySelectorAll('.pf-review-photo').forEach(img => {
      img.addEventListener('click', () => openPv(img.dataset.url));
    });
  } catch (e) {
    console.error('載入評論失敗', e);
    pane.innerHTML = `<div class="item-empty">載入失敗：${pfEscape(e.message)}</div>`;
  }
}

// ── Tab 2：踩點清單 ────────────────────────────────────────────────────────
async function loadVisitsTab(uid) {
  const pane = document.getElementById('visitsTabPane');
  pane.innerHTML = '<div class="item-loading">載入中…</div>';
  try {
    const [visitSnap, shopMap] = await Promise.all([
      db.collection('userVisits').doc(uid).get(),
      getShopMap()
    ]);
    const visits = visitSnap.exists ? (visitSnap.data().visits || {}) : {};
    const visited = Object.entries(visits).filter(([_, v]) => v && v > 0);
    if (!visited.length) {
      pane.innerHTML = '<div class="item-empty">尚未踩點任何店家</div>';
      return;
    }
    // 排序：以 visit score 由高到低
    visited.sort((a, b) => b[1] - a[1]);
    pane.innerHTML = visited.map(([shopId, score]) => {
      const shop = shopMap[shopId];
      if (!shop) return '';
      const name = shop['店名'] || shopId;
      const addr = shop['地址'] || '';
      return `
        <div class="pf-visit-card">
          <div>
            <a href="finder.html?id=${pfEscape(shopId)}">${pfEscape(name)}</a>
            <div class="pf-visit-meta">${pfEscape(addr)}</div>
          </div>
          <div class="pf-visit-meta">踩點 ${score}</div>
        </div>`;
    }).join('') || '<div class="item-empty">踩點記錄對應的店家資料缺失</div>';
  } catch (e) {
    console.error('載入踩點失敗', e);
    pane.innerHTML = `<div class="item-empty">載入失敗：${pfEscape(e.message)}</div>`;
  }
}

// ── Tab 3：菜單照片 ────────────────────────────────────────────────────────
async function loadMenusTab(uid) {
  const pane = document.getElementById('menusTabPane');
  pane.innerHTML = '<div class="item-loading">載入中…</div>';
  try {
    const snap = await db.collection('menus')
      .where('uid', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();
    if (!snap.docs.length) {
      pane.innerHTML = '<div class="item-empty">尚未上傳菜單照片</div>';
      return;
    }
    pane.innerHTML = '<div class="pf-menu-grid">' + snap.docs.map(doc => {
      const d = doc.data();
      const url = d.photo?.original || d.photo?.thumb || '';
      const thumb = d.photo?.thumb || d.photo?.original || '';
      return `
        <div class="pf-menu-card">
          <img class="pf-menu-photo" data-url="${pfEscape(url)}" src="${pfEscape(thumb)}" alt="">
          <div class="pf-menu-shop">📍 ${pfEscape(d.shopName || '')}</div>
        </div>`;
    }).join('') + '</div>';
    pane.querySelectorAll('.pf-menu-photo').forEach(img => {
      img.addEventListener('click', () => openPv(img.dataset.url));
    });
  } catch (e) {
    console.error('載入菜單失敗', e);
    pane.innerHTML = `<div class="item-empty">載入失敗：${pfEscape(e.message)}</div>`;
  }
}

// ── Tab 4：踩點地圖 ────────────────────────────────────────────────────────
async function loadMapTab(uid) {
  const pane = document.getElementById('mapTabPane');
  pane.innerHTML = '<div class="item-loading">載入中…</div>';
  try {
    const [visitSnap, shopMap] = await Promise.all([
      db.collection('userVisits').doc(uid).get(),
      getShopMap()
    ]);
    const visits = visitSnap.exists ? (visitSnap.data().visits || {}) : {};
    const visited = Object.keys(visits).filter(id => visits[id] && visits[id] > 0);

    if (!visited.length) {
      pane.innerHTML = '<div class="item-empty">尚未踩點任何店家</div>';
      return;
    }

    // 重建容器（移除 loading）
    pane.innerHTML = '';
    pane.style.height = '460px';

    const map = L.map(pane).setView([23.97, 120.97], 7);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      attribution: '© OpenStreetMap © CARTO',
      maxZoom: 18
    }).addTo(map);

    const bounds = [];
    visited.forEach(shopId => {
      const shop = shopMap[shopId];
      if (!shop || !shop.lat || !shop.lng) return;
      const lat = parseFloat(shop.lat), lng = parseFloat(shop.lng);
      if (isNaN(lat) || isNaN(lng)) return;
      const m = L.circleMarker([lat, lng], {
        radius: 7, color: '#fff', weight: 2,
        fillColor: '#C8272D', fillOpacity: 0.9
      }).bindPopup(`<b>${pfEscape(shop['店名'] || '')}</b><br><a href="finder.html?id=${pfEscape(shopId)}">查看詳情</a>`);
      m.addTo(map);
      bounds.push([lat, lng]);
    });

    if (bounds.length === 1) map.setView(bounds[0], 13);
    else if (bounds.length > 1) map.fitBounds(bounds, { padding: [30, 30] });

    // 切換到此 tab 時需要 invalidateSize（Leaflet 容器隱藏時無法正確計算尺寸）
    setTimeout(() => map.invalidateSize(), 100);
  } catch (e) {
    console.error('載入地圖失敗', e);
    pane.innerHTML = `<div class="item-empty">載入失敗：${pfEscape(e.message)}</div>`;
  }
}

// ── 圖片壓縮工具（for 頭像上傳）─────────────────────────────────────────────
function _pfCompressImage(file, { maxPx = 400, maxKB = 100 } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width: w, height: h } = img;
      if (w > maxPx || h > maxPx) {
        const r = Math.min(maxPx / w, maxPx / h);
        w = Math.round(w * r); h = Math.round(h * r);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const tryQ = q => new Promise(res => canvas.toBlob(res, 'image/webp', q));
      (async () => {
        let q = 0.85;
        let blob = await tryQ(q);
        while (blob.size > maxKB * 1024 && q > 0.3) { q -= 0.1; blob = await tryQ(q); }
        resolve(blob);
      })();
    };
    img.onerror = reject;
    img.src = url;
  });
}

// ── 設定 Modal（本人專用）──────────────────────────────────────────────────
function bindSettingsModal(uid, profile) {
  const modal = document.getElementById('settingsModal');
  const toggle = document.getElementById('publicToggle');
  // 未設定（missing）視為私人，僅 profilePublic === true 才公開
  toggle.checked = profile.profilePublic === true;

  // 制霸排名公開開關（預設不公開）
  const domToggle = document.getElementById('dominationPublicToggle');
  if (domToggle) {
    domToggle.checked = profile.dominationPublic === true;
    domToggle.addEventListener('change', async () => {
      const newVal = domToggle.checked;
      domToggle.disabled = true;
      try {
        await db.collection('userProfiles').doc(uid).set(
          { dominationPublic: newVal },
          { merge: true }
        );
        // 首次開啟且 conqueredCount 尚未初始化 → 從 userVisits 補算
        // visitedTownsCount / fullTownsCount / totalScore 由 domination.html 跑完後寫入
        if (newVal && profile.conqueredCount == null) {
          db.collection('userVisits').doc(uid).get().then(snap => {
            const visits = snap.exists ? (snap.data().visits || {}) : {};
            const cnt = Object.values(visits).filter(v => v != null && (v >= 1 || v === 20)).length;
            db.collection('userProfiles').doc(uid).set({ conqueredCount: cnt }, { merge: true }).catch(() => {});
            profile.conqueredCount = cnt;
          }).catch(() => {});
        }
      } catch (e) {
        alert('儲存失敗：' + e.message);
        domToggle.checked = !newVal;
      }
      domToggle.disabled = false;
    });
  }

  // ── 暱稱 ──────────────────────────────────────────────────────────────────
  const nickInput   = document.getElementById('pfNicknameInput');
  const nickSaveBtn = document.getElementById('pfNicknameSaveBtn');
  if (nickInput && profile.nickname) nickInput.value = profile.nickname;

  if (nickSaveBtn) {
    nickSaveBtn.addEventListener('click', async () => {
      const nickname = (nickInput?.value || '').trim();
      nickSaveBtn.disabled = true; nickSaveBtn.textContent = '儲存中…';
      try {
        await db.collection('users').doc(uid).update({ nickname });
        await db.collection('userProfiles').doc(uid).set(
          { nickname, displayName: nickname || '' },
          { merge: true }
        );
        // 更新頁面上的暱稱顯示
        const nicknameEl = document.getElementById('profileNickname');
        if (nicknameEl && nickname) nicknameEl.textContent = nickname;
        // 同步會員卡暱稱
        if (nickname) _mcNickname = nickname;
        nickSaveBtn.textContent = '✅ 已儲存';
        setTimeout(() => { nickSaveBtn.textContent = '儲存'; }, 2000);
      } catch (e) {
        alert('儲存失敗：' + e.message);
        nickSaveBtn.textContent = '儲存';
      }
      nickSaveBtn.disabled = false;
    });
  }

  // ── 頭像 ──────────────────────────────────────────────────────────────────
  const avatarPreview = document.getElementById('pfAvatarPreview');
  const avatarBtn     = document.getElementById('pfAvatarBtn');
  const avatarInput   = document.getElementById('pfAvatarInput');

  // 預覽目前頭像
  if (avatarPreview) {
    avatarPreview.src = profile.avatarUrl || profile.photoURL || 'assets/icons/03.png';
    avatarPreview.onerror = () => { avatarPreview.src = 'assets/icons/03.png'; };
  }

  if (avatarBtn && avatarInput) {
    avatarBtn.addEventListener('click', () => avatarInput.click());
    avatarInput.addEventListener('change', async () => {
      const file = avatarInput.files[0];
      if (!file) return;
      avatarInput.value = '';
      avatarBtn.disabled = true; avatarBtn.textContent = '上傳中…';
      try {
        const blob = await _pfCompressImage(file, { maxPx: 400, maxKB: 100 });
        const snap = await storage.ref(`avatars/${uid}.webp`).put(blob, { contentType: 'image/webp' });
        const url  = await snap.ref.getDownloadURL();
        await db.collection('users').doc(uid).update({ avatarUrl: url });
        await db.collection('userProfiles').doc(uid).set({ avatarUrl: url }, { merge: true });
        if (avatarPreview) avatarPreview.src = url;
        // 同步更新頁面大頭貼
        const profileAvatar = document.getElementById('profileAvatar');
        if (profileAvatar) profileAvatar.src = url;
        try { localStorage.setItem('avatarCache_' + uid, url); } catch {}
        avatarBtn.textContent = '✅ 已更新';
        setTimeout(() => { avatarBtn.textContent = '更換'; avatarBtn.disabled = false; }, 2000);
      } catch (e) {
        alert('頭像上傳失敗：' + e.message);
        avatarBtn.textContent = '更換';
        avatarBtn.disabled = false;
      }
    });
  }

  document.getElementById('settingsBtn').addEventListener('click', () => {
    modal.classList.add('open');
  });
  document.getElementById('settingsCloseBtn').addEventListener('click', () => {
    modal.classList.remove('open');
  });
  modal.addEventListener('click', e => {
    if (e.target === modal) modal.classList.remove('open');
  });

  toggle.addEventListener('change', async () => {
    const newVal = toggle.checked;
    toggle.disabled = true;
    try {
      await db.collection('userProfiles').doc(uid).set(
        { profilePublic: newVal },
        { merge: true }
      );
    } catch (e) {
      alert('儲存失敗：' + e.message);
      toggle.checked = !newVal; // revert
    }
    toggle.disabled = false;
  });

  // ── 清除我的所有記憶（從 finder 搬移；10 秒倒數後才可確認）──────────────────
  const clearBtn     = document.getElementById('pfClearDataBtn');
  const clearOverlay = document.getElementById('clearOverlay');
  if (clearBtn && clearOverlay) {
    const cntEl     = document.getElementById('clearCountdown');
    const confirmEl = document.getElementById('clearConfirmBtn');
    const cancelEl  = document.getElementById('clearCancelBtn');
    let _clearTimer = null;

    clearBtn.addEventListener('click', () => {
      clearOverlay.classList.add('show');
      confirmEl.disabled = true;
      confirmEl.textContent = '確認清除';
      cntEl.className = 'clear-ov-count';
      let n = 10;
      cntEl.textContent = n;
      clearInterval(_clearTimer);
      _clearTimer = setInterval(() => {
        n--;
        cntEl.textContent = n;
        if (n <= 0) {
          clearInterval(_clearTimer);
          confirmEl.disabled = false;
          cntEl.classList.add('ready');
        }
      }, 1000);
    });

    cancelEl.addEventListener('click', () => {
      clearInterval(_clearTimer);
      clearOverlay.classList.remove('show');
    });

    confirmEl.addEventListener('click', async () => {
      confirmEl.disabled = true; confirmEl.textContent = '清除中…';
      try {
        await db.collection('users').doc(uid).update({
          favorites: firebase.firestore.FieldValue.delete()
        });
        await db.collection('userVisits').doc(uid).delete();
        clearOverlay.classList.remove('show');
        alert('✓ 所有記憶已清除');
        location.reload();
      } catch (e) {
        alert('清除失敗：' + e.message);
        confirmEl.disabled = false; confirmEl.textContent = '確認清除';
      }
    });
  }
}

// ── Tab 5：挑戰 ────────────────────────────────────────────────────────────
async function loadChallengesTab(uid) {
  const pane = document.getElementById('challengesTabPane');
  if (!pane) return;

  // 權限不足 → 顯示尚未開放，不查 Firestore
  if (typeof canUse === 'function' && !canUse('challengesNav')) {
    pane.innerHTML = '<div class="item-empty">🔒 此功能尚未開放</div>';
    return;
  }

  pane.innerHTML = '<div class="item-loading">載入中…</div>';

  try {
    // 平行抓：所有挑戰 + 使用者所有送出紀錄
    const [chSnap, subSnap] = await Promise.all([
      db.collection('challenges').limit(50).get(),
      db.collection('challengeSubmissions')
        .where('uid', '==', uid)
        .orderBy('createdAt', 'desc')
        .limit(100)
        .get(),
    ]);

    const challenges  = chSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const submissions = subSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (!challenges.length) {
      pane.innerHTML = '<div class="item-empty">目前沒有挑戰活動</div>';
      return;
    }

    // 依日期由新到舊排（用 period.end 字串排序即可，因為都是 YYYY-MM-DD）
    challenges.sort((a, b) => (b.period?.end || '').localeCompare(a.period?.end || ''));

    // 用戶進度（每個 challenge 抓一個 doc）
    const progress = {};
    await Promise.all(challenges.map(async c => {
      try {
        const doc = await db.collection('userChallengeProgress')
          .doc(uid).collection('challenges').doc(c.id).get();
        progress[c.id] = doc.exists ? doc.data() : { completedTaskIds: [] };
      } catch (e) {
        progress[c.id] = { completedTaskIds: [] };
      }
    }));

    // 附加：店家掃描驗證（challengeCheckins）union 進 completedTaskIds（不動審查路徑）
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
    } catch (e) { console.warn('[profile] checkins 聯集失敗（不影響審查進度）', e); }

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
    } catch (e) { console.warn('[profile] questCheckins 聯集失敗', e); }

    // 按 challenge 分組 submissions
    const subsByChallenge = {};
    submissions.forEach(s => {
      (subsByChallenge[s.challengeId] = subsByChallenge[s.challengeId] || []).push(s);
    });

    pane.innerHTML = challenges
      .map(c => renderProfileChallengeCard(c, progress[c.id], subsByChallenge[c.id] || []))
      .join('');

    // 展開／收合
    pane.querySelectorAll('.pfch-card-header').forEach(h => {
      h.addEventListener('click', () => h.parentElement.classList.toggle('expanded'));
    });
    // 縮圖點擊放大
    pane.querySelectorAll('.pfch-sub-thumb').forEach(thumb => {
      thumb.addEventListener('click', () => {
        const url = thumb.dataset.url;
        if (url && typeof openPv === 'function') openPv(url);
      });
    });
  } catch (e) {
    console.error('[profile] loadChallengesTab 失敗', e);
    pane.innerHTML = `<div class="item-empty">載入失敗：${pfEscape(e.message)}</div>`;
  }
}

// ── 會員卡 Modal ─────────────────────────────────────────────────────────────
const MC_TIMER_SEC = 120; // 2 分鐘
let _mcTimerInterval  = null;
let _mcQrGenerated    = false;
let _mcCouponsLoaded  = false;
let _mcInitialized    = false;
let _mcFlipped        = false;   // 是否已翻面顯示 QR
let _mcExpired        = false;   // QR 是否已逾時
let _mcNickname       = '';      // 會員卡顯示的暱稱（由 initProfile 設定）

// 等級 → 名片顯示文字
const _MC_TIER_LABEL = {
  admin:             '系統管理',
  director:          '理事',
  member_individual: '個人會員',
  member_group:      '團體會員',
  member_sponsor:    '贊助會員',
  member_honorary:   '榮譽會員',
  store:             '合作店家',
  viewer:            '一般會員',
};

// 等級 → 金屬外框樣式（對應 profile.html 的 .mc-tier-* class）
const _MC_TIER_FRAME = {
  admin:             'black',
  director:          'graphite',
  member_honorary:   'gold',
  member_sponsor:    'silver',
  member_individual: 'red',
  member_group:      'red',
  store:             'blue',
  viewer:            'gray',
};
const _MC_TIER_CLASSES = ['mc-tier-gold','mc-tier-silver','mc-tier-red',
  'mc-tier-graphite','mc-tier-black','mc-tier-blue','mc-tier-gray'];

function openMemberCardModal(uid, role) {
  const modal = document.getElementById('memberCardModal');
  if (!modal) return;

  // 一次性：綁定關閉與翻面事件
  if (!_mcInitialized) {
    _mcInitialized = true;
    document.getElementById('mcCloseBtn')?.addEventListener('click', closeMemberCardModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeMemberCardModal(); });
    document.getElementById('mcFlipCard')?.addEventListener('click', _mcCardClick);
  }

  modal.classList.add('open');

  // 名片正面：等級外框 + 等級文字 + 暱稱
  const front = document.getElementById('mcCardFront');
  if (front) {
    front.classList.remove(..._MC_TIER_CLASSES);
    front.classList.add('mc-tier-' + (_MC_TIER_FRAME[role] || 'gray'));
  }
  const tierEl = document.getElementById('mcCardTier');
  if (tierEl) tierEl.textContent = _MC_TIER_LABEL[role] || '會員';
  const nickEl = document.getElementById('mcCardNick');
  if (nickEl) nickEl.textContent = _mcNickname || '會員';

  // 產生 QR（只建一次）
  if (!_mcQrGenerated && typeof QRCode !== 'undefined') {
    _mcQrGenerated = true;
    const qrEl = document.getElementById('mcQrCanvas');
    if (qrEl) {
      new QRCode(qrEl, {
        text: uid, width: 150, height: 150,
        colorDark: '#000000', colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });
    }
  }

  // 每次開啟都回到正面（名片），QR 與計時器待點擊翻面後才啟動
  _mcShowFront();

  // 載入券（只載入一次）
  if (!_mcCouponsLoaded) {
    _mcCouponsLoaded = true;
    loadCoupons(uid);
  }

  // Page Visibility：螢幕解鎖回來且正在顯示 QR → 重置計時器
  document.addEventListener('visibilitychange', _mcOnVisibility);
}

function closeMemberCardModal() {
  document.getElementById('memberCardModal')?.classList.remove('open');
  clearInterval(_mcTimerInterval);
  _mcShowFront();
  document.removeEventListener('visibilitychange', _mcOnVisibility);
}

function _mcOnVisibility() {
  if (!document.hidden && _mcFlipped) _mcStartTimer();
}

// 點擊卡片：正面→翻面顯示 QR；逾時→重新計時；顯示中→不動作（避免出示時誤觸隱藏）
function _mcCardClick() {
  if (!_mcFlipped) {
    _mcFlipToQr();
  } else if (_mcExpired) {
    _mcStartTimer();
  }
}

// 回到正面（名片）
function _mcShowFront() {
  _mcFlipped = false;
  clearInterval(_mcTimerInterval);
  document.getElementById('mcFlipInner')?.classList.remove('flipped');
  document.getElementById('mcQrBlurOverlay')?.classList.remove('show');
  const row = document.getElementById('mcTimerRow');
  if (row) row.style.display = 'none';
}

// 旋轉門翻面 → 顯示 QR 並開始計時
function _mcFlipToQr() {
  _mcFlipped = true;
  document.getElementById('mcFlipInner')?.classList.add('flipped');
  const row = document.getElementById('mcTimerRow');
  if (row) row.style.display = 'flex';
  _mcStartTimer();
}

function _mcStartTimer() {
  clearInterval(_mcTimerInterval);
  _mcExpired = false;

  // 顯示 QR（移除逾時遮罩）
  document.getElementById('mcQrBlurOverlay')?.classList.remove('show');

  let remaining = MC_TIMER_SEC;
  const timerText = document.getElementById('mcTimerText');
  const timerFill = document.getElementById('mcTimerFill');

  const _tick = () => {
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    if (timerText) timerText.textContent =
      `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    if (timerFill) timerFill.style.width = `${(remaining / MC_TIMER_SEC) * 100}%`;
  };
  _tick();

  _mcTimerInterval = setInterval(() => {
    remaining--;
    _tick();
    if (remaining <= 0) {
      clearInterval(_mcTimerInterval);
      _mcExpired = true;
      // 逾時：顯示遮罩
      document.getElementById('mcQrBlurOverlay')?.classList.add('show');
    }
  }, 1000);
}

// ── 券列表 ──────────────────────────────────────────────────────────────────
async function loadCoupons(uid) {
  const list = document.getElementById('mcCouponList');
  if (!list) return;
  try {
    // 不加 orderBy 避免需要複合索引；client side 排序
    const snap = await db.collection('redemptions')
      .where('uid', '==', uid)
      .limit(20)
      .get();

    if (!snap.docs.length) {
      list.innerHTML = '<div class="item-empty" style="padding:16px 0;font-size:13px">尚無兌換券</div>';
      return;
    }

    const now = new Date();
    const THIRTY_D = 30 * 24 * 60 * 60 * 1000;
    let coupons = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // 前端隱藏「30 天前就已核銷／已過期」的舊紀錄（資料由後端 TTL 自動清除，這裡只是不顯示）
    const _isStale = c => {
      const until = c.validUntil?.toDate?.();
      if (c.status === 'redeemed') {
        const rd = c.redeemedAt?.toDate?.() || c.issuedAt?.toDate?.();
        return rd ? (now - rd) > THIRTY_D : false;
      }
      if (until && until < now) return (now - until) > THIRTY_D; // 過期超過 30 天
      return false; // 可用券一律保留
    };
    coupons = coupons.filter(c => !_isStale(c));

    if (!coupons.length) {
      list.innerHTML = '<div class="item-empty" style="padding:16px 0;font-size:13px">尚無兌換券</div>';
      return;
    }

    // 排序：可用 → 已過期 → 已核銷（由新到舊）
    const _statusOrder = c => {
      if (c.status === 'redeemed') return 2;
      const until = c.validUntil?.toDate?.();
      return (until && until < now) ? 1 : 0;
    };
    coupons.sort((a, b) => {
      const so = _statusOrder(a) - _statusOrder(b);
      if (so !== 0) return so;
      const ta = a.issuedAt?.toDate?.() || new Date(0);
      const tb = b.issuedAt?.toDate?.() || new Date(0);
      return tb - ta;
    });

    // 店家名稱：data/data.json 的「店名」為單一真實來源（getShopMap 已快取）
    const shopMap = await getShopMap();

    const itemsHtml = coupons.map(c => {
      const until = c.validUntil?.toDate?.();
      const isExpired = until && until < now;
      let statusLabel, statusCls;
      if (c.status === 'redeemed') {
        statusLabel = '已核銷'; statusCls = 'mc-status-redeemed';
      } else if (isExpired) {
        statusLabel = '已過期'; statusCls = 'mc-status-expired';
      } else {
        statusLabel = '可使用'; statusCls = 'mc-status-active';
      }

      const shopName = pfEscape(c.shopName || shopMap[c.shopId]?.['店名'] || c.shopId || '店家');
      const typeLabel = c.type === 'ticket' ? '🎫 入場券' : '🎟 兌換券';
      const validStr = c.status === 'redeemed' ? '' :
        until ? `有效至 ${until.toLocaleDateString('zh-TW')}` : '永久有效';

      return `
        <div class="mc-coupon-item">
          <div class="mc-coupon-info">
            <div class="mc-coupon-shop">${shopName}</div>
            <div class="mc-coupon-desc">${typeLabel}${c.item ? '・' + pfEscape(c.item) : ''}</div>
            ${validStr ? `<div class="mc-coupon-valid">${validStr}</div>` : ''}
          </div>
          <span class="mc-status-badge ${statusCls}">${statusLabel}</span>
        </div>`;
    });

    // 預設只顯示 3 張，其餘收進可展開區塊（資料已抓回，純前端切換）
    const SHOWN = 3;
    list.innerHTML = itemsHtml.slice(0, SHOWN).join('') +
      (itemsHtml.length > SHOWN
        ? `<div id="mcCouponMore" class="mc-coupon-more" style="display:none">${itemsHtml.slice(SHOWN).join('')}</div>`
        : '');

    // 展開／收合按鈕（位於「我的兌換券」標題右側）
    const toggle = document.getElementById('mcCouponToggle');
    if (toggle) {
      if (itemsHtml.length > SHOWN) {
        toggle.style.display = '';
        toggle.textContent = `展開（共 ${itemsHtml.length} 張）`;
        toggle.onclick = () => {
          const more = document.getElementById('mcCouponMore');
          if (!more) return;
          const open = more.style.display === 'none';
          more.style.display = open ? '' : 'none';
          toggle.textContent = open ? '收合' : `展開（共 ${itemsHtml.length} 張）`;
        };
      } else {
        toggle.style.display = 'none';
      }
    }

  } catch (e) {
    console.error('[profile] loadCoupons 失敗', e);
    list.innerHTML = '<div class="item-empty" style="padding:16px 0;font-size:13px">載入失敗</div>';
  }
}

// member 以上（與 firestore.rules taskAllows 的 roleLevel>=2 對齊）
function _pfIsMemberRole(role) {
  return ['member_individual', 'member_group', 'member_sponsor',
          'member_honorary', 'director', 'admin'].includes(role);
}

// 自助領券：登入後自動檢查 distributionTasks（on_login / first_register）並建立 issued 券
// 對應 firestore.rules redemptions create 路徑 C（doc ID 固定為 {taskId}_{uid}，防重複）
async function runSelfServeDispatch(uid, currentUser) {
  try {
    const snap = await db.collection('distributionTasks')
      .where('status', '==', 'active')
      .get();
    if (snap.empty) return;

    const now = new Date();
    const creationStr = currentUser && currentUser.metadata && currentUser.metadata.creationTime;
    const created = creationStr ? new Date(creationStr) : null;

    for (const doc of snap.docs) {
      const t = doc.data();
      const trig = t.triggerType;
      if (trig !== 'on_login' && trig !== 'first_register') continue;

      // 對象：member 任務僅會員以上可領（與規則一致，先 client 過濾避免無謂寫入）
      if (t.targetRole === 'member' && !_pfIsMemberRole(currentUserRole)) continue;

      // 派發窗口（claim window）
      const dFrom  = t.dispatchFrom?.toDate?.();
      const dUntil = t.dispatchUntil?.toDate?.();
      if (dFrom && now < dFrom) continue;
      if (dUntil && now > dUntil) continue;

      // 新註冊：帳號建立時間須落在派發窗口內
      if (trig === 'first_register' && created) {
        if (dFrom && created < dFrom) continue;
        if (dUntil && created > dUntil) continue;
      }

      const redId = doc.id + '_' + uid;
      const exist = await db.collection('redemptions').doc(redId).get();
      if (exist.exists) continue; // 已領過

      try {
        await db.collection('redemptions').doc(redId).set({
          uid,
          shopId:     t.shopId,
          shopName:   t.shopName || '',
          type:       t.type || 'coupon',
          status:     'issued',
          item:       t.item || '',
          issuedBy:   uid,
          issuedAt:   firebase.firestore.FieldValue.serverTimestamp(),
          validFrom:  t.validFrom,
          validUntil: t.validUntil || null,
          taskId:     doc.id,
          source:     'self',
          // TTL：有效期後 90 天（永久券則發出後 365 天）由 Firestore 自動刪除
          expireAt:   t.validUntil
            ? firebase.firestore.Timestamp.fromMillis(t.validUntil.toMillis() + 90*24*60*60*1000)
            : firebase.firestore.Timestamp.fromDate(new Date(Date.now() + 365*24*60*60*1000)),
        });
      } catch (e) {
        // 規則擋下（不符資格 / 競態已存在）→ 靜默略過
        console.debug('[profile] 自助領券略過', doc.id, e.code || e.message);
      }
    }
  } catch (e) {
    console.warn('[profile] runSelfServeDispatch 失敗', e);
  }
}

function renderProfileChallengeCard(challenge, progressDoc, submissions) {
  const completed = (progressDoc?.completedTaskIds) || [];
  const allTasks  = (challenge.groups || []).flatMap(g => g.tasks || []);
  const total     = allTasks.length;
  const done      = allTasks.filter(t => completed.includes(t.id)).length;
  const pct       = total ? Math.round(done / total * 100) : 0;

  const period    = challenge.period || {};
  const periodStr = period.start && period.end ? `${period.start} ~ ${period.end}` : '';

  const tasksHtml = (challenge.groups || []).map(g => `
    <div class="pfch-group">
      <div class="pfch-group-title">${pfEscape(g.title || '')}</div>
      ${(g.tasks || []).map(t => {
        const dn = completed.includes(t.id);
        return `<div class="pfch-task ${dn ? 'done' : ''}">
          <span>${dn ? '✅' : '⬜'}</span>
          <span>${pfEscape(t.title || '')}</span>
        </div>`;
      }).join('')}
    </div>
  `).join('');

  const statusMap = { pending: '⏳', approved: '✅', rejected: '❌' };
  const subsHtml = submissions.length ? `
    <div class="pfch-subs">
      <div class="pfch-subs-title">送出紀錄（${submissions.length} 筆）</div>
      <div class="pfch-subs-grid">
        ${submissions.map(s => `
          <div class="pfch-sub-thumb" data-url="${pfEscape(s.photoUrl || '')}">
            <img src="${pfEscape(s.photoUrl || '')}" alt="" loading="lazy">
            <div class="pfch-sub-status ${pfEscape(s.status || '')}">${statusMap[s.status] || s.status || ''}</div>
          </div>
        `).join('')}
      </div>
    </div>
  ` : '';

  return `
    <div class="pfch-card">
      <div class="pfch-card-header">
        <div class="pfch-title-row">
          <span class="pfch-title">${pfEscape(challenge.title || '')}</span>
          ${periodStr ? `<span class="pfch-period">${pfEscape(periodStr)}</span>` : ''}
        </div>
        <div class="pfch-progress-row">
          <div class="pfch-progress-bar"><div class="pfch-progress-fill" style="width:${pct}%"></div></div>
          <span class="pfch-progress-text">${done}/${total}　${pct}%</span>
        </div>
      </div>
      <div class="pfch-detail">
        <div class="pfch-detail-inner">
          ${tasksHtml}
          ${subsHtml}
        </div>
      </div>
    </div>
  `;
}
