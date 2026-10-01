// 地形烘焙：棋盤 → 1 px = 1 格的畫布，當 3D 地面的貼圖。
//
// COLOR 與 hash32 必須與 lab/game-world/index.html 完全相同——同一張棋盤
// 在 2D、3D 看起來才會一致。test/ 會從 2D 頁取出它的 COLOR、hash32 逐值比對，
// 任何一邊改了都會亮紅燈。

export const COLOR = {
  outside:     [ 26, 28, 33, 255],
  land:        [222,216,200, 255],
  water:       [ 74,144,196, 255],
  bridge:      [150,105, 62, 255],
  road:        [120,110, 96, 255],
  road_bridge: [162,116, 70, 255],
  shop:        [214, 69, 65, 255],
  shop_coop:   [232,176, 58, 255],
};

export function hash32(n) {
  n = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  n ^= n >>> 13;
  n = Math.imul(n, 0xc2b2ae35);
  return (n ^ (n >>> 16)) >>> 0;
}

const clamp = v => v < 0 ? 0 : v > 255 ? 255 : v;

// 每格加一點依座標決定的明暗抖動——純色會讀成「一片地形」，有抖動才讀得出「一格一格」。
export function bakeTerrainCanvas(board) {
  const { W, H, terrain, terrainKeys } = board;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let i = 0; i < W * H; i++) {
    const key = terrainKeys[terrain[i]];
    const c = COLOR[key] || COLOR.outside;
    const n = key === 'outside' ? 0 : (hash32(i) % 11) - 5;
    d[i * 4]     = clamp(c[0] + n);
    d[i * 4 + 1] = clamp(c[1] + n);
    d[i * 4 + 2] = clamp(c[2] + n);
    d[i * 4 + 3] = c[3];
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// 貼圖超過 GPU 上限時等比縮小（手機常見 4096）。回傳 { canvas, scale }。
export function fitTexture(canvas, maxSize) {
  const s = Math.min(1, maxSize / Math.max(canvas.width, canvas.height));
  if (s === 1) return { canvas, scale: 1 };
  const out = document.createElement('canvas');
  out.width = Math.floor(canvas.width * s);
  out.height = Math.floor(canvas.height * s);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return { canvas: out, scale: s };
}
