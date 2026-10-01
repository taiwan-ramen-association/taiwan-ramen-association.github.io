// 棋盤讀取：與 lab/game-world/index.html 的 loadBoard() 同一套規則。
// 地形種類與通行性都從 tileset 的 tile property 讀，不寫死索引——
// 在 Tiled 把一格從「水域」改成「橋樑」，2D、3D 兩邊跟著變，只有一份真相。
//
// 這個模組不依賴 three.js：test/ 直接拿它驗證解碼結果與 Python（regress.py）一致。

export const DEFAULT_BOARD = 'tpe-zhongshan-3m';

// 過濾掉非 [a-z0-9-] 的字元，免得 ?board=../../ 之類的路徑跑出 data/boards 之外。
export function boardIdFrom(search, fallback = DEFAULT_BOARD) {
  return (new URLSearchParams(search).get('board') || fallback).replace(/[^a-z0-9-]/gi, '');
}

// 以本模組的位置為基準（不是頁面位置）：index.html、test/ 都 import 這支，
// fetch 的相對路徑會依「頁面」解析，test/ 多一層就會指錯。
const BOARDS_BASE = new URL('../../../data/boards/', import.meta.url).href;

export function boardUrl(id, base = BOARDS_BASE) {
  return `${base}${id}.json`;
}

// Tiled 的 base64 + zlib/gzip 圖層 → 每格一個 gid（little-endian uint32）
async function decodeLayer(layer) {
  if (Array.isArray(layer.data)) return Uint32Array.from(layer.data);
  const bin = atob(layer.data);
  let bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const comp = layer.compression || '';
  if (comp) {
    // zlib（RFC 1950）對應 'deflate'；'deflate-raw' 是不帶 header 的那種
    const fmt = comp === 'zlib' ? 'deflate' : comp === 'gzip' ? 'gzip' : null;
    if (!fmt) throw new Error('不支援的 compression: ' + comp);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(fmt));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
}

const propsOf = list => Object.fromEntries((list || []).map(p => [p.name, p.value]));

export async function loadBoard(id, { base } = {}) {
  const res = await fetch(boardUrl(id, base));
  if (!res.ok) throw new Error(`HTTP ${res.status}：找不到棋盤 ${id}`);
  const map = await res.json();

  const W = map.width, H = map.height;
  const props = propsOf(map.properties);
  const cell = props.cellSize || 25;

  const ts = map.tilesets[0], first = ts.firstgid;
  const terrainKeys = [], passableByTile = [];
  for (const t of ts.tiles) {
    const p = propsOf(t.properties);
    terrainKeys[t.id] = p.terrain;
    passableByTile[t.id] = !!p.passable;
  }

  const data = await decodeLayer(map.layers.find(l => l.name === 'terrain'));
  if (data.length !== W * H) throw new Error(`地形格數 ${data.length} ≠ ${W}×${H}`);
  const terrain = new Uint8Array(W * H);
  const passable = new Uint8Array(W * H);
  for (let i = 0; i < data.length; i++) {
    const tid = data[i] - first;
    terrain[i] = tid;
    passable[i] = passableByTile[tid] ? 1 : 0;
  }

  const coopTile = terrainKeys.indexOf('shop_coop');
  const shops = map.layers.find(l => l.name === 'shops').objects.map(o => {
    const p = propsOf(o.properties);
    return {
      id: p.shopId, name: o.name, cx: p.cx, cy: p.cy, lat: p.lat, lng: p.lng,
      coop: terrain[p.cy * W + p.cx] === coopTile,
    };
  });

  return { id, W, H, cell, props, terrainKeys, terrain, passable, shops };
}

// 各地形格數（test/ 拿來與 regress.py 的 fixtures 比對）
export function terrainCounts(board) {
  const n = new Array(board.terrainKeys.length).fill(0);
  for (let i = 0; i < board.terrain.length; i++) n[board.terrain[i]]++;
  return Object.fromEntries(board.terrainKeys.map((k, i) => [k, n[i]]).filter(([, v]) => v > 0));
}
