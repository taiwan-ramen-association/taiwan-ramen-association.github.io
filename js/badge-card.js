// ── badge-card.js ────────────────────────────────────────────────────────────
// 獎章分享圖卡：用 canvas 畫 1080×1920（IG 限時動態）並輸出 PNG
// 規格見 ramen-finder-notes/achievement-system.md §七；圓章外框照 finder.html 的 .bdg-coin（t1～t5）
// 依賴全域函式（有才用）：_scnLoadQrCodeLib（js/scan.js，lazy load qrcodejs）
// 提供全域：BADGE_CARD_THEMES、badgeCardRender

const BADGE_CARD_W = 1080, BADGE_CARD_H = 1920;
const BADGE_CARD_URL = 'https://www.taiwanramen.org/finder.html?page=challenges&utm_source=badge_card';

// 配色：預覽下方一排圓點切換（圓點畫 bg 的漸層）。dark＝深底：logo 用白字版、級名用亮色
//   glow＝頭像後面的柔光（淺底不加）、panel＝獎章橫帶底色、raimon＝橫帶上下緣雷紋、
//   coinGap＝白金／鑽石外框和細框之間那圈（接近橫帶的實際顏色）
const BADGE_CARD_THEMES = [
  { id: 'ink', name: '墨黑', bg: ['#2b2520', '#0e0c0a'], glow: 'rgba(235,144,153,0.20)',
    panel: 'rgba(255,255,255,0.06)', panelLine: 'rgba(255,255,255,0.12)', raimon: 'rgba(235,144,153,0.75)',
    text: '#ffffff', sub: '#c8bdb0', ring: '#eb9099', coinGap: '#2a2622', avatarBg: '#3b342d', dark: true },
  { id: 'paper', name: '暖白', bg: ['#fff7e6', '#fff0ec'], glow: null,
    panel: 'rgba(255,255,255,0.72)', panelLine: '#f0d9c0', raimon: 'rgba(200,39,45,0.55)',
    text: '#3a2a20', sub: '#8a7a70', ring: '#C8272D', coinGap: '#ffffff', avatarBg: '#3a2a20', dark: false },
  { id: 'sakura', name: '櫻粉', bg: ['#f4a7ae', '#eb9099'], glow: null,
    panel: 'rgba(255,255,255,0.32)', panelLine: 'rgba(255,255,255,0.65)', raimon: 'rgba(26,18,9,0.55)',
    text: '#1a1209', sub: '#5b3b37', ring: '#ffffff', coinGap: '#f6c3c8', avatarBg: '#1a1209', dark: false },
  { id: 'shu', name: '朱紅', bg: ['#d8343a', '#a11c22'], glow: 'rgba(255,214,120,0.20)',
    panel: 'rgba(0,0,0,0.14)', panelLine: 'rgba(255,255,255,0.20)', raimon: 'rgba(255,226,122,0.75)',
    text: '#ffffff', sub: '#ffd9d3', ring: '#ffe27a', coinGap: '#a8242a', avatarBg: '#7d1519', dark: true },
  { id: 'summer', name: '夏日藍', bg: ['#e8f5fd', '#b6dbf2'], glow: null,
    panel: 'rgba(255,255,255,0.58)', panelLine: 'rgba(255,255,255,0.95)', raimon: 'rgba(43,123,185,0.5)',
    text: '#12324a', sub: '#4a6a82', ring: '#ffffff', coinGap: '#f2f9fd', avatarBg: '#12324a', dark: false },
  { id: 'night', name: '深夜藍', bg: ['#1e2b46', '#0a1121'], glow: 'rgba(143,211,255,0.16)',
    panel: 'rgba(255,255,255,0.06)', panelLine: 'rgba(255,255,255,0.12)', raimon: 'rgba(143,211,255,0.6)',
    text: '#ffffff', sub: '#a9b8cf', ring: '#8fd3ff', coinGap: '#1f2a40', avatarBg: '#2a3a5c', dark: true },
];

const _BC_SANS  = '"Noto Sans TC", "PingFang TC", "Heiti TC", "Microsoft JhengHei", sans-serif';
const _BC_SERIF = '"Noto Serif TC", "Songti TC", "PMingLiU", serif';
const _BC_EMOJI = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
const _BC_LOGO  = { light: 'assets/badges/card-logo-light.png', dark: 'assets/badges/card-logo-dark.png' };
const _BC_MARK  = 'assets/badges/card-mark.png';   // 沒頭像時的拉麵圖示（白色麵碗，墊 avatarBg 圓底）
const _BC_CTA   = ['一起收集拉麵獎章', '掃描 QR code 或上 taiwanramen.org'];

// 外框漸層：同 finder.html .bdg-coin.t1～t5（135deg）
const _BC_RING = {
  1: [[0, '#e7b07a'], [0.45, '#a8672f'], [0.7, '#d99a5b'], [1, '#8c5426']],
  2: [[0, '#ffffff'], [0.45, '#a9adb3'], [0.7, '#e6e8eb'], [1, '#8f949a']],
  3: [[0, '#fff3b0'], [0.45, '#d4a017'], [0.7, '#ffe27a'], [1, '#b8860b']],
  4: [[0, '#f7fbff'], [0.4, '#9fb6cc'], [0.65, '#eef4fa'], [1, '#7f97ae']],
  5: [[0, '#f0fbff'], [0.35, '#8fd3ff'], [0.55, '#ffffff'], [0.8, '#b28cff'], [1, '#8fd3ff']],
};
const _BC_OUTER = { 4: '#8fa6bd', 5: '#8fd3ff' };   // 白金、鑽石外圍多一圈細框（CSS 的 box-shadow）
// 級名顏色：淺底同 .bdg-tn；深底調亮
const _BC_TIER_LIGHT = ['', '#a8672f', '#7d8288', '#b8860b', '#6f88a0', '#8b6cff'];
const _BC_TIER_DARK  = ['', '#e3a56b', '#d3d7dc', '#f5c842', '#bcd0e4', '#c3b2ff'];

const _bcImgCache = new Map();   // 網址 → Promise<Image|null>：切換配色重畫時不用重新下載

// ── 載入 ────────────────────────────────────────────────────────────────────
// 跨網域的圖加參數跟頁面上的 <img>（不帶 CORS）分開快取，避免拿到沒有 CORS 標頭的舊回應
function _bcSrc(src) {
  try {
    const u = new URL(src, location.href);
    if (u.origin !== location.origin) u.searchParams.set('bc', '1');
    return u.href;
  } catch (e) { return src; }
}

// 一律用 crossOrigin 載入：沒開 CORS 的圖會直接載入失敗（退回 emoji／拉麵圖示），canvas 不會被污染、一定能輸出
function _bcLoadImg(src, timeout) {
  if (!src) return Promise.resolve(null);
  const url = _bcSrc(src);
  if (_bcImgCache.has(url)) return _bcImgCache.get(url);
  const p = new Promise(resolve => {
    const img = new Image();
    const done = v => { clearTimeout(timer); img.onload = img.onerror = null; resolve(v); };
    const timer = setTimeout(() => done(null), timeout || 5000);
    img.crossOrigin = 'anonymous';
    img.onload = () => done(img.naturalWidth ? img : null);
    img.onerror = () => done(null);
    img.src = url;
  });
  p.then(v => { if (!v) _bcImgCache.delete(url); });   // 失敗的不留，下次再試
  _bcImgCache.set(url, p);
  return p;
}

// Google Fonts 的中文是依字分片載入，要帶上實際會畫的字；載不到就用系統字
function _bcLoadFonts(text) {
  if (!document.fonts || !document.fonts.load) return Promise.resolve();
  const specs = ['900 64px "Noto Serif TC"', '700 40px "Noto Serif TC"', '500 30px "Noto Sans TC"', '400 30px "Noto Sans TC"'];
  const all = Promise.all(specs.map(f => document.fonts.load(f, text).catch(() => null)));
  return Promise.race([all, new Promise(r => setTimeout(r, 4000))]);
}

// QR code：拿 qrcodejs 的模組自己畫（比縮放它產生的小圖清楚）
async function _bcQr(text) {
  try {
    if (typeof QRCode === 'undefined' && typeof _scnLoadQrCodeLib === 'function') await _scnLoadQrCodeLib();
    if (typeof QRCode === 'undefined') return null;
    const q = new QRCode(document.createElement('div'), { text, width: 64, height: 64, correctLevel: QRCode.CorrectLevel.M });
    const m = q._oQRCode;
    return m && m.getModuleCount ? m : null;
  } catch (e) {
    console.warn('[badge-card] QR code 產生失敗', e);
    return null;
  }
}

// ── 畫圖零件 ────────────────────────────────────────────────────────────────
const _bcFont = (weight, size, family) => `${weight} ${size}px ${family}`;

function _bcCircle(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.closePath();
}

function _bcRRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 同 CSS object-fit: cover
function _bcCover(ctx, img, x, y, w, h) {
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const s = Math.max(w / iw, h / ih), sw = w / s, sh = h / s;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
}

// 字太長就縮小，回傳最後的字級（ctx.font 已設好）
function _bcFit(ctx, text, maxW, weight, family, size, min) {
  let s = size;
  for (; s > min; s -= 2) {
    ctx.font = _bcFont(weight, s, family);
    if (ctx.measureText(text).width <= maxW) return s;
  }
  ctx.font = _bcFont(weight, min, family);
  return min;
}

function _bcEllipsis(ctx, s, maxW) {
  if (ctx.measureText(s).width <= maxW) return s;
  let t = Array.from(s);
  while (t.length && ctx.measureText(t.join('') + '…').width > maxW) t.pop();
  return t.join('') + '…';
}

// 折行：放得下就一行；要兩行而且中間有空格、兩邊都放得下，就在空格斷（「2026」「夏日冷麵納涼祭」）；
// 其他照總寬平均分行（中文沒有空格可斷，平均才不會最後一行只剩一個字）；超過行數最後一行加刪節號
function _bcWrap(ctx, text, maxW, maxLines) {
  const str = String(text || '').trim();
  const w = s => ctx.measureText(s).width;
  const total = w(str);
  if (total <= maxW || maxLines < 2) return [_bcEllipsis(ctx, str, maxW)];
  const L = Math.min(maxLines, Math.ceil(total / maxW));
  if (L === 2) {
    let best = null;
    for (let i = str.indexOf(' '); i > 0; i = str.indexOf(' ', i + 1)) {
      const a = str.slice(0, i).trim(), b = str.slice(i + 1).trim();
      if (a && b && w(a) <= maxW && w(b) <= maxW && (!best || Math.abs(w(a) - w(b)) < best.d)) best = { a, b, d: Math.abs(w(a) - w(b)) };
    }
    if (best) return [best.a, best.b];
  }
  const target = Math.min(maxW, (total / L) * 1.08);
  const lines = [];
  let cur = '';
  for (const ch of Array.from(str)) {
    if (cur && lines.length < L - 1 && w(cur + ch) > target) { lines.push(cur.trim()); cur = ch === ' ' ? '' : ch; }
    else cur += ch;
  }
  lines.push(_bcEllipsis(ctx, cur.trim(), maxW));
  return lines;
}

// 圓章：外框依級數（同 .bdg-coin），中間放圖（活動封面／店徽）、店名文字或 emoji
function _bcCoin(ctx, b, img, cx, cy, d, th) {
  const r = d / 2, t = Math.max(1, Math.min(5, b.tier | 0));
  if (_BC_OUTER[t]) {   // 白金、鑽石：先一圈底色、再一圈細框
    _bcCircle(ctx, cx, cy, r + d * 0.055); ctx.fillStyle = _BC_OUTER[t]; ctx.fill();
    _bcCircle(ctx, cx, cy, r + d * 0.035); ctx.fillStyle = th.coinGap; ctx.fill();
  }
  const g = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
  _BC_RING[t].forEach(([p, c]) => g.addColorStop(p, c));
  _bcCircle(ctx, cx, cy, r); ctx.fillStyle = g; ctx.fill();

  const ir = r - Math.round(d * 0.065);
  ctx.save();
  _bcCircle(ctx, cx, cy, ir); ctx.fillStyle = '#fffaf3'; ctx.fill(); ctx.clip();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (img) {
    _bcCover(ctx, img, cx - ir, cy - ir, ir * 2, ir * 2);
  } else if (b.text) {   // 職人：沒有店徽就寫店名
    const size = Math.round(ir * 0.36), lh = size * 1.25;
    ctx.font = _bcFont(700, size, _BC_SANS); ctx.fillStyle = '#5a4636';
    const lines = _bcWrap(ctx, b.text, ir * 1.5, 3);
    lines.forEach((ln, i) => ctx.fillText(ln, cx, cy + (i - (lines.length - 1) / 2) * lh));
  } else {
    ctx.font = _bcFont(400, Math.round(ir * 0.95), _BC_EMOJI);
    ctx.fillText(b.icon || '🏅', cx, cy + ir * 0.06);
  }
  ctx.restore();
  if (t === 5) {   // 鑽石：皇冠（同 CSS ::before 👑）
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = _bcFont(400, Math.round(d * 0.26), _BC_EMOJI);
    ctx.fillText('👑', cx, cy - r - d * 0.07);
  }
}

// 雷紋（拉麵碗口的回字紋）：一格一個方形螺旋，橫向排滿
function _bcRaimon(ctx, x, y, w, h, color) {
  const lw = Math.max(2, Math.round(h * 0.1)), s = h * 1.12;
  const P = [[0, 1], [0, 0], [0.86, 0], [0.86, 0.76], [0.2, 0.76], [0.2, 0.26], [0.64, 0.26], [0.64, 0.52], [0.42, 0.52]];
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineJoin = 'miter'; ctx.lineCap = 'butt';
  ctx.beginPath();
  for (let ox = x - s / 2; ox < x + w; ox += s) {
    P.forEach(([px, py], j) => {
      const X = ox + px * s, Y = y + lw / 2 + py * (h - lw);
      if (j) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
    });
  }
  ctx.stroke();
  // 底線把每格接起來
  ctx.beginPath(); ctx.moveTo(x, y + h - lw / 2); ctx.lineTo(x + w, y + h - lw / 2); ctx.stroke();
  ctx.restore();
}

function _bcAvatar(ctx, img, isMark, cx, cy, d, th) {
  const r = d / 2;
  _bcCircle(ctx, cx, cy, r + 9); ctx.fillStyle = th.ring; ctx.fill();
  ctx.save();
  _bcCircle(ctx, cx, cy, r); ctx.fillStyle = th.avatarBg; ctx.fill(); ctx.clip();
  if (img && !isMark) {
    _bcCover(ctx, img, cx - r, cy - r, d, d);
  } else if (img) {
    const w = d * 0.66, h = w * img.naturalHeight / img.naturalWidth;
    ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
  }
  ctx.restore();
}

// 一行統計：0 的項目不印
function _bcStatsLine(s) {
  s = s || {};
  return [
    s.events ? `參加活動 ${s.events} 檔` : '',
    s.stamps ? `踩點 ${s.stamps} 間` : '',
    s.cities ? `足跡 ${s.cities} 縣市` : '',
  ].filter(Boolean).join('｜');
}

// ── 主程式 ──────────────────────────────────────────────────────────────────
// data：{ name, avatar, level, title, stats:{events,stamps,cities}, badges:[{ name, tier, tierLabel, image, icon, text }] }
//   name 空＝不印；avatar 空或讀不到＝拉麵圖示；badges 最多 6 枚、照順序畫
// 回傳 PNG 的 Blob
async function badgeCardRender(data, themeId) {
  const th = BADGE_CARD_THEMES.find(t => t.id === themeId) || BADGE_CARD_THEMES[0];
  const badges = (data.badges || []).slice(0, 6);
  const stats = _bcStatsLine(data.stats);
  const allText = [data.name, data.title, stats, 'Lv.0123456789…', ..._BC_CTA,
    ...badges.map(b => (b.name || '') + (b.tierLabel || '') + (b.text || ''))].join('');
  const [, logo, avatar, mark, qr, ...imgs] = await Promise.all([
    _bcLoadFonts(allText),
    _bcLoadImg(th.dark ? _BC_LOGO.light : _BC_LOGO.dark),
    _bcLoadImg(data.avatar),
    _bcLoadImg(_BC_MARK),
    _bcQr(BADGE_CARD_URL),
    ...badges.map(b => _bcLoadImg(b.image)),
  ]);

  const W = BADGE_CARD_W, H = BADGE_CARD_H, CX = W / 2, SIDE = 72;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // 背景（深底在頭像後面加一團柔光；淺底加了會像起霧，不加）
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, th.bg[0]); bg.addColorStop(1, th.bg[1]);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  if (th.glow) {
    const g = ctx.createRadialGradient(CX, 420, 0, CX, 420, 640);
    g.addColorStop(0, th.glow); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

  // ── 版面：上段（頭像、暱稱、Lv＋稱號、統計）＋獎章帶當成一組，在 IG 頭像列（上緣約 200px）和下段之間置中、稍微偏上；
  //    下段（logo＋說明、QR）固定在回覆列（底部約 220px）上方
  const SAFE_TOP = 236, QB = 224, footBottom = 1700, footTop = footBottom - QB;
  const AD = 200;
  const nameSize = data.name ? _bcFit(ctx, data.name, W - SIDE * 2, 900, _BC_SERIF, 64, 40) : 0;
  const topH = AD + 9 + 34 + (nameSize ? nameSize + 26 : 0) + 54 + 24 + (stats ? 34 : 0);
  const n = badges.length;
  const rows = n <= 3 ? [n] : n === 4 ? [2, 2] : [3, n - 3];   // 1～3 枚一排；4 枚 2＋2；5、6 枚 3＋其餘
  const D = 150, CROWN = 30, NAME_FS = 29, NAME_LH = 35, TIER_FS = 26, TIER_LH = 32, RM = 32;   // RM＝雷紋高度
  const rowH = CROWN + D + 14 + NAME_LH * 2 + TIER_LH;
  const padT = RM + 18, padB = RM + 16, rowGap = 8;
  const panelH = n ? padT + rows.length * rowH + (rows.length - 1) * rowGap + padB : 0;
  const GAP = 30, midBottom = footTop - 36;
  const groupH = topH + (n ? GAP + panelH : 0);
  let y = SAFE_TOP + Math.max(0, (midBottom - SAFE_TOP - groupH) * 0.42);

  _bcAvatar(ctx, avatar || mark, !avatar, CX, y + AD / 2, AD, th);
  y += AD + 9 + 34;
  if (nameSize) {
    ctx.font = _bcFont(900, nameSize, _BC_SERIF); ctx.fillStyle = th.text;
    ctx.fillText(data.name, CX, y + nameSize / 2);
    y += nameSize + 26;
  }
  {
    const ph = 54, lv = 'Lv.' + (data.level || 0);
    ctx.font = _bcFont(800, 32, _BC_SANS);
    const pw = ctx.measureText(lv).width + 40;
    let tw = 0, ts = 0;
    if (data.title) {
      ts = _bcFit(ctx, data.title, W - SIDE * 2 - pw - 20, 700, _BC_SERIF, 38, 24);
      tw = ctx.measureText(data.title).width;
    }
    const x = CX - (pw + (tw ? 20 + tw : 0)) / 2;
    const g = ctx.createLinearGradient(x, y, x + pw, y + ph);
    g.addColorStop(0, '#e2b21c'); g.addColorStop(1, '#b8860b');
    _bcRRect(ctx, x, y, pw, ph, ph / 2); ctx.fillStyle = g; ctx.fill();
    ctx.font = _bcFont(800, 32, _BC_SANS); ctx.fillStyle = '#ffffff';
    ctx.fillText(lv, x + pw / 2, y + ph / 2 + 1);
    if (tw) {
      ctx.textAlign = 'left';
      ctx.font = _bcFont(700, ts, _BC_SERIF); ctx.fillStyle = th.text;
      ctx.fillText(data.title, x + pw + 20, y + ph / 2 + 1);
      ctx.textAlign = 'center';
    }
    y += ph + 24;
  }
  if (stats) {
    _bcFit(ctx, stats, W - SIDE * 2, 400, _BC_SANS, 30, 22);
    ctx.fillStyle = th.sub;
    ctx.fillText(stats, CX, y + 16);
    y += 34;
  }
  const topEnd = y;

  // ── 下段：logo＋說明（左）、QR（右）
  const qx = W - SIDE - QB;
  _bcRRect(ctx, qx, footTop, QB, QB, 24); ctx.fillStyle = '#ffffff'; ctx.fill();
  if (!th.dark) { ctx.strokeStyle = th.panelLine; ctx.lineWidth = 2; ctx.stroke(); }
  if (qr) {
    const qn = qr.getModuleCount(), cell = Math.floor((QB - 28) / qn), size = cell * qn;
    const ox = Math.round(qx + (QB - size) / 2), oy = Math.round(footTop + (QB - size) / 2);
    ctx.fillStyle = '#1a1209';
    for (let r = 0; r < qn; r++) for (let c = 0; c < qn; c++) if (qr.isDark(r, c)) ctx.fillRect(ox + c * cell, oy + r * cell, cell, cell);
  }
  ctx.textAlign = 'left';
  const lx = SIDE + 4, maxTW = qx - 36 - lx;
  let fy = footTop + 6;
  if (logo) {
    const lw = 210, lh = lw * logo.naturalHeight / logo.naturalWidth;
    ctx.drawImage(logo, lx, fy, lw, lh);
    fy += lh + 22;
  }
  const s1 = _bcFit(ctx, _BC_CTA[0], maxTW, 700, _BC_SERIF, 40, 28);
  ctx.fillStyle = th.text; ctx.fillText(_BC_CTA[0], lx, fy + s1 / 2);
  fy += s1 + 16;
  const s2 = _bcFit(ctx, _BC_CTA[1], maxTW, 400, _BC_SANS, 27, 20);
  ctx.fillStyle = th.sub; ctx.fillText(_BC_CTA[1], lx, fy + s2 / 2);
  ctx.textAlign = 'center';

  // ── 中段：精選獎章，滿版橫帶、上下緣雷紋（拉麵碗口的花紋）
  if (n) {
    const py = topEnd + GAP, colW = (W - SIDE * 2 - 36) / 3;
    ctx.fillStyle = th.panel; ctx.fillRect(0, py, W, panelH);
    _bcRaimon(ctx, 0, py, W, RM, th.raimon);
    _bcRaimon(ctx, 0, py + panelH - RM, W, RM, th.raimon);
    let k = 0;
    rows.forEach((cnt, ri) => {
      const ry = py + padT + ri * (rowH + rowGap);
      for (let i = 0; i < cnt; i++, k++) {
        const b = badges[k];
        const cx = CX + (i - (cnt - 1) / 2) * colW, cy = ry + CROWN + D / 2;
        _bcCoin(ctx, b, imgs[k], cx, cy, D, th);
        ctx.font = _bcFont(700, NAME_FS, _BC_SANS); ctx.fillStyle = th.text;
        let ly = cy + D / 2 + 14 + NAME_LH / 2;
        _bcWrap(ctx, b.name, colW - 28, 2).forEach(ln => { ctx.fillText(ln, cx, ly); ly += NAME_LH; });
        if (b.tierLabel) {
          ctx.font = _bcFont(700, TIER_FS, _BC_SANS);
          ctx.fillStyle = (th.dark ? _BC_TIER_DARK : _BC_TIER_LIGHT)[Math.min(5, Math.max(1, b.tier | 0))];
          ctx.fillText(b.tierLabel, cx, ly - NAME_LH / 2 + TIER_LH / 2);
        }
      }
    });
  }

  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('圖卡輸出失敗'))), 'image/png'));
}
