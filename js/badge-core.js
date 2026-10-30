// ── badge-core.js ────────────────────────────────────────────────────────────
// 獎章系統的計算核心：不碰 DOM、不讀 Firestore，給資料 → 算出每枚獎章的級數與總點數（＝會員 Lv）。
// 前台 js/badges.js 與後台 admin-bundle.js「重算等級」共用這一份，兩邊算出的 Lv 才會一致。
// 規格：ramen-finder-notes/achievement-system.md（§三 清單、§四 點數、§九 資料結構）
// 提供全域變數：
//   BADGE_DEFAULT_CONFIG
// 提供全域函式：
//   badgeMergeConfig, badgeChallengeConfig, badgeCompute,
//   badgeTierName, badgeTitleText, badgeAutoFeatured, badgeNewSince, badgePointsAt

// 預設設定：Firestore meta/achievementConfig 不存在、或缺某個欄位時用這份
var BADGE_DEFAULT_CONFIG = {
  tiers: [
    { key: 'bronze',   name: '銅',   points: 1 },
    { key: 'silver',   name: '銀',   points: 2 },
    { key: 'gold',     name: '金',   points: 4 },
    { key: 'platinum', name: '白金', points: 8 },
    { key: 'diamond',  name: '鑽石', points: 16 },
  ],
  activityMultiplier: 2,   // 活動類（每檔活動＋活動常客）點數加倍
  badges: [
    { id: 'stamps_all',   name: '全台踩點',   icon: '🍜', source: 'stamps',    unit: '間',   thresholds: [10, 50, 100, 300, 500] },
    { id: 'stamps_tpe',   name: '台北踩點',   icon: '🏙️', source: 'stamps',    unit: '間',   thresholds: [10, 30, 50, 100, 200], filter: { '縣市': '臺北市' } },
    { id: 'cities',       name: '足跡縣市',   icon: '🗺️', source: 'cities',    unit: '縣市', thresholds: [3, 5, 10, 15, 22] },
    { id: 'regular',      name: '活動常客',   icon: '🎟️', source: 'events',    unit: '檔',   thresholds: [2, 3, 5, 8, 12], activity: true },
    { id: 'menus',        name: '菜單上傳',   icon: '📋', source: 'menus',     unit: '張',   thresholds: [1, 5, 10, 30, 50] },
    { id: 'first_review', name: '第一篇評論', icon: '✍️', source: 'reviews',   unit: '篇',   thresholds: [1] },
    { id: 'craftsman',    name: '拉麵職人',   icon: '👨‍🍳', source: 'craftsman', unit: '間',   thresholds: [1] },
  ],
  shopLogos: {},           // { shopId: 'assets/badges/…' }：店家有授權才填，確認過的職人獎章改用店徽
};

// 活動任務裡「指到某家店」的條件欄位（同 challenges.js 里程碑 countBy:'shop'）
const BADGE_SHOP_FIELDS = ['shopId', 'scanShop', 'quest'];

// 門檻整理：轉數字、去掉非正數與重複、由小到大；超過級數的截掉
function _badgeThresholds(arr, maxTiers) {
  const nums = (Array.isArray(arr) ? arr : []).map(Number).filter(n => Number.isFinite(n) && n > 0);
  return [...new Set(nums)].sort((a, b) => a - b).slice(0, maxTiers);
}

function _badgeNames(arr) {
  return Array.isArray(arr) ? arr.map(s => (s == null ? '' : String(s))) : [];
}

// Firestore 設定＋預設值合併：缺的欄位用預設；門檻不合格的獎章直接略過
function badgeMergeConfig(remote) {
  const r = (remote && typeof remote === 'object') ? remote : {};
  const D = BADGE_DEFAULT_CONFIG;
  const tiers = (Array.isArray(r.tiers) && r.tiers.length ? r.tiers : D.tiers).map((t, i) => {
    const d = D.tiers[i] || {};
    const pts = Number(t && t.points);
    return {
      key: String((t && t.key) || d.key || 'tier' + (i + 1)),
      name: String((t && t.name) || d.name || ''),
      points: Number.isFinite(pts) ? pts : (d.points || 0),
    };
  });
  const mult = Number(r.activityMultiplier);
  const badges = (Array.isArray(r.badges) ? r.badges : D.badges)
    .filter(b => b && b.id && b.source)
    .map(b => ({ ...b, id: String(b.id), name: String(b.name || b.id),
                 thresholds: _badgeThresholds(b.thresholds, tiers.length), tierNames: _badgeNames(b.tierNames) }))
    .filter(b => b.thresholds.length);
  return {
    tiers,
    activityMultiplier: Number.isFinite(mult) && mult > 0 ? mult : D.activityMultiplier,
    badges,
    shopLogos: (r.shopLogos && typeof r.shopLogos === 'object') ? { ...r.shopLogos } : {},
  };
}

// 活動的獎章設定（challenges/{cid}.badge）；沒有這個欄位＝預設：開啟、門檻 [1]、圖用活動封面。
// countBy 沒填時跟著活動的里程碑（milestone.countBy），獎章數字才會和任務頁的進度一致
function badgeChallengeConfig(ch, cfg) {
  const b = (ch && ch.badge && typeof ch.badge === 'object') ? ch.badge : {};
  if (b.enabled === false) return null;
  const ms = (ch && ch.milestone) || {};
  const thresholds = _badgeThresholds(b.thresholds, cfg.tiers.length);
  return {
    image: String(b.image || (ch && ch.image) || ''),
    countBy: (b.countBy || ms.countBy || (ch && ch.goalCountBy)) === 'shop' ? 'shop' : 'task',
    thresholds: thresholds.length ? thresholds : [1],
    tierNames: _badgeNames(b.tierNames),
  };
}

// 店家篩選（設定裡的 filter，例 { 縣市:'臺北市' }、{ 派系:['豚骨','雞白湯'] }）：
// data.json 的派系／醬底／類型是「豚骨, 雞清湯」這種逗號字串，拆開後任一個符合就算；查不到店＝不符合
function _badgeShopMatch(shop, filter) {
  const keys = filter && typeof filter === 'object' ? Object.keys(filter) : [];
  if (!keys.length) return true;
  if (!shop) return false;
  return keys.every(k => {
    const want = (Array.isArray(filter[k]) ? filter[k] : [filter[k]]).map(String);
    const have = String(shop[k] == null ? '' : shop[k]).split(/\s*[,，、]\s*/).filter(Boolean);
    return want.some(w => have.includes(w));
  });
}

function _badgeTier(value, thresholds) {
  return thresholds.filter(t => value >= t).length;
}

// 點數累加：拿到金級＝銅＋銀＋金；活動類再乘倍數
function _badgePoints(tier, cfg, activity) {
  let p = 0;
  for (let i = 0; i < tier && i < cfg.tiers.length; i++) p += cfg.tiers[i].points;
  return activity ? p * cfg.activityMultiplier : p;
}

// 主計算。input：
//   config     badgeMergeConfig() 的結果
//   stamps     userVisits.visits｛shopId: 值｝
//   shopOf     shopId → data.json 那一列（含歇業店）；查不到回 null
//   challenges status 為 active／ended 的活動（含 groups、milestone、badge）
//   progress   ｛cid: { completedTaskIds }｝已聯集 userChallengeProgress／challengeCheckins／questCheckins
//   pending    ｛cid: true｝有投稿在審核中（選填，前台顯示「審核中」用）
//   reviews, menus  評論篇數、菜單張數
//   crafts     ｛shopId: 'confirmed'|'rejected'｝職人確認結果
// 回傳 { list, points, level, stats }；list 每一筆是一枚獎章（含還沒拿到的，tier 0）
function badgeCompute(input) {
  const cfg      = input.config || badgeMergeConfig(null);
  const stamps   = input.stamps || {};
  const shopOf   = typeof input.shopOf === 'function' ? input.shopOf : () => null;
  const progress = input.progress || {};
  const pending  = input.pending || {};
  const crafts   = input.crafts || {};

  // 踩點：值 ≥1 才算（1＝吃過、2–10＝吃過 N 次、20＝從業過；0／0.2 是舊資料＝沒踩點），同 conqueredCount
  const stampIds = Object.keys(stamps).filter(id => Number(stamps[id]) >= 1);
  const workIds  = stampIds.filter(id => Number(stamps[id]) === 20);
  const cityOf   = id => { const s = shopOf(id); return s ? String(s['縣市'] || '') : ''; };
  const citiesOf = ids => new Set(ids.map(cityOf).filter(Boolean)).size;

  // 每檔活動一枚（badge.enabled === false 的活動不算，也不計入活動常客）
  const events = [];
  (input.challenges || []).forEach(ch => {
    if (!ch || !ch.id) return;
    const bc = badgeChallengeConfig(ch, cfg);
    if (!bc) return;
    const completed = (progress[ch.id] && progress[ch.id].completedTaskIds) || [];
    const doneSet = new Set(completed);
    const done = (ch.groups || []).flatMap(g => (g && g.tasks) || []).filter(t => t && doneSet.has(t.id));
    const shopOfTask = t => (t.condition && BADGE_SHOP_FIELDS.includes(t.condition.field)) ? t.condition.value : null;
    const value = bc.countBy === 'shop' ? new Set(done.map(shopOfTask).filter(Boolean)).size : done.length;
    const tier = _badgeTier(value, bc.thresholds);
    events.push({
      key: 'ch:' + ch.id, kind: 'event', cid: ch.id,
      name: String(ch.title || ch.id), icon: '🚩', image: bc.image, text: '',
      unit: bc.countBy === 'shop' ? '間' : '項', countBy: bc.countBy,
      value, thresholds: bc.thresholds, tierNames: bc.tierNames, tier,
      activity: true, points: _badgePoints(tier, cfg, true),
      status: ch.status === 'ended' ? 'ended' : 'active',
      period: ch.period || null,
      participated: done.length > 0,
      pending: tier === 0 && !!pending[ch.id],
      hidden: ch.reveal === 'discover' && completed.length === 0,   // 隱藏彩蛋：沒進度的人看不到（同任務頁）
    });
  });
  const eventsJoined = events.filter(e => e.participated).length;

  // 常設獎章（設定檔 badges）
  const fixed = [];
  cfg.badges.forEach(def => {
    const pick = def.filter ? stampIds.filter(id => _badgeShopMatch(shopOf(id), def.filter)) : stampIds;
    let value;
    switch (def.source) {
      case 'stamps':    value = pick.length; break;
      case 'cities':    value = citiesOf(pick); break;
      case 'events':    value = eventsJoined; break;
      case 'menus':     value = Number(input.menus) || 0; break;
      case 'reviews':   value = Number(input.reviews) || 0; break;
      case 'craftsman': value = workIds.length; break;
      default: return;   // 不認得的來源（打錯字、或新來源還沒寫程式）→ 不顯示
    }
    const tier = _badgeTier(value, def.thresholds);
    const activity = !!def.activity;
    fixed.push({
      key: def.id, kind: 'fixed', source: def.source,
      name: def.name, icon: def.icon || '🏅', image: def.image || '', text: '',
      unit: def.unit || '',
      value, thresholds: def.thresholds, tierNames: def.tierNames, tier,
      activity, points: _badgePoints(tier, cfg, activity),
      shops: def.source === 'craftsman' ? workIds.slice() : null,   // 本人勾的「從業過」店家（只給本人看）
      hideUntilEarned: def.source === 'craftsman',                  // 職人拿到才出現，不列灰色 0/1
    });
    // 職人：admin 確認過、而且現在仍勾「從業過」的店，每家一枚「曾於〇〇服務」
    if (def.source === 'craftsman') {
      workIds.filter(id => crafts[id] === 'confirmed').forEach(id => {
        const s = shopOf(id);
        const shopName = String((s && s['店名']) || id);
        fixed.push({
          key: 'craft:' + id, kind: 'craft', source: 'craftsman', shopId: id,
          name: '曾於' + shopName + '服務', icon: '', image: String(cfg.shopLogos[id] || ''), text: shopName,
          unit: '', value: 1, thresholds: [1], tierNames: [], tier: 1,
          activity: false, points: _badgePoints(1, cfg, false),
        });
      });
    }
  });

  const list = events.concat(fixed);
  const points = list.reduce((sum, b) => sum + b.points, 0);
  return {
    list,
    points,
    level: points,   // 會員 Lv＝點數總和，沒有上限
    stats: { events: eventsJoined, stamps: stampIds.length, cities: citiesOf(stampIds) },
  };
}

// 稀有度名稱（銅、銀…）；0 級回傳空字串
function badgeTierName(cfg, tier) {
  return (tier > 0 && cfg.tiers[tier - 1]) ? cfg.tiers[tier - 1].name : '';
}

// 稱號／慶祝視窗用的完整名稱：該級有另外取名就用級名；只有一級的獎章直接用獎章名；其餘「獎章名・稀有度」
function badgeTitleText(b, tier, cfg) {
  if (!b || tier < 1) return '';
  const custom = (b.tierNames || [])[tier - 1];
  if (custom) return custom;
  if (b.thresholds.length === 1) return b.name;
  return b.name + '・' + badgeTierName(cfg, tier);
}

// 精選自動挑選：稀有度高的優先，同級時活動獎章優先，其餘照清單順序
function badgeAutoFeatured(list, n) {
  return list
    .map((b, i) => ({ b, i }))
    .filter(x => x.b.tier > 0 && !x.b.hidden)
    .sort((x, y) => (y.b.tier - x.b.tier) || ((y.b.activity ? 1 : 0) - (x.b.activity ? 1 : 0)) || (x.i - y.i))
    .slice(0, n || 6)
    .map(x => x.b);
}

// 慶祝視窗用：跟「已跳過」紀錄（users.badgeSeen｛key: 級數｝）比，找出級數比紀錄高的獎章（含升級）。
// 隱藏的彩蛋活動、沒拿到的不算；紀錄只增不減，門檻調高掉級、之後升回原級不會再跳。
// 回傳 { items: [{ b, from }]（清單順序；from＝紀錄裡的級數）, seen: 更新後的紀錄 }
function badgeNewSince(list, seen) {
  const prev = (seen && typeof seen === 'object') ? seen : {};
  const next = { ...prev };
  const items = [];
  (list || []).forEach(b => {
    if (!b || b.hidden || !(b.tier > 0)) return;
    const from = Number(prev[b.key]) || 0;
    if (b.tier > from) { items.push({ b, from }); next[b.key] = b.tier; }
  });
  return { items, seen: next };
}

// 某枚獎章在指定級數時的點數（慶祝視窗算 Lv 從多少升上來）
function badgePointsAt(b, tier, cfg) {
  return _badgePoints(Math.max(0, tier | 0), cfg, !!(b && b.activity));
}
