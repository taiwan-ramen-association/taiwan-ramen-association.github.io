/*
 * icon-motion.js — 電腦上滑鼠移入、或用 Tab 選到按鈕時，播放按鈕裡的圖示動畫（2026-11 改版）
 *
 * 規則（11/11 定案）：只認滑鼠（pointerType 'mouse'）與鍵盤焦點；手指點按一律不播、直接換頁或執行；
 * 移開後 0.25 秒滑回原位；系統開了「減少動態」就不播。用瀏覽器內建的 Web Animations，不載外部套件、不連外。
 * 不先掃整頁：第一次有滑鼠移到按鈕上（或 Tab 選到）時，才替那顆按鈕準備動畫。
 *
 * 用法：連結或按鈕裡放
 *   <svg class="icon" viewBox="0 0 24 24" data-anim="search"><g>…形狀…</g></svg>
 * 每個 <g> 是一段動作，順序對應下面 SPECS 的陣列（同一個圖示不能用 <use> 共用，否則沒辦法只動其中一顆）。
 *
 * 動作與參數移植自 PulsoIcon（https://github.com/CityPulso/PulsoIcon，ISC）的 recipes.ts 與 icons/*.ts；
 * 授權全文見 ../icons/PulsoIcon-LICENSE.txt
 */
(function () {
  'use strict';
  if (!document.documentElement.animate || !document.addEventListener) return;

  var EASE = 'cubic-bezier(0.42, 0, 0.58, 1)'; // Motion 的 easeInOut，每一段各套一次
  var BACK_MS = 250;                            // 回原位（PulsoIcon 的 back：0.25 秒 easeOut）
  var reduceMq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  // 圖示 → 每段 [動作, 參數]；o＝動作中心（viewBox 座標），d＝延遲秒數
  var SPECS = {
    search: [['swing', { a: 14, o: [11, 11] }]],
    flag: [['swing', { a: 8, o: [4, 22] }]],
    'chevron-right': [['bounce', { x: 1, a: 2, o: [12, 12] }]],
    'arrow-right': [['shoot', { x: 1, a: 6, o: [12, 12] }]],
    'brand-instagram': [['press', { a: 0.05, o: [12, 12] }], ['blink', { d: 0.05, o: [12, 12] }], ['flicker', { d: 0.2, o: [17.5, 6.5] }]],
    'brand-facebook': [['bounce', { y: -1, a: 2, o: [12, 22] }]],
    'brand-threads': [['redraw', { o: [12, 12] }]]
  };

  function frames(list, offsets) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      f.offset = offsets ? offsets[i] : i / (list.length - 1);
      f.easing = EASE;
      out.push(f);
    }
    return out;
  }
  function rot(deg) { var l = []; for (var i = 0; i < deg.length; i++) l.push({ transform: 'rotate(' + deg[i] + 'deg)' }); return l; }
  function move(xs, ys, op) {
    var l = [];
    for (var i = 0; i < xs.length; i++) {
      var f = { transform: 'translate(' + xs[i] + 'px, ' + ys[i] + 'px)' };
      if (op) f.opacity = op[i];
      l.push(f);
    }
    return l;
  }
  function scale(sx, sy) { var l = []; for (var i = 0; i < sx.length; i++) l.push({ transform: 'scale(' + sx[i] + ', ' + sy[i] + ')' }); return l; }

  // 回傳 { k: 關鍵影格, ms: 長度, dash: 是否改線條（redraw） }
  function recipe(kind, p) {
    var x = p.x || 0, y = p.y || 0, a;
    switch (kind) {
      case 'swing': a = p.a || 10; return { k: frames(rot([0, a, -a * 0.75, a * 0.4, 0])), ms: 800 };
      case 'bounce': a = p.a || 3; return { k: frames(move([0, x * a, 0, x * a * 0.4, 0], [0, y * a, 0, y * a * 0.4, 0])), ms: 600 };
      case 'shoot': a = p.a || 7; return { k: frames(move([0, x * a, -x * a, 0], [0, y * a, -y * a, 0], [1, 0, 0, 1]), [0, 0.4, 0.41, 1]), ms: 600 };
      case 'press': a = p.a || 0.15; return { k: frames(scale([1, 1 - a, 1.05, 1], [1, 1 - a, 1.05, 1])), ms: 400 };
      case 'blink': return { k: frames(scale([1, 1, 1], [1, 0.1, 1])), ms: 350 };
      case 'flicker': return { k: frames([{ opacity: 1 }, { opacity: 0.3 }, { opacity: 1 }, { opacity: 0.5 }, { opacity: 1 }], [0, 0.2, 0.4, 0.6, 1]), ms: 600 };
      case 'redraw': return {
        k: frames([{ strokeDasharray: '1px 1px', strokeDashoffset: '0px' }, { strokeDasharray: '0px 1px', strokeDashoffset: '-1px' }, { strokeDasharray: '1px 1px', strokeDashoffset: '0px' }]),
        ms: 700, dash: true };
    }
    return null;
  }

  function player(el) {
    if (el._iconMotion) return el._iconMotion;
    var svg = el.querySelector('svg[data-anim]');
    var spec = svg && SPECS[svg.getAttribute('data-anim')];
    var parts = [];
    if (spec) {
      var groups = [];
      for (var c = svg.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && c.tagName.toLowerCase() === 'g') groups.push(c);
      for (var i = 0; i < spec.length && i < groups.length; i++) {
        var r = recipe(spec[i][0], spec[i][1]);
        if (!r) continue;
        var targets = [];
        if (r.dash) {
          // 線條擦掉再畫回來：把整條線的長度當成 1，改虛線長度（同 Motion 的 pathLength 做法）
          var paths = groups[i].querySelectorAll('path');
          for (var k = 0; k < paths.length; k++) { paths[k].setAttribute('pathLength', '1'); targets.push(paths[k]); }
        } else {
          groups[i].style.transformOrigin = spec[i][1].o[0] + 'px ' + spec[i][1].o[1] + 'px';
          targets.push(groups[i]);
        }
        parts.push({ r: r, targets: targets, delay: (spec[i][1].d || 0) * 1000 });
      }
    }
    var running = [];
    function cancelAll() { for (var i = 0; i < running.length; i++) running[i].a.cancel(); running = []; }
    el._iconMotion = {
      play: function () {
        if (!parts.length || (reduceMq && reduceMq.matches)) return;
        cancelAll();
        for (var i = 0; i < parts.length; i++) {
          for (var t = 0; t < parts[i].targets.length; t++) {
            var node = parts[i].targets[t];
            running.push({ node: node, dash: parts[i].r.dash, a: node.animate(parts[i].r.k, { duration: parts[i].r.ms, delay: parts[i].delay }) });
          }
        }
      },
      rest: function () {
        if (!running.length) return;
        var now = [];
        for (var i = 0; i < running.length; i++) {
          var cs = window.getComputedStyle(running[i].node);
          now.push(running[i].dash
            ? { node: running[i].node, from: { strokeDasharray: cs.strokeDasharray, strokeDashoffset: cs.strokeDashoffset }, to: { strokeDasharray: '1px 1px', strokeDashoffset: '0px' } }
            : { node: running[i].node, from: { transform: cs.transform, opacity: cs.opacity }, to: { transform: 'none', opacity: 1 } });
        }
        cancelAll();
        for (var j = 0; j < now.length; j++) {
          running.push({ node: now[j].node, dash: false, a: now[j].node.animate([now[j].from, now[j].to], { duration: BACK_MS, easing: 'ease-out' }) });
        }
      }
    };
    return el._iconMotion;
  }

  // 往上找最近的連結／按鈕，裡面要有會動的圖示
  function trigger(node) {
    while (node && node !== document) {
      if (node.nodeType === 1 && /^(a|button|label)$/i.test(node.tagName)) return node.querySelector('svg[data-anim]') ? node : null;
      node = node.parentNode;
    }
    return null;
  }

  var lastKey = 0;
  document.addEventListener('keydown', function () { lastKey = Date.now(); }, true);
  function keyboardFocus(el) {
    try { return el.matches(':focus-visible'); } catch (e) { return Date.now() - lastKey < 1000; } // 舊瀏覽器不認 :focus-visible
  }

  document.addEventListener('pointerover', function (e) {
    if (e.pointerType !== 'mouse') return;   // 手指、觸控筆：不播
    var el = trigger(e.target);
    if (el && !el.contains(e.relatedTarget)) player(el).play();
  });
  document.addEventListener('pointerout', function (e) {
    if (e.pointerType !== 'mouse') return;
    var el = trigger(e.target);
    if (el && !el.contains(e.relatedTarget)) player(el).rest();
  });
  document.addEventListener('focusin', function (e) {
    var el = trigger(e.target);
    if (el && keyboardFocus(el)) player(el).play();
  });
  document.addEventListener('focusout', function (e) {
    var el = trigger(e.target);
    if (el) player(el).rest();
  });
})();
