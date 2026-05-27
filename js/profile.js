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
    if (typeof canView === 'function' && canView('challengesNav')) {
      document.getElementById('pfChallengesTabBtn')?.style.setProperty('display', '');
    }
  }

  // 5. 統計數字
  loadStats(targetUid, isSelf);

  // 6. 預設啟動評論 tab
  loadReviewsTab(targetUid);
  bindTabSwitching(targetUid);

  // 6. 本人 → 顯示 self-actions 區塊（Google 帳號資訊、登出、設定）
  if (isSelf) {
    renderSelfActions(currentUser);
    bindSettingsModal(targetUid, profileDoc);
  }
}

// ── Self-actions（設定按鈕顯示；Google 帳號資訊 + 登出已移入 settings modal）──
function renderSelfActions(user) {
  const selfActions = document.getElementById('selfActions');
  if (!selfActions) return;
  selfActions.style.display = '';

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
}

// ── Tab 5：挑戰 ────────────────────────────────────────────────────────────
async function loadChallengesTab(uid) {
  const pane = document.getElementById('challengesTabPane');
  if (!pane) return;
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
        ${tasksHtml}
        ${subsHtml}
      </div>
    </div>
  `;
}
