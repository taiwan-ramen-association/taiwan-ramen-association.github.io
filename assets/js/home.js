/*
 * home.js — 新首頁的資料區塊（2026-11 改版）
 *
 * ①③ 店家資料 /data/data.json：等畫面先畫出來才抓。網址和搜尋器（finder.html）完全一樣、不加 ?t=，
 *      這樣點進搜尋器時用的是同一份快取（搜尋器會再向伺服器確認一次，沒變就不重下載）。
 *      「營業中」「新開幕（近 3 個月）」「開幕日還沒到」的算法和 finder.html 的 isNewOpen／isUpcoming 相同。
 * ①④ 後台的「首頁精選」「主題懶人包」：Firestore REST 唯讀（meta/homeFeatured、meta/homeCollections），不載 Firebase 套件。
 * ⑤  /data/news.json 最新 3 則；填了 homeUntil（首頁顯示到哪天，台灣時間、含當天）且已過期的跳過，日期寫錯就照樣顯示。
 * ⑥  /data/partners.json（featured 的）。logo 路徑以網站根目錄為準（assets/icons/ 放的是 240px 縮圖）。
 * 點擊事件：每一區一個事件名稱（寫在 section 的 data-ev），頁面有 GA4（gtag）才送。
 * 文字一律用 textContent 放進畫面（店名、公告標題可能含特殊字元）。
 */
(function () {
  'use strict';

  var script = document.currentScript;
  var SITE = (script && script.src) ? script.src.replace(/assets\/js\/home\.js(\?.*)?$/, '') : '/';
  var FINDER = '/finder.html';
  // 本機測試可用 window.TRA_HOME_META_BASE 換成本機快照（正式頁面不會設定它）
  var META = window.TRA_HOME_META_BASE || 'https://firestore.googleapis.com/v1/projects/taiwan-ramen-association/databases/(default)/documents/meta/';

  // ── 會動的圖示（icon-motion.js 負責播；形狀 PulsoIcon，ISC，授權見 assets/icons/PulsoIcon-LICENSE.txt） ──
  var ICON_CHEVRON = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" data-anim="chevron-right"><g><path d="m9 18 6-6-6-6"/></g></svg>';
  var ICON_ARROW = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" data-anim="arrow-right"><g><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></g></svg>';
  function useIcon(id) { return '<svg class="icon" aria-hidden="true"><use href="#i-' + id + '"/></svg>'; }

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function finderUrl(key, val) { return FINDER + '?' + key + '=' + encodeURIComponent(val); }
  // 'assets/images/x.jpg' 這種站內相對路徑 → 根目錄；完整網址照用
  function rootUrl(p) { return /^https?:\/\//.test(p) ? p : '/' + String(p).replace(/^\/+/, ''); }

  // 'YYYY-MM-DD'、'YYYY/M/D'、'YYYY年M月D日' → 當地時間 0 點（同 finder.html 的 parseOpenDate）
  function parseDate(s) {
    s = String(s || '');
    var m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/) || s.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function splitList(s) {
    var out = [], parts = String(s || '').split(/[,，、]/);
    for (var i = 0; i < parts.length; i++) { var t = parts[i].trim(); if (t) out.push(t); }
    return out;
  }
  function topKeys(counter, n) {
    var keys = [];
    for (var k in counter) if (Object.prototype.hasOwnProperty.call(counter, k)) keys.push(k);
    keys.sort(function (a, b) { return counter[b] - counter[a]; });
    return keys.slice(0, n);
  }

  // ═════ ① 搜尋框：空白送出就直接開搜尋器（不帶 ?q=）。沒有 JS 時表單本身也能送到 finder.html?q=… ═════
  var form = $('heroSearch');
  if (form) form.addEventListener('submit', function (e) {
    var q = (form.elements.q.value || '').trim();
    if (!q) { e.preventDefault(); location.href = FINDER; }
  });

  // ═════ ①③ 店家資料 ═════
  function renderShops(rows, now) {
    var cutoff = new Date(now.getTime()); cutoff.setMonth(cutoff.getMonth() - 3); // 新開幕：近 3 個月內
    var active = [], fresh = [], upcoming = [], cities = {}, styles = {}, cityCount = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || !r['店名'] || !String(r['店名']).trim() || r['營業狀態'] !== '營業中') continue;
      var d = parseDate(r['開幕日']);
      if (d && d > now) { upcoming.push({ r: r, d: d }); continue; } // 開幕日還沒到：finder 開幕當天 0 點才上架
      active.push(r);
      if (d && d >= cutoff) fresh.push({ r: r, d: d });
      var c = r['縣市'];
      if (c) { if (!cities[c]) { cities[c] = 0; cityCount++; } cities[c]++; }
      var st = splitList(r['派系']);
      for (var j = 0; j < st.length; j++) styles[st[j]] = (styles[st[j]] || 0) + 1;
    }

    // 數字
    var stats = $('heroStats');
    if (stats) {
      stats.querySelector('[data-stat="active"]').textContent = active.length;
      stats.querySelector('[data-stat="cities"]').textContent = cityCount;
      stats.querySelector('[data-stat="new"]').textContent = fresh.length;
      stats.removeAttribute('data-state');
    }

    // 快捷標籤：派系前四名＋新開幕＋縣市前三名
    var chips = $('heroChips');
    var words = topKeys(styles, 4).concat(['新開幕'], topKeys(cities, 3));
    if (chips && words.length >= 4) {
      chips.textContent = '';
      for (var w = 0; w < words.length; w++) {
        var a = el('a', 'chip', words[w]);
        a.href = finderUrl('q', words[w]);
        chips.appendChild(a);
      }
    }

    // ③ 卡片：即將開幕最多 3 張（越近越前面）＋新開幕（越新越前面），合計最多 7 張，再接「看全部」
    upcoming.sort(function (x, y) { return x.d - y.d; });
    fresh.sort(function (x, y) { return y.d - x.d; });
    var list = $('newopenList'), all = $('newopenAll');
    if (!list) return;
    var section = $('newopen');
    if (!fresh.length && !upcoming.length) { if (section) section.hidden = true; return; }
    var picks = upcoming.slice(0, 3);
    var room = 7 - picks.length;
    var shownFresh = fresh.slice(0, room);
    picks = picks.concat(shownFresh);
    list.textContent = '';
    list.removeAttribute('aria-busy');
    for (var p = 0; p < picks.length; p++) list.appendChild(shopCard(picks[p].r, picks[p].d, picks[p].d > now));
    if (fresh.length > shownFresh.length) {
      var more = el('a', 'shop-more');
      more.href = finderUrl('q', '新開幕');
      more.innerHTML = ICON_ARROW;
      more.appendChild(document.createTextNode('看全部 ' + fresh.length + ' 間新開幕'));
      list.appendChild(more);
    }
    if (all) {
      if (fresh.length) all.textContent = '看全部 ' + fresh.length + ' 間';
      else all.hidden = true;
    }
  }

  function shopCard(r, d, isUpcoming) {
    // 即將開幕的店還不在搜尋器裡 → 不做成連結
    var card = el(isUpcoming ? 'div' : 'a', 'shop-card');
    if (!isUpcoming) card.href = finderUrl('shop', r['ID']);
    var chip = el('span', 'open-chip' + (isUpcoming ? ' upcoming' : ''));
    chip.innerHTML = useIcon(isUpcoming ? 'calendar' : 'sparkles');
    chip.appendChild(document.createTextNode(pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()) + ' 開幕'));
    card.appendChild(chip);
    card.appendChild(el('p', 'shop-name', r['店名']));
    var place = [r['縣市'], r['鄉鎮市區']].join(' ').trim();
    if (place) {
      var loc = el('p', 'shop-loc');
      loc.innerHTML = useIcon('map-pin');
      loc.appendChild(document.createTextNode(place));
      card.appendChild(loc);
    }
    // 標籤：派系＋類型（「拉麵」以外），最多 3 個；都沒有才放類型
    var tags = splitList(r['派系']).slice(0, 2), types = splitList(r['類型']);
    for (var i = 0; i < types.length && tags.length < 3; i++) if (types[i] !== '拉麵' && tags.indexOf(types[i]) < 0) tags.push(types[i]);
    if (!tags.length && types.length) tags.push(types[0]);
    if (tags.length) {
      var box = el('div', 'shop-tags');
      for (var t = 0; t < tags.length; t++) box.appendChild(el('span', 'tag', tags[t]));
      card.appendChild(box);
    }
    return card;
  }

  function shopsFailed() {
    var list = $('newopenList');
    if (!list) return;
    list.textContent = '';
    list.removeAttribute('aria-busy');
    var msg = el('p', 'shop-note');
    msg.appendChild(document.createTextNode('店家資料暫時載入不了，'));
    var a = el('a', 'link-more', '直接打開拉麵搜尋器');
    a.href = FINDER;
    msg.appendChild(a);
    list.appendChild(msg);
  }

  function loadShops() {
    fetch('/data/data.json').then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      // 「今天」以伺服器時間為準（同 finder），手機時間不準也不會算錯
      var h = res.headers.get('Date'), now = h ? new Date(h) : new Date();
      if (isNaN(now.getTime())) now = new Date();
      return res.json().then(function (rows) { renderShops(rows || [], now); });
    })['catch'](shopsFailed);
  }

  // ═════ ①④ 首頁精選、主題懶人包（Firestore REST） ═════
  // Firestore REST 的值 → 一般 JS 值
  function fsVal(v) {
    if (!v) return null;
    if ('stringValue' in v) return v.stringValue;
    if ('booleanValue' in v) return v.booleanValue;
    if ('integerValue' in v) return +v.integerValue;
    if ('doubleValue' in v) return v.doubleValue;
    if ('arrayValue' in v) { var a = [], vs = v.arrayValue.values || []; for (var i = 0; i < vs.length; i++) a.push(fsVal(vs[i])); return a; }
    if ('mapValue' in v) return fsFields(v.mapValue.fields);
    return null;
  }
  function fsFields(f) { var o = {}; for (var k in (f || {})) if (Object.prototype.hasOwnProperty.call(f, k)) o[k] = fsVal(f[k]); return o; }
  function getMeta(name) {
    return fetch(META + name).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (doc) { return fsFields(doc && doc.fields); });
  }

  function tile(href, photo, pill, title, sub, eager) {
    var a = el('a', 'tile' + (photo ? ' has-img' : ''));
    a.href = href;
    if (photo) {
      var img = el('img');
      img.src = rootUrl(photo);
      img.alt = '';
      img.decoding = 'async';
      if (!eager) img.loading = 'lazy';
      a.appendChild(img);
    }
    if (pill) a.appendChild(el('span', 'tile-pill', pill));
    var body = el('div', 'tile-body');
    body.appendChild(el('h3', null, title));
    if (sub) body.appendChild(el('p', null, sub));
    a.appendChild(body);
    return a;
  }

  function renderMeta(featuredDoc, collectionsDoc) {
    // 精選：後台「隨機顯示」開著就每次隨機一則，關著固定第一則（同 finder）
    var items = (featuredDoc && featuredDoc.items) || [], pick = null;
    var usable = [];
    for (var i = 0; i < items.length; i++) if (items[i] && items[i].shopId) usable.push(items[i]);
    if (usable.length) pick = featuredDoc.shuffle ? usable[Math.floor(Math.random() * usable.length)] : usable[0];

    var hero = $('hero'), aside = $('heroAside');
    if (pick && aside) {
      aside.textContent = '';
      // 只在電腦版顯示；loading=lazy → 手機（這塊藏起來）不會下載這張圖
      aside.appendChild(tile(finderUrl('shop', pick.shopId), pick.photoUrl, '協會精選', pick.itemName || pick.shopName, pick.itemName ? pick.shopName : '', false));
    } else if (hero) {
      hero.className += ' no-aside';
    }

    var cols = (collectionsDoc && collectionsDoc.items) || [], shown = [];
    for (var c = 0; c < cols.length; c++) if (cols[c] && cols[c].visible === true && cols[c].id && cols[c].title) shown.push(cols[c]);
    var section = $('collections'), box = $('collectionTiles');
    if (!section || !box || (!shown.length && !pick)) return;
    box.textContent = '';
    for (var s = 0; s < shown.length; s++) box.appendChild(tile(finderUrl('collection', shown[s].id), shown[s].photoUrl, '', shown[s].title, shown[s].subtitle, false));
    if (pick) {
      // 手機版：精選放在懶人包裡（電腦版在主視覺右側，這張藏起來）
      var f = tile(finderUrl('shop', pick.shopId), pick.photoUrl, '協會精選', pick.itemName || pick.shopName, pick.itemName ? pick.shopName : '', false);
      f.className += ' is-featured';
      box.appendChild(f);
    }
    if (!shown.length) section.className += ' only-featured';
    section.hidden = false;
  }

  function loadMeta() {
    var a = getMeta('homeFeatured')['catch'](function () { return null; });
    var b = getMeta('homeCollections')['catch'](function () { return null; });
    Promise.all([a, b]).then(function (r) { renderMeta(r[0], r[1]); })['catch'](function () {
      var hero = $('hero');
      if (hero) hero.className += ' no-aside';
    });
  }

  // ═════ ⑤ 協會公告 ═════
  // 今天（台灣時間）→ 20261111 這種數字；homeUntil 同樣換成數字比，含當天
  function taiwanToday() { var t = new Date(Date.now() + 8 * 3600 * 1000); return t.getUTCFullYear() * 10000 + (t.getUTCMonth() + 1) * 100 + t.getUTCDate(); }
  function ymd(s) {
    var m = String(s || '').match(/^\s*(\d{4})\D(\d{1,2})\D(\d{1,2})/);
    if (!m) return 0;
    var y = +m[1], mo = +m[2], d = +m[3];
    return (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) ? y * 10000 + mo * 100 + d : 0;
  }

  function noticeMessage(list, text) {
    list.textContent = '';
    var li = el('li', 'notice-msg', text);
    list.appendChild(li);
  }

  function loadNotices() {
    var list = $('noticeList');
    if (!list) return;
    fetch('/data/news.json?t=' + Date.now()).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      var today = taiwanToday(), picks = [];
      for (var i = 0; i < (data || []).length && picks.length < 3; i++) {
        var it = data[i];
        if (!it || !it.title) continue;
        var until = ymd(it.homeUntil);
        if (until && today > until) continue; // 過了「首頁顯示到」就不放（最新消息頁照樣全列）
        picks.push(it);
      }
      if (!picks.length) { noticeMessage(list, '目前沒有新公告。'); return; }
      list.textContent = '';
      for (var p = 0; p < picks.length; p++) {
        var item = picks[p], li = el('li');
        var a = el('a');
        a.href = item.url || 'news.html';
        if (item.url && /^https?:/.test(item.url) && item.url.indexOf(location.host) < 0) { a.target = '_blank'; a.rel = 'noopener'; }
        var dm = String(item.date || '').match(/^\d{4}\D(\d{1,2})\D(\d{1,2})/);
        a.appendChild(el('span', 'notice-date', dm ? pad2(+dm[1]) + '/' + pad2(+dm[2]) : String(item.date || '')));
        var title = el('span', 'notice-title');
        if (item.tag) title.appendChild(el('span', 'tag tag-accent', item.tag));
        title.appendChild(document.createTextNode(item.title));
        a.appendChild(title);
        var arrow = el('span');
        arrow.innerHTML = ICON_CHEVRON;
        a.appendChild(arrow.firstChild);
        li.appendChild(a);
        list.appendChild(li);
      }
    })['catch'](function () { noticeMessage(list, '公告暫時載入不了，請到「最新消息」查看。'); });
  }

  // ═════ ⑥ 合作夥伴 ═════
  function loadPartners() {
    var strip = $('partnerStrip');
    if (!strip) return;
    fetch('/data/partners.json?t=' + Date.now()).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      strip.textContent = '';
      for (var i = 0; i < (data || []).length; i++) {
        var p = data[i];
        if (!p || !p.featured || !p.logo) continue;
        var box = el(p.url ? 'a' : 'span', 'partner' + (p.category === 'member' ? ' member' : ''));
        if (p.url) { box.href = p.url; box.target = '_blank'; box.rel = 'noopener'; }
        var img = el('img');
        img.src = /^https?:\/\//.test(p.logo) ? p.logo : SITE + String(p.logo).replace(/^\/+/, '');
        img.alt = p.name || '';
        img.loading = 'lazy';
        img.decoding = 'async';
        box.appendChild(img);
        strip.appendChild(box);
      }
      if (!strip.firstChild) strip.hidden = true;
    })['catch'](function () { strip.hidden = true; });
  }

  // ═════ 點擊事件（GA4）：每區一個事件名稱 ═════
  document.addEventListener('click', function (e) {
    if (typeof window.gtag !== 'function') return;
    var n = e.target, link = null, block = null;
    while (n && n !== document) {
      if (!link && n.nodeType === 1 && /^(a|button)$/i.test(n.tagName)) link = n;
      if (link && n.nodeType === 1 && n.getAttribute('data-ev')) { block = n; break; }
      n = n.parentNode;
    }
    if (!block) return;
    try { window.gtag('event', block.getAttribute('data-ev'), { link_text: (link.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) }); } catch (err) {}
  });

  // 小檔案馬上抓；店家資料（約 172 KB）等畫面先畫出來再抓
  loadNotices();
  loadPartners();
  loadMeta();
  if (window.requestAnimationFrame) window.requestAnimationFrame(function () { setTimeout(loadShops, 0); });
  else setTimeout(loadShops, 0);
})();
