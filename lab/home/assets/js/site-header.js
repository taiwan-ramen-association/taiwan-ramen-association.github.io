/*
 * site-header.js — 首頁與協會 9 頁共用的頁首選單＋頁尾（2026-11 改版）
 *
 * 要改選單或頁尾的連結、文字：只改下面的 MENU／MOBILE_EXTRA／FOOTER_COLS／SOCIAL，10 頁會一起換。
 * 每頁 HTML 裡有一份最小的靜態頁首（logo 連回首頁＋電腦版「找拉麵」），
 * 這支程式整段成功跑完才換成完整版；程式出錯或沒載到時，頁面停在靜態版，內容照常可讀。
 * 寫法刻意用舊語法（var、function，不用箭頭函式、樣板字串），舊手機的內建瀏覽器也看得懂。
 * 不依賴別的程式；圖示動畫由 icon-motion.js 負責（沒載到也只是圖示不動）。
 *
 * 圖示形狀：PulsoIcon（https://github.com/CityPulso/PulsoIcon，ISC；形狀源自 Lucide，ISC），
 * 授權全文見 ../icons/LICENSE.txt
 */
(function () {
  'use strict';

  var script = document.currentScript;
  // 網站根目錄：用這支程式自己的網址往回推 → 404 頁在任何深度的網址、測試站 /lab/home/ 都對
  var BASE = (script && script.src) ? script.src.replace(/assets\/js\/site-header\.js(\?.*)?$/, '') : '/';
  var FINDER = '/finder.html';

  // ── 選單：電腦版是文字選單；手機選單在前面多兩項（MOBILE_EXTRA） ──
  var MENU = [
    { text: '最新消息', href: 'news.html', icon: 'megaphone' },
    { text: '關於協會', href: 'about.html', icon: 'info' },
    { text: '合作夥伴', href: 'partners.html', icon: 'handshake' },
    { text: '加入會員', href: 'membership.html', icon: 'users' }
  ];
  var MOBILE_EXTRA = [
    { text: '拉麵搜尋器', url: FINDER, icon: 'search' },
    { text: '挑戰任務', url: FINDER + '?page=challenges', icon: 'flag' }
  ];

  // ── 頁尾 ──
  var EMAIL = 'taiwan.ramen.association@gmail.com';
  var SOCIAL = [
    { name: 'Instagram', url: 'https://www.instagram.com/twramen.assoc/', icon: 'brand-instagram' },
    { name: 'Threads', url: 'https://www.threads.com/@twramen.assoc', icon: 'brand-threads' },
    { name: 'Facebook', url: 'https://facebook.com/taiwanramenassociation', icon: 'brand-facebook' }
  ];
  var FOOTER_COLS = [
    { title: '網站', links: [
      { text: '拉麵搜尋器', url: FINDER },
      { text: '挑戰任務', url: FINDER + '?page=challenges' },
      { text: '最新消息', href: 'news.html' },
      { text: '關於協會', href: 'about.html' },
      { text: '合作夥伴', href: 'partners.html' },
      { text: '加入會員', href: 'membership.html' }
    ] },
    { title: '聯絡', links: [
      { text: EMAIL, url: 'mailto:' + EMAIL, icon: 'mail' },
      { text: '臺中市北屯區太順路 286 號 4 樓之 6', icon: 'map-pin' },
      { text: '店家申請', url: 'mailto:' + EMAIL + '?subject=' + encodeURIComponent('店家申請') },
      { text: '廣告合作', url: 'mailto:' + EMAIL + '?subject=' + encodeURIComponent('廣告合作') }
    ] },
    { title: '其他', links: [
      { text: '會務專區', href: 'members-zone.html' },
      { text: '使用條款', url: '/terms.html' },
      { text: '其他', href: 'other.html' }
    ] }
  ];

  // ── 圖示（24×24 外框）。陣列每一格＝icon-motion.js 的一段動作（會動的圖示才分段） ──
  var ICONS = {
    menu: ['<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/>'],
    x: ['<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'],
    search: ['<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>'],
    flag: ['<path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"/>'],
    megaphone: ['<path d="M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/><path d="M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14"/><path d="M8 6v8"/>'],
    info: ['<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'],
    handshake: ['<path d="m11 17 2 2a1 1 0 1 0 3-3"/><path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"/><path d="m21 3 1 11h-2"/><path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"/><path d="M3 4h8"/>'],
    users: ['<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/>'],
    mail: ['<path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"/><rect x="2" y="4" width="20" height="16" rx="2"/>'],
    'map-pin': ['<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>'],
    'brand-instagram': ['<rect x="2" y="2" width="20" height="20" rx="5"/>', '<path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/>', '<path d="M17.5 6.5h.01"/>'],
    'brand-facebook': ['<path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>'],
    'brand-threads': ['<path d="M17.5 7C16.3 5 14.4 4 12 4 7.6 4 5 7.5 5 12s2.6 8 7 8c3.6 0 6.5-2.3 6.5-5.5 0-2.8-2-4.5-5-4.5-2.2 0-3.8 1-3.8 2.6 0 1.4 1.1 2.4 2.6 2.4 2.4 0 3.5-2 3.4-5.5"/>']
  };

  // animated＝true：每段包成 <g>，交給 icon-motion.js（電腦滑鼠移入或 Tab 選到才動）
  function icon(name, animated) {
    var parts = ICONS[name] || [];
    var body = animated ? '<g>' + parts.join('</g><g>') + '</g>' : parts.join('');
    return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"' +
      (animated ? ' data-anim="' + name + '"' : '') + '>' + body + '</svg>';
  }

  // 站內頁面的網址＝根目錄＋檔名；搜尋器、使用條款等寫死根目錄（測試站也連正式頁）
  function urlOf(item) { return item.url || (BASE + item.href); }

  var parser = document.createElement('a');
  function pathOf(url) { parser.href = url; return parser.pathname.replace(/\/index\.html$/, '/'); }
  var here = pathOf(location.href);
  function current(item) { return item.href && pathOf(urlOf(item)) === here ? ' aria-current="page"' : ''; }

  function isExternal(url) { return /^https?:/.test(url) && url.indexOf(location.host) < 0; }

  function headerHtml() {
    var h = '';
    h += '<a href="' + BASE + '" class="logo" aria-label="台灣拉麵協會 首頁">' +
      '<img src="' + BASE + 'assets/img/logo-h.svg" alt="台灣拉麵協會 Taiwan Ramen Association" width="153" height="32"></a>';
    h += '<nav class="nav-links" aria-label="主選單">';
    for (var i = 0; i < MENU.length; i++) h += '<a href="' + urlOf(MENU[i]) + '"' + current(MENU[i]) + '>' + MENU[i].text + '</a>';
    h += '</nav>';
    h += '<div class="header-right">' +
      '<a href="' + FINDER + '" class="btn btn-primary btn-sm">' + icon('search', true) + '找拉麵</a>' +
      '<button type="button" class="icon-btn" aria-label="選單" aria-expanded="false" aria-controls="siteMenu">' + icon('menu') + icon('x') + '</button>' +
      '</div>';
    var all = MOBILE_EXTRA.concat(MENU);
    h += '<nav class="m-menu" id="siteMenu" aria-label="選單" hidden>';
    for (var j = 0; j < all.length; j++) h += '<a href="' + urlOf(all[j]) + '"' + current(all[j]) + '>' + icon(all[j].icon) + all[j].text + '</a>';
    h += '</nav>';
    return h;
  }

  function footerHtml() {
    var f = '<footer class="site-footer"><div class="f-inner"><div class="f-grid">';
    f += '<div class="f-brand"><a href="' + BASE + '" aria-label="台灣拉麵協會 首頁">' +
      '<img src="' + BASE + 'assets/img/logo-h-white.svg" alt="台灣拉麵協會 Taiwan Ramen Association" width="191" height="40" loading="lazy"></a>' +
      '<div class="social">';
    for (var s = 0; s < SOCIAL.length; s++) {
      f += '<a href="' + SOCIAL[s].url + '" target="_blank" rel="noopener" aria-label="' + SOCIAL[s].name + '">' + icon(SOCIAL[s].icon, true) + '</a>';
    }
    f += '</div></div>';
    for (var c = 0; c < FOOTER_COLS.length; c++) {
      var col = FOOTER_COLS[c];
      f += '<div class="f-col"><h2>' + col.title + '</h2>';
      for (var k = 0; k < col.links.length; k++) {
        var l = col.links[k];
        var ic = l.icon ? icon(l.icon) : '';
        if (!l.url && !l.href) { f += '<p>' + ic + '<span>' + l.text + '</span></p>'; continue; }
        var u = urlOf(l);
        f += '<a href="' + u + '"' + current(l) + (isExternal(u) ? ' target="_blank" rel="noopener"' : '') + '>' + ic + '<span>' + l.text + '</span></a>';
      }
      f += '</div>';
    }
    f += '</div><div class="f-bottom">© 2025–' + new Date().getFullYear() + ' 台灣拉麵協會 Taiwan Ramen Association</div></div></footer>';
    return f;
  }

  function run() {
    var header = document.querySelector('[data-site-header]');
    if (!header) return;
    // 先在畫面外組好、接好按鈕，最後才一次換上；中途出錯就什麼都不換（留著靜態版）
    var tmp = document.createElement('div');
    tmp.innerHTML = headerHtml();
    var btn = tmp.querySelector('.icon-btn');
    var menu = tmp.querySelector('.m-menu');
    // 按鈕裡兩個圖示都先放好、只切換顯示。不要在點擊當下重寫按鈕內容：被點到的圖示會脫離頁面，
    // 下面「點頁首外面就關選單」會誤判成點在外面，選單一開就立刻關掉（11/11 本機測試抓到）
    var icons = btn.getElementsByTagName('svg');
    function setOpen(open) {
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.setAttribute('aria-label', open ? '關閉選單' : '選單');
      icons[0].style.display = open ? 'none' : '';
      icons[1].style.display = open ? '' : 'none';
    }
    icons[1].style.display = 'none';
    btn.addEventListener('click', function () { setOpen(menu.hidden); });
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'Escape' || e.key === 'Esc') && !menu.hidden) { setOpen(false); btn.focus(); }
    });
    document.addEventListener('click', function (e) {
      if (!menu.hidden && !header.contains(e.target)) setOpen(false);
    });
    var footerSlot = document.querySelector('[data-site-footer]');
    var footer = footerSlot ? footerHtml() : '';

    header.innerHTML = '';
    while (tmp.firstChild) header.appendChild(tmp.firstChild);
    header.setAttribute('data-ready', '');
    if (footerSlot) footerSlot.innerHTML = footer;
  }

  try {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { try { run(); } catch (e) {} });
    else run();
  } catch (e) { /* 出錯就留著靜態頁首 */ }
})();
