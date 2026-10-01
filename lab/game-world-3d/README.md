# lab/game-world-3d — 拉麵養成世界 3D

同一份棋盤（`data/boards/*.json`，Tiled 格式）的 3D 版本，可以旋轉、俯仰、縮放。
2D 版 `lab/game-world/` 不動，兩邊讀同一份棋盤、同一套地形規則。

## 開啟

在 repo 根目錄（game-world worktree：`D:\taiwan-ramen-game-world`）起本機伺服器：

```
python -m http.server 8000 --bind 127.0.0.1
```

- 3D：<http://127.0.0.1:8000/lab/game-world-3d/?board=tpe-daan-3m>
- 參數：`?board=<id>`、`?view=overview|oblique|top`、`?cam=tx,tz,dist,az,polar`（公尺／度）、`?debug`（FPS、draw calls）
- 操作：左鍵拖曳旋轉 · 右鍵平移 · 滾輪縮放（往游標處）· 點店家標記把視角移過去

## 座標

1 單位 = 1 公尺；原點在棋盤西北角，x 向東、z 向南——與格子 `(cx, cy)` 同向。
格子中心 = `((cx + 0.5) × cellSize, 0, (cy + 0.5) × cellSize)`。

## 檔案

| 檔案 | 用途 |
|---|---|
| `index.html` | 頁面、HUD、importmap（three 指向 `vendor/`，執行時不連任何 CDN） |
| `js/board.js` | 讀棋盤、解碼地形（不依賴 three.js，與 2D 同一套規則） |
| `js/terrain.js` | 地形配色與烘焙；`COLOR`／`hash32` 必須與 2D 版相同 |
| `js/app.js` | 場景、相機、OrbitControls、店家標記、測試掛勾 `window.__GW3D__` |
| `vendor/three/` | three.js r186.1（npm 官方套件，SHA-512 驗證過，見 `VERSION.md`） |
| `test/` | 回歸測試（下節） |

## 回歸測試（每個 phase 改完都跑）

```
python tools/board-gen/regress.py --fixtures lab/game-world-3d/test/fixtures.json
python lab/game-world-3d/test/run.py
```

1. `regress.py`：棋盤資料七項檢查（狀態／落點／行政區／地形／門口／連通／預覽），
   並輸出 Python 解碼的摘要當標準答案（`test/fixtures.json`）。
2. `run.py`：本機伺服器（只綁 127.0.0.1）＋ headless Edge（暫時設定檔、關背景網路、
   WebGL 走 SwiftShader）跑 `test/index.html?auto=1`，每張棋盤檢查：
   - **解碼一致**：JS 解出的尺寸、店家、各地形格數 = Python 的標準答案
   - **3D 繪製**：零錯誤、標記數 = 店數、畫面取樣看得到棋盤、貼圖沒被縮小
   - **2D 冒煙**：2D 頁仍載得起來
   - **配色一致**：從 2D 頁取出 `COLOR`、`hash32` 與 3D 逐值比對
   - 另存固定視角截圖到 `test/out/`（不進版控）

任一 FAIL → exit 1。兩支都做過反向驗證（餵壞資料確認會亮紅燈）。
也可以直接用瀏覽器開 `test/` 看結果表。

## 分階段

| Phase | 內容 | 狀態 |
|---|---|---|
| 0 | 棋盤只收營業中、`regress.py` | ✅ |
| 1 | 3D 骨架：地面貼圖、店家標記、旋轉縮放、測試框架 | ✅ |
| 2 | OSM 建築資料（`fetch_buildings.py`），Tiled 棋盤不動 | ⬜ |
| 3 | 建築擠出、分塊載入、地標視角、效能預算 | ⬜ |
| 4 | 玩法移植（A* 與 verify.py 一致、移動、事件、存檔） | ⬜ |
| 5 | 手機觸控、畫質、遠景簡化、不支援 WebGL 導回 2D | ⬜ |

地圖資料 © OpenStreetMap contributors（ODbL）。
