// 拉麵養成世界 3D — Phase 1 骨架：同一份棋盤畫成可旋轉的 3D 地面＋店家標記。
//
// 座標：1 單位 = 1 公尺；原點在棋盤西北角，x 向東、z 向南——與格子 (cx, cy) 同向，
// 格子中心 = ((cx + 0.5) × cellSize, 0, (cy + 0.5) × cellSize)。
//
// 參數：?board=<id>  ?view=overview|oblique|top  ?cam=tx,tz,dist,az,polar（度）
//       ?debug（顯示 FPS／draw calls）  ?test（關掉阻尼、開放 window.__GW3D__ 給 test/ 用）

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadBoard, boardIdFrom } from './board.js';
import { COLOR, bakeTerrainCanvas, fitTexture } from './terrain.js';

const Q = new URLSearchParams(location.search);
const BOARD_ID = boardIdFrom(location.search);
const TEST = Q.has('test');
const DEBUG = Q.has('debug') || TEST;
const BG = 0x16181d;                       // 與 2D 版背景同色

// ── 測試掛勾：錯誤一律收進 __GW3D__.errors，test/ 看得到 ─────────────────────
const errors = [];
const gw = window.__GW3D__ = { errors, frames: 0 };
window.addEventListener('error', e => errors.push(String(e.message || e.error)));
window.addEventListener('unhandledrejection', e =>
  errors.push('unhandled: ' + ((e.reason && e.reason.message) || e.reason)));
if (TEST) {
  const ce = console.error.bind(console);
  console.error = (...a) => { errors.push(a.map(String).join(' ')); ce(...a); };
}

const $ = id => document.getElementById(id);
const deg = THREE.MathUtils.degToRad;
const rgb = c => new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);

// ── 場景 ───────────────────────────────────────────────────────────────────
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(BG);
scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3a3a, 2.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(-0.6, 1, 0.4);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(45, 1, 2, 80000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = !TEST;            // 測試要可重現：不要慣性
controls.dampingFactor = 0.08;
controls.screenSpacePanning = false;       // 平移貼著地面走，不會飄上天
controls.zoomToCursor = true;              // 往游標處縮放，像地圖
controls.maxPolarAngle = deg(85);          // 不能鑽到地面底下

let board, Wm, Hm, diag, ground, stem, head, texInfo;
let markerK = 0;

// ── 視角：全部從棋盤尺寸算，換棋盤不用改 ────────────────────────────────────
const VIEWS = {
  overview: () => ({ tx: Wm / 2, tz: Hm / 2, dist: diag * 0.95, az: 0,  polar: 50 }),
  oblique:  () => ({ tx: Wm / 2, tz: Hm / 2, dist: diag * 0.55, az: 35, polar: 68 }),
  top:      () => ({ tx: Wm / 2, tz: Hm / 2, dist: diag * 1.05, az: 0,  polar: 0.5 }),
};

// az = 0 時相機在目標正南方往北看（北在畫面上方），az 為正往東轉。
function applyView(v) {
  controls.target.set(v.tx, 0, v.tz);
  const p = deg(v.polar), a = deg(v.az);
  camera.position.set(
    v.tx + v.dist * Math.sin(p) * Math.sin(a),
    v.dist * Math.cos(p),
    v.tz + v.dist * Math.sin(p) * Math.cos(a));
  camera.lookAt(controls.target);
  controls.update();
  updateMarkerScale(true);
}

function viewFromQuery() {
  const cam = (Q.get('cam') || '').split(',').map(Number);
  if (cam.length === 5 && cam.every(Number.isFinite)) {
    const [tx, tz, dist, az, polar] = cam;
    return { tx, tz, dist, az, polar };
  }
  return (VIEWS[Q.get('view')] || VIEWS.overview)();
}

// ── 地面：棋盤烘成貼圖，鋪在 Wm × Hm 公尺的平面上 ───────────────────────────
function buildGround() {
  const raw = bakeTerrainCanvas(board);
  const { canvas: tc, scale } = fitTexture(raw, renderer.capabilities.maxTextureSize);
  const tex = new THREE.CanvasTexture(tc);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;               // 拉近看得到一格一格
  tex.minFilter = THREE.LinearMipmapLinearFilter;    // 拉遠不閃爍
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const geo = new THREE.PlaneGeometry(Wm, Hm);
  geo.rotateX(-Math.PI / 2);                         // 平面頂邊 → 北（z = 0）
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex }));
  mesh.position.set(Wm / 2, 0, Hm / 2);
  scene.add(mesh);
  texInfo = { w: tc.width, h: tc.height, scale };
  return mesh;
}

// ── 店家標記：一根柱子＋一顆球，兩個 InstancedMesh 各一次 draw call ───────────
function buildMarkers() {
  const n = board.shops.length;
  const stemGeo = new THREE.CylinderGeometry(3, 3, 30, 10).translate(0, 15, 0);
  const headGeo = new THREE.SphereGeometry(7, 16, 12).translate(0, 37, 0);
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  stem = new THREE.InstancedMesh(stemGeo, mat, n);
  head = new THREE.InstancedMesh(headGeo, mat, n);
  const red = rgb(COLOR.shop), amber = rgb(COLOR.shop_coop);
  board.shops.forEach((s, i) => {
    const c = s.coop ? amber : red;
    stem.setColorAt(i, c);
    head.setColorAt(i, c);
  });
  stem.frustumCulled = head.frustumCulled = false;   // 只有兩個物件，省掉包圍球的維護
  scene.add(stem, head);
}

// 拉遠時標記等比放大，俯瞰全區仍看得到；拉近時回到真實大小（柱高約 30 m）。
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
function updateMarkerScale(force) {
  if (!head) return;
  const k = THREE.MathUtils.clamp(camera.position.distanceTo(controls.target) / 700, 1, 14);
  if (!force && Math.abs(k - markerK) / markerK < 0.02) return;
  markerK = k;
  _s.set(k, k, k);
  board.shops.forEach((s, i) => {
    _p.set((s.cx + 0.5) * board.cell, 0, (s.cy + 0.5) * board.cell);
    _m.compose(_p, _q, _s);
    stem.setMatrixAt(i, _m);
    head.setMatrixAt(i, _m);
  });
  stem.instanceMatrix.needsUpdate = head.instanceMatrix.needsUpdate = true;
  stem.computeBoundingSphere();
  head.computeBoundingSphere();
}

// 平移不能把目標拖出棋盤
function clampTarget() {
  const t = controls.target;
  const x = THREE.MathUtils.clamp(t.x, 0, Wm), z = THREE.MathUtils.clamp(t.z, 0, Hm);
  if (x !== t.x || z !== t.z) {
    camera.position.x += x - t.x;
    camera.position.z += z - t.z;
    t.x = x; t.z = z;
  }
}

// ── 指向店家：滑過顯示店名，點一下把視角移過去 ────────────────────────────────
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let pointer = null, downAt = null, focusAnim = null;

function pickShop(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects([head, stem], false)[0];
  return hit ? board.shops[hit.instanceId] : null;
}

canvas.addEventListener('pointermove', e => { pointer = e; });
canvas.addEventListener('pointerleave', () => { pointer = null; $('tip').hidden = true; });
canvas.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', e => {
  if (!downAt || !board) return;
  const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
  downAt = null;
  if (moved > 5) return;                    // 拖曳不算點擊
  const s = pickShop(e.clientX, e.clientY);
  if (s) focusShop(s);
});

function focusShop(s) {
  const to = new THREE.Vector3((s.cx + 0.5) * board.cell, 0, (s.cy + 0.5) * board.cell);
  const from = controls.target.clone();
  const offset = camera.position.clone().sub(from);
  const want = Math.min(offset.length(), 900);
  offset.setLength(want);
  focusAnim = { from, to, offFrom: camera.position.clone().sub(from), offTo: offset, t0: performance.now() };
}

function stepFocus(now) {
  if (!focusAnim) return;
  const u = Math.min(1, (now - focusAnim.t0) / 450);
  const e = u * u * (3 - 2 * u);
  controls.target.lerpVectors(focusAnim.from, focusAnim.to, e);
  camera.position.copy(controls.target).add(focusAnim.offFrom.clone().lerp(focusAnim.offTo, e));
  if (u === 1) focusAnim = null;
}

function updateTip() {
  if (!pointer || !head) return;
  const s = pickShop(pointer.clientX, pointer.clientY);
  const tip = $('tip');
  if (!s) { tip.hidden = true; canvas.style.cursor = ''; return; }
  tip.textContent = s.name + (s.coop ? '（合作店家）' : '');
  tip.style.left = pointer.clientX + 14 + 'px';
  tip.style.top = pointer.clientY + 14 + 'px';
  tip.hidden = false;
  canvas.style.cursor = 'pointer';
}

// ── 尺寸、迴圈、HUD ───────────────────────────────────────────────────────────
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);

let fpsT = performance.now(), fpsN = 0, fps = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (!board) return;
  stepFocus(now);
  controls.update();
  updateTip();
  renderer.render(scene, camera);
  gw.frames++;
  fpsN++;
  if (now - fpsT >= 1000) {
    fps = Math.round((fpsN * 1000) / (now - fpsT));
    fpsN = 0; fpsT = now;
    if (DEBUG) updateDebug();
  }
}

function stats() {
  renderer.render(scene, camera);
  const info = renderer.info.render;
  return {
    board: board.id, W: board.W, H: board.H, cell: board.cell,
    shops: board.shops.length, markers: head ? head.count : 0,
    texW: texInfo.w, texH: texInfo.h, texScale: texInfo.scale,
    maxTextureSize: renderer.capabilities.maxTextureSize,
    drawCalls: info.calls, triangles: info.triangles, fps,
    errors: errors.length,
  };
}

function updateDebug() {
  const s = stats();
  $('debug').textContent =
    `${s.fps} fps · ${s.drawCalls} draw calls · ${s.triangles.toLocaleString()} 三角形 · ` +
    `貼圖 ${s.texW}×${s.texH}${s.texScale < 1 ? `（縮 ${s.texScale.toFixed(2)}）` : ''}`;
}

function fillHud() {
  const p = board.props;
  $('title').textContent = (p.county || '') + (p.town || '') || board.id;
  $('meta').textContent =
    `${board.shops.length} 間店 · ${board.cell} m/格 · ${board.W}×${board.H} 格（${(Wm / 1000).toFixed(1)}×${(Hm / 1000).toFixed(1)} km）`;
  $('to2d').href = `../game-world/index.html?board=${encodeURIComponent(board.id)}`;
  $('debug').hidden = !DEBUG;
  for (const b of document.querySelectorAll('[data-view]')) {
    b.addEventListener('click', () => applyView(VIEWS[b.dataset.view]()));
  }
}

function showErr(msg) {
  $('err').hidden = false;
  $('errDetail').textContent = msg;
}

// ── 啟動 ───────────────────────────────────────────────────────────────────
gw.ready = (async () => {
  board = await loadBoard(BOARD_ID);
  gw.board = board;
  Wm = board.W * board.cell;
  Hm = board.H * board.cell;
  diag = Math.hypot(Wm, Hm);
  controls.minDistance = 25;
  controls.maxDistance = diag * 2;
  camera.far = diag * 5;
  ground = buildGround();
  buildMarkers();
  resize();
  applyView(viewFromQuery());
  controls.addEventListener('change', () => { clampTarget(); updateMarkerScale(false); });
  fillHud();
  requestAnimationFrame(frame);
  return stats();
})();
gw.ready.catch(e => { errors.push(String(e.message || e)); showErr(String(e.message || e)); });

gw.stats = stats;
gw.setView = name => applyView(VIEWS[name]());
gw.setCam = (tx, tz, dist, az, polar) => applyView({ tx, tz, dist, az, polar });
// 在同一個 task 內 render 再讀，不需要 preserveDrawingBuffer
gw.snapshot = () => { renderer.render(scene, camera); return canvas.toDataURL('image/png'); };
gw.probe = (fx = 0.5, fy = 0.5) => {
  renderer.render(scene, camera);
  const gl = renderer.getContext(), px = new Uint8Array(4);
  gl.readPixels(Math.floor(gl.drawingBufferWidth * fx), Math.floor(gl.drawingBufferHeight * (1 - fy)),
    1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return Array.from(px);
};
