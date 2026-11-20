// ── onboarding.js：新手導覽（Onboarding Modal）──────────────────────────────────
// 2026-11-20 從 finder.html 抽出。內容在 Firestore meta/onboarding，由後台「新手導覽」編輯：
//   { version: 1, slides: [{ id, icon, title, desc, images: [{ src, alt }], visible }], updatedAt }
//   icon 和說明裡的 {heart} 這類代碼都是 finder 圖示表的名字（不帶 i-）：對不到的圖示不畫，代碼照原字顯示。
//   圖片只收站內路徑（/ 開頭）和協會 Storage 的網址，載不到的那張直接拿掉。
// 自動跳出：js/auth.js 登入後（資料載完、壽星動畫之後）呼叫 onboardingAutoOpen(uid)。
//   localStorage onboarding_done_{uid} 存看過的版本號；第 1 版就是 '1'，跟抽出前的寫法一樣，看過的人不會重跳。
//   讀不到內容就不跳、也不記看過，下次打開 finder 再試。
// 獎章視窗（js/badges.js）用 onboardingDecided() 等「開不開」的結果，最多等 5 秒。
// 後台預覽：onboardingPreview(data, onClose)——用還沒存的內容畫，不寫 localStorage、不送 GA。
// HTML 骨架插在 #privacyModal 後面（跟抽出前同一個位置），導覽專用的 CSS 也由這裡注入；
// 共用的 .fullscreen-modal／.fmod-card／.fmod-skip 留在 finder.html（隱私視窗也用）。
// 依賴全域（都先檢查有沒有）：auth、db、canView、canUse、showAccessToast（js/auth.js）、showStampToast（js/stamps.js）、gtag
// 提供全域：onboardingAutoOpen、onboardingDecided、onboardingPreview、openOnboardingModal、closeOnboardingModal
(function () {
  'use strict';

  const KEY = 'onboarding_done_';
  const STORAGE_PREFIX = 'https://firebasestorage.googleapis.com/v0/b/taiwan-ramen-association.firebasestorage.app/o/';
  const AUTO_MS = 10000;      // 每頁停 10 秒自動換下一頁（最後一頁不換）
  const MENU_WAIT_MS = 8000;  // 從漢堡選單打開時，內容最多等 8 秒

  // 以下到 .fmod-slide-icon .ic 為止，原樣搬自 finder.html（2026-11-20 抽出前的 2258–2299、2446、2450 行）
  const CSS = `
  /* Onboarding slides */
  .fmod-slides-wrap { position: relative; overflow: hidden; flex: 1; }
  .fmod-slide {
    position: absolute; inset: 0;
    overflow-y: auto; -webkit-overflow-scrolling: touch;
    display: flex; flex-direction: column; align-items: center; text-align: center;
    padding: 28px 24px 16px; box-sizing: border-box; gap: 12px;
    transform: translateX(100%); pointer-events: none;
  }
  .fmod-slide.active { pointer-events: auto; }
  .fmod-slide-img { display: none; width: 80%; height: auto; border-radius: 12px; margin-top: 4px; }
  .fmod-slide-img[src]:not([src=""]) { display: block; }
  .fmod-slide-icon { font-size: 48px; line-height: 1; }
  .fmod-slide-title { font-size: 18px; font-weight: 800; color: var(--ink); }
  .fmod-slide-desc { font-size: 14px; color: var(--stone); line-height: 1.7; max-width: 320px; }
  .fmod-nav-row {
    padding: 10px 16px 4px; display: flex; flex-direction: row;
    align-items: center; justify-content: center; gap: 12px; flex-shrink: 0;
  }
  .fmod-dots { display: flex; justify-content: center; gap: 7px; }
  .fmod-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--line); transition: background 0.2s, width 0.2s;
  }
  .fmod-dot.active { background: var(--red); width: 20px; border-radius: 4px; }
  .fmod-arrow-btn {
    width: 36px; height: 36px; background: none; border: none; cursor: pointer;
    font-size: 26px; color: var(--ink); display: flex; align-items: center; justify-content: center;
    transition: opacity 0.15s; flex-shrink: 0;
  }
  .fmod-arrow-btn:active { opacity: 0.5; }
  .fmod-arrow-btn:disabled { opacity: 0.15; cursor: default; }
  .fmod-confirm-wrap { padding: 8px 24px 24px; flex-shrink: 0; }
  .fmod-confirm-btn {
    width: 100%; padding: 13px 16px;
    background: var(--red); color: #fff; border: none; border-radius: 12px;
    font-size: 15px; font-weight: 700; cursor: pointer;
    font-family: 'Noto Sans TC', sans-serif; transition: opacity 0.15s;
  }
  .fmod-confirm-btn:active { opacity: 0.82; }
  body.dark .fmod-arrow-btn { color: rgba(255,255,255,0.8); }
  .fmod-arrow-btn .ic { width: 28px; height: 28px; }
  .fmod-slide-icon .ic { width: 46px; height: 46px; }
  /* 「略過」（2026-11-20 新增）：最後一頁以外顯示；字的樣式同隱私視窗的「先不登入」（.fmod-skip，在 finder.html） */
  .fmod-confirm-wrap .fmod-skip { display: block; margin: 0 auto; padding: 2px 8px; background: none; border: none; font-family: inherit; }
`;

  const HTML = `
<div class="fullscreen-modal" id="onboardingModal">
  <div class="fmod-card">
    <div class="fmod-slides-wrap" id="onboardingSlidesWrap"></div>
    <div class="fmod-nav-row">
      <button class="fmod-arrow-btn" id="onboardingPrevBtn" aria-label="上一張" disabled><svg class="ic" aria-hidden="true"><use href="#i-chevron-left"/></svg></button>
      <div class="fmod-dots" id="onboardingDots"></div>
      <button class="fmod-arrow-btn" id="onboardingNextArrow" aria-label="下一張"><svg class="ic" aria-hidden="true"><use href="#i-chevron-right"/></svg></button>
    </div>
    <div class="fmod-confirm-wrap">
      <button class="fmod-confirm-btn" id="onboardingConfirmBtn" style="display:none">開始探索！</button>
      <button type="button" class="fmod-skip" id="onboardingSkipBtn">略過</button>
    </div>
  </div>
</div>`;

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hasIcon = n => typeof n === 'string' && /^[a-z0-9-]+$/.test(n) && !!document.getElementById('i-' + n);
  const iconSvg = n => `<svg class="ic" aria-hidden="true"><use href="#i-${n}"/></svg>`;
  const okSrc = s => typeof s === 'string' && ((s.charAt(0) === '/' && s.charAt(1) !== '/') || s.indexOf(STORAGE_PREFIX) === 0);
  const currentUid = () => (typeof auth !== 'undefined' && auth && auth.currentUser ? auth.currentUser.uid : '');
  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  const lsDel = k => { try { localStorage.removeItem(k); } catch (e) {} };
  const ga = (name, params) => { if (typeof gtag === 'function') gtag('event', name, params); };
  const toast = msg => { if (typeof showStampToast === 'function') showStampToast(msg); else console.warn(msg); };

  // 說明：先轉義，{名字} 換成圖示（對不到照原字），換行變 <br>
  function descHtml(s) {
    return esc(s).replace(/\{([a-z0-9-]+)\}/g, (m, n) => (hasIcon(n) ? iconSvg(n) : m)).replace(/\r?\n/g, '<br>');
  }

  // Firestore 文件 → 要畫的內容：只留設為顯示、有標題的頁；圖片最多 2 張、網址要合格
  function normalize(d) {
    d = d || {};
    const version = (Number.isInteger(d.version) && d.version > 0) ? d.version : 1;
    const slides = (Array.isArray(d.slides) ? d.slides : [])
      .filter(s => s && s.visible !== false && typeof s.title === 'string' && s.title.trim())
      .map(s => ({
        icon: typeof s.icon === 'string' ? s.icon : '',
        title: s.title,
        desc: typeof s.desc === 'string' ? s.desc : '',
        images: (Array.isArray(s.images) ? s.images : [])
          .filter(im => im && okSrc(im.src)).slice(0, 2)
          .map(im => ({ src: im.src, alt: typeof im.alt === 'string' ? im.alt : '' })),
      }));
    return { version, slides };
  }

  function slideHtml(s, i) {
    return `<div class="fmod-slide" data-slide="${i}">`
      + (hasIcon(s.icon) ? `<div class="fmod-slide-icon">${iconSvg(s.icon)}</div>` : '')
      + `<p class="fmod-slide-title">${esc(s.title)}</p>`
      + (s.desc ? `<p class="fmod-slide-desc">${descHtml(s.desc)}</p>` : '')
      + s.images.map(im => `<img class="fmod-slide-img" src="${esc(im.src)}" alt="${esc(im.alt)}">`).join('')
      + '</div>';
  }

  // ── 讀內容（登入後先讀；成功的結果留著，失敗的話下次要用時再讀）──
  let _loadP = null;
  function load() {
    if (_loadP) return _loadP;
    let p;
    try {
      if (typeof db === 'undefined' || !db) throw new Error('no-db');
      p = db.collection('meta').doc('onboarding').get()
        .then(snap => (snap.exists ? normalize(snap.data()) : { version: 0, slides: [] }));
    } catch (e) {
      return Promise.reject(e);
    }
    _loadP = p;
    p.catch(() => { if (_loadP === p) _loadP = null; });
    return p;
  }

  // ── 畫面 ──
  let _count = 0, _slide = 0, _timer = null, _ctx = null;

  function stopTimer() {
    if (_timer) { clearTimeout(_timer); _timer = null; }
  }

  function show(c, ctx) {
    const modal = $('onboardingModal');
    if (!modal || !c || !c.slides.length) return false;
    if (modal.classList.contains('open')) return true;   // 已經開著（選單和自動跳出撞在一起）
    _ctx = ctx;
    _count = c.slides.length;
    const wrap = $('onboardingSlidesWrap');
    wrap.innerHTML = c.slides.map(slideHtml).join('');
    wrap.querySelectorAll('.fmod-slide-img').forEach(img => img.addEventListener('error', () => img.remove()));
    $('onboardingDots').innerHTML = c.slides.map(() => '<span class="fmod-dot"></span>').join('');
    wrap.querySelectorAll('.fmod-slide').forEach((s, i) => {
      s.style.transition = 'none';
      s.style.transform = i === 0 ? 'translateX(0)' : 'translateX(100%)';
      s.classList.toggle('active', i === 0);
      s.scrollTop = 0;
    });
    _slide = 0;
    updateUI(0);
    modal.classList.add('open');
    return true;
  }

  function close() {
    stopTimer();
    const modal = $('onboardingModal');
    if (modal) modal.classList.remove('open');
  }

  function gotoSlide(n) {
    stopTimer();
    const slides = document.querySelectorAll('#onboardingModal .fmod-slide');
    const from = slides[_slide];
    const to   = slides[n];
    const dir  = n >= _slide ? 1 : -1;
    _slide = n;

    if (from && to && from !== to) {
      to.style.transition = 'none';
      to.style.transform  = `translateX(${dir > 0 ? '100%' : '-100%'})`;
      to.scrollTop = 0;
      to.offsetHeight; // reflow
      const ease = 'transform 0.38s cubic-bezier(0.25,0.46,0.45,0.94)';
      from.style.transition = ease;
      to.style.transition   = ease;
      from.style.transform  = `translateX(${dir > 0 ? '-100%' : '100%'})`;
      to.style.transform    = 'translateX(0)';
      to.classList.add('active');
      setTimeout(() => {
        from.classList.remove('active');
        from.style.transition = 'none';
      }, 390);
    }
    updateUI(n);
  }

  function updateUI(n) {
    const isLast  = n === _count - 1;
    const isFirst = n === 0;
    document.querySelectorAll('#onboardingDots .fmod-dot').forEach((d, i) =>
      d.classList.toggle('active', i === n)
    );
    $('onboardingPrevBtn').disabled   = isFirst;
    $('onboardingNextArrow').disabled = isLast;
    $('onboardingConfirmBtn').style.display = isLast ? 'block' : 'none';
    $('onboardingSkipBtn').style.display    = isLast ? 'none' : '';
    if (!isLast) {
      _timer = setTimeout(() => gotoSlide(_slide + 1), AUTO_MS);
    }
  }

  // 按「開始探索！」或「略過」：都算看過這一版
  function finish(kind) {
    const ctx = _ctx || {};
    _ctx = null;
    if (!ctx.preview) {
      const uid = currentUid();
      if (uid) lsSet(KEY + uid, String(ctx.version || 1));
      if (kind === 'done') ga('onboarding_done', { total: _count, trigger: ctx.trigger || 'auto' });
      else ga('onboarding_skip', { slide: _slide + 1, total: _count, trigger: ctx.trigger || 'auto' });
    }
    close();
    if (ctx.preview && typeof ctx.onClose === 'function') {
      try { ctx.onClose(kind); } catch (e) { console.error(e); }
    }
  }

  // ── 對外 ──
  let _decide;
  const _decided = new Promise(r => { _decide = r; });

  // 登入後由 js/auth.js 呼叫：有內容、而且看過的版本比現在的舊才跳出。回傳 Promise<是否打開>
  function onboardingAutoOpen(uid) {
    const settle = opened => { _decide(opened); return opened; };
    if (!uid || (typeof canView === 'function' && !canView('onboardingTour'))) return Promise.resolve(settle(false));
    return load().then(c => {
      if (!c.slides.length) return settle(false);
      if ((parseInt(lsGet(KEY + uid), 10) || 0) >= c.version) return settle(false);
      if (currentUid() !== uid) return settle(false);   // 讀的時候登出或換了帳號
      return settle(show(c, { trigger: 'auto', version: c.version }));
    }, () => settle(false));
  }

  // 漢堡選單「新手導覽」：內容讀到才清掉看過紀錄再打開
  async function menuOpen() {
    if (typeof canUse === 'function' && !canUse('onboardingTour')) {
      if (typeof showAccessToast === 'function') showAccessToast();
      return;
    }
    const drawer = $('drawer'), backdrop = $('drawerBackdrop');
    if (drawer) drawer.style.display = 'none';
    if (backdrop) backdrop.style.display = 'none';
    let c;
    try {
      const p = load();
      let settled = false;
      p.then(() => { settled = true; }, () => { settled = true; });
      c = await Promise.race([p, new Promise((_, rej) => setTimeout(() => {
        if (settled) return;
        if (_loadP === p) _loadP = null;   // 卡住的那次不留著，下次再按重新讀
        rej(new Error('timeout'));
      }, MENU_WAIT_MS))]);
    } catch (e) {
      toast('導覽內容沒有載入成功，請稍後再試');
      return;
    }
    if (!c.slides.length) { toast('目前沒有導覽內容'); return; }
    const uid = currentUid();
    if (uid) lsDel(KEY + uid);
    show(c, { trigger: 'menu', version: c.version });
  }

  // 後台預覽：data＝還沒存的 meta/onboarding 內容
  function onboardingPreview(data, onClose) {
    close();
    _ctx = null;
    return show(normalize(data), { preview: true, trigger: 'preview', onClose });
  }

  // 快取裡的舊版 auth.js 沒看過才會叫這個名字
  function openOnboardingModal() {
    return onboardingAutoOpen(currentUid());
  }

  // ── 掛上頁面 ──
  function mount() {
    if ($('onboardingModal')) return;
    const st = document.createElement('style');
    st.id = 'onboardingStyle';
    st.textContent = CSS;
    document.head.appendChild(st);

    const box = document.createElement('div');
    box.innerHTML = HTML.trim();
    const modal = box.firstElementChild;
    const anchor = $('privacyModal');
    if (anchor) anchor.after(modal); else document.body.appendChild(modal);

    // 左右箭頭
    $('onboardingPrevBtn').addEventListener('click', () => {
      if (_slide > 0) gotoSlide(_slide - 1);
    });
    $('onboardingNextArrow').addEventListener('click', () => {
      if (_slide < _count - 1) gotoSlide(_slide + 1);
    });

    // 手機左右滑動
    const wrap = $('onboardingSlidesWrap');
    let _tx = null, _ty = null, _locked = null;
    wrap.addEventListener('touchstart', e => {
      _tx = e.touches[0].clientX;
      _ty = e.touches[0].clientY;
      _locked = null;
    }, { passive: true });
    wrap.addEventListener('touchmove', e => {
      if (_tx === null) return;
      const dx = e.touches[0].clientX - _tx;
      const dy = e.touches[0].clientY - _ty;
      if (_locked === null) _locked = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
    }, { passive: true });
    wrap.addEventListener('touchend', e => {
      if (_tx === null || _locked !== 'h') { _tx = null; return; }
      const dx = e.changedTouches[0].clientX - _tx;
      _tx = null;
      if (Math.abs(dx) < 50) return;
      if (dx < 0 && _slide < _count - 1) gotoSlide(_slide + 1);
      if (dx > 0 && _slide > 0) gotoSlide(_slide - 1);
    }, { passive: true });

    $('onboardingConfirmBtn').addEventListener('click', () => finish('done'));
    $('onboardingSkipBtn').addEventListener('click', () => finish('skip'));

    const resetBtn = $('resetOnboardBtn');
    if (resetBtn) resetBtn.addEventListener('click', menuOpen);
  }

  mount();

  // 登入就先讀（等資料載完、壽星動畫跑完才要用，先讀好就不用等）
  if (typeof auth !== 'undefined' && auth && typeof auth.onAuthStateChanged === 'function') {
    auth.onAuthStateChanged(u => { if (u) load().catch(() => {}); });
  }

  window.onboardingAutoOpen   = onboardingAutoOpen;
  window.onboardingDecided    = () => _decided;
  window.onboardingPreview    = onboardingPreview;
  window.openOnboardingModal  = openOnboardingModal;
  window.closeOnboardingModal = close;
})();
