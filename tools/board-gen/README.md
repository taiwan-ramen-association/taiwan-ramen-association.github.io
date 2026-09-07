# board-gen — 拉麵養成世界的棋盤生成器

由「行政區界 + 水域/橋樑 + 店家座標」產生 Tiled 格式的遊戲棋盤。

```
data.json (lat/lng)  ┐
行政區 polygon        ├─→ gen_board.py ─→ Tiled JSON ─→ 人工潤飾 ─→ 網頁讀取
水域 / 橋樑 geojson   ┘                                  (Tiled)
```

零外部依賴，只用 Python 標準函式庫（Python 3.8+）。

---

## 為什麼是這個設計

**棋盤形狀＝真實行政區 polygon 裁切，不是矩形也不是抽象棋盤。**
玩家因此會實際感受到地理事實——例如中山區被基隆河切成兩半，要去大直的
「麵屋技庵」「勝拉麵」必須繞大直橋，直線 4.2 km 走起來更遠。

**水域不可通行、橋可通行，A\* 自己會繞。**
不需要任何「過橋」的特例邏輯，繞路後變長的距離是算出來的，不是硬填的。

**輸出 Tiled 而不是自訂格式。**
生成腳本算出來的通行性一定會有錯（圖資不完整、橋沒標到、巷子被切斷）。
用 Tiled 當格式，這些錯可以用滑鼠改掉；要埋彩蛋、放寶箱也只是點一點。
「程式生成」與「人工潤飾」不必二選一。

---

## 檔案

| 檔案 | 用途 |
|---|---|
| `config.json` | **冷參數**：格子邊長、margin、要生成哪些區 |
| `fetch_boundary.py` | 下載鄉鎮市區界（與 `domination.html` 同一份資料源） |
| `fetch_water.py` | 從 OpenStreetMap 抓水域與橋樑 ⚠️ 需外網 |
| `gen_board.py` | 主生成腳本 |
| `preview.py` | 把棋盤畫成 PNG（沒裝 Tiled 也能檢查） |
| `geo.py` | 投影、掃描線填色、Bresenham、連通性 |
| `tiled.py` | Tiled JSON 與佔位 tileset PNG 的輸出 |
| `cache/` | 下載到的圖資（`twtown2010.json` 不進版控，水域圖層要進） |

---

## 用法

```bash
cd tools/board-gen

# 1. 抓行政區界（第一次執行才需要，之後走快取）
python fetch_boundary.py

# 2. 抓水域與橋樑 —— 需要能連 overpass-api.de
python fetch_water.py tpe-zhongshan

# 3. 產生棋盤
python gen_board.py tpe-zhongshan

# 4. 看結果（不用裝 Tiled）
python preview.py tpe-zhongshan 2
```

產出：

```
data/boards/tpe-zhongshan.json          Tiled 地圖（用 Tiled 打開）
data/boards/tiles-placeholder.png       佔位 tileset
data/boards/tpe-zhongshan-preview.png   一格一像素的預覽圖
```

### ⚠️ fetch_water.py 要在自己的機器上跑

Claude Code 的雲端執行環境對外連線受政策限制，`overpass-api.de`、
`nominatim.openstreetmap.org`、`cdn.jsdelivr.net` 都被擋（`raw.githubusercontent.com` 可通）。
所以水域圖層請在本機抓一次，`cache/water-*.geojson` 進版控，
之後 `gen_board.py` 就完全不需要網路。

沒有水域圖層時棋盤仍會生成，但**河與橋不會出現**，A\* 會直接穿越水面——
`hasWaterLayer: false` 會寫在地圖屬性裡，別把這種棋盤當成品。

---

## 在 Tiled 裡怎麼改

開啟 `data/boards/*.json`，會看到兩層：

- **terrain**（tile layer）：地形。用鉛筆工具改格子即可。
- **shops**（object layer）：店家位置，每個物件帶 `shopId` / `lat` / `lng` / `moved`。

**通行性放在 tileset 的 tile property，不是另外一層。**
在 Tiled 裡把一格從「水域」改成「橋樑」，`passable` 就跟著變成 true，
不會出現「畫面看起來是橋、資料還說是水」的兩份真相。

地形種類（順序即 tileset 內的排列）：

| # | 種類 | 佔位色 | 可通行 |
|---|---|---|---|
| 1 | 區外 | 深灰 | ✗ |
| 2 | 陸地 | 米白 | ✓ |
| 3 | 水域 | 藍 | ✗ |
| 4 | 橋樑 | 棕 | ✓ |
| 5 | 店家 | 紅 | ✓ |
| 6 | 合作店家 | 金 | ✓ |

換成正式素材時，只要新 tileset 的格數與順序一致，地圖檔不用重生。

---

## 生成時會自動檢查的事

1. **座標離群**：離該區店家中位數超過 8 km 的店家會被排除並列出。
   （`data.json` 目前已知有 7 筆錯誤座標，未修的話會讓左營區版圖從 3 km 膨脹到 175 km。）
2. **落點碰撞**：兩間店落在同一格時往鄰近空格擠開，並在 `moved` 屬性標記。
   中山區 25 m 格下只有 1 例（鬼金棒 中山別館）。
3. **連通性**：從最大的連通區塊做 flood fill，列出走不到的店家。
   這種錯必須在生成階段發現——不能等玩家卡在對岸才知道橋沒標到。

---

## 中山區實測（2026-09-07，尚未載入水域圖層）

```
店家 40 間（非歇業）
版圖 5,960 m x 6,115 m → 239 x 245 = 58,555 格（25 m/格）
地形：區外 36,085、陸地 22,430、店家 40
落點：40 間，擠開 1 間
連通性：40/40 間互相走得到
輸出：135 KB
```

陸地 22,430 格 × 625 m² = 14.0 km²，對照行政區實際面積 13.87 km²，
誤差 1%，符合 25 m 格的量化精度。

接上水域圖層後，大直的兩間店應該只能經由大直橋抵達——**那是驗收這條路走不走得通的關鍵畫面。**
