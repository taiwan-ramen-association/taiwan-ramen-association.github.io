#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""gen_board.py — 由行政區界 + 水域 + 店家座標產生 Tiled 棋盤。

流程：
    data.json (lat/lng)  ┐
    行政區 polygon        ├─→ 格子化 → 通行性 → 店家落點 → Tiled JSON
    水域 / 橋樑 geojson   ┘

設計要點：
  * 棋盤形狀＝真實行政區 polygon 裁切，不是矩形，也不是抽象棋盤。
    玩家因此會實際感受到「過橋才到得了大直」這種地理事實。
  * 水域不可通行、橋可通行，A* 會自己繞路——不需要任何「過橋」特例邏輯。
  * 店家落點碰撞（同格兩間店）往鄰近空格擠開。
  * 生成完一定做連通性檢查：走不到的店家會列出來。這種錯必須在生成階段
    就發現，不能等玩家卡在對岸才知道。

用法：
    python gen_board.py                       # 產生 config.json 裡所有棋盤
    python gen_board.py tpe-zhongshan         # 只產生指定棋盤
    python gen_board.py tpe-zhongshan --extra 30
                                              # 臨時覆蓋 extraEdges，不用改 config
    python gen_board.py tpe-zhongshan --roads generated
                                              # 強制用生成路網（跟真實道路比較用）
    python gen_board.py tpe-zhongshan-slice   # 1 m 格的 500 m 實驗切片
                                              # （config.json 裡帶 slice / cellSize / cacheId）
"""

import json
import math
import statistics
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
# 明確把腳本目錄放進 sys.path。通常 Python 會自動加，但環境設了
# PYTHONSAFEPATH=1（3.11+）或以其他方式啟動時不會，同目錄的 import 就會失敗。
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import fetch_boundary   # noqa: E402  （必須在 sys.path 補好之後）
import geo              # noqa: E402
import tiled            # noqa: E402

REPO_ROOT = HERE.parent.parent
CACHE_DIR = HERE / 'cache'

# 離行政區中位數超過這個距離的店家，視為座標錯誤而排除。
# 台灣最大的鄉鎮市區（花蓮秀林鄉）長軸約 60 km，8 km 對「區內店家」是很寬鬆的門檻。
OUTLIER_THRESHOLD_M = 8000


def load_shops(county, town, exclude_statuses):
    """從 data.json 取出該區的店家，並剔除座標離群值。"""
    with open(REPO_ROOT / 'data' / 'data.json', encoding='utf-8') as fh:
        rows = json.load(fh)

    picked = []
    for row in rows:
        if row.get('縣市') != county or row.get('鄉鎮市區') != town:
            continue
        if row.get('營業狀態') in exclude_statuses:
            continue
        try:
            lat = float(row['lat'])
            lng = float(row['lng'])
        except (TypeError, ValueError, KeyError):
            print(f"  ⚠ 無座標，略過：{row.get('ID')} {row.get('店名')}")
            continue
        picked.append({
            'shop_id': row.get('ID', ''),
            'name': row.get('店名', ''),
            'status': row.get('營業狀態', ''),
            'lat': lat,
            'lng': lng,
        })

    if len(picked) >= 3:
        mid_lat = statistics.median(s['lat'] for s in picked)
        mid_lng = statistics.median(s['lng'] for s in picked)
        m_lat, m_lng = geo.meters_per_degree(mid_lat)
        kept, dropped = [], []
        for shop in picked:
            dist = math.hypot((shop['lat'] - mid_lat) * m_lat,
                              (shop['lng'] - mid_lng) * m_lng)
            (kept if dist <= OUTLIER_THRESHOLD_M else dropped).append((shop, dist))
        for shop, dist in dropped:
            print(f"  ⚠ 座標離群 {dist / 1000:.1f} km，排除："
                  f"{shop['shop_id']} {shop['name']} ({shop['lat']}, {shop['lng']})")
        picked = [s for s, _ in kept]

    return picked


def load_water(board_id):
    path = CACHE_DIR / f'water-{board_id}.geojson'
    if not path.exists():
        print(f'  ⚠ 找不到 {path}')
        print('    → 先在能連 overpass-api.de 的機器上跑 `python fetch_water.py`。')
        print('    → 沒有水域圖層時棋盤仍會生成，但河與橋不會出現，A* 會直接穿越水面。')
        return None
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def load_roads(cache_id, mode, road_set=None):
    """讀真實道路快取。mode='generated' 時直接不讀。

    road_set 對應 fetch_roads.py --set 寫出來的檔名（roads-<board>-<set>.geojson）。
    cacheId 決定「借哪一區的圖資」、roadSet 決定「用哪一組道路」——這兩件事必須
    分開：R1 與 R2 是同一區的兩份道路快取，但水域快取只有一份。把 roadSet 混進
    cacheId 的話，水域會跟著去找 water-<區>-r2.geojson 而找不到，棋盤就會沒有河
    也沒有橋，A* 直接穿越水面，而連通性檢查還會回報「40/40 間店互相走得到」。
    """
    if mode == 'generated':
        return None
    suffix = f'-{road_set}' if road_set else ''
    path = CACHE_DIR / f'roads-{cache_id}{suffix}.geojson'
    if not path.exists():
        hint = ('python fetch_roads.py ' + cache_id
                + (f' --set {road_set}' if road_set else ''))
        if mode == 'osm':
            raise SystemExit(f'roadMode=osm 但找不到 {path}。'
                             f'先在能連 overpass-api.de 的機器上跑 `{hint}`')
        # 靜默退回生成路網會產出「看起來正常、其實不是真實道路」的盤，一定要出聲
        print(f'  ⚠ 找不到 {path}')
        print(f'    → 改用生成路網。要真實道路請跑 `{hint}`')
        return None
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def _pave(terrain, cell, road_i, road_bridge_i, bridge_i, water_i):
    """把一格鋪成道路，並正確保留「過河」屬性。

    三個步驟（鋪主路網、修補連通性、接支線）都會鋪路，早期是各寫一份
    if/else，結果修補與支線把前一步標好的 road_bridge 覆寫成一般 road——
    因為它們只問「原本是不是水或橋」，而那時那格已經是 road_bridge 了。
    症狀：拆橋測試報「河沒有切開兩岸」，但河其實是連續的，只是標記被抹掉。
    """
    cur = terrain[cell]
    if cur == road_bridge_i:
        return                                   # 已經是過河道路，別降級
    if cur in (bridge_i, water_i):
        terrain[cell] = road_bridge_i
    else:
        terrain[cell] = road_i


def _spur_to_road(build_ok, terrain, passable, width, height, shop, taken,
                  road_i, road_bridge_i, bridge_i, water_i):
    """從沒有臨路的店家接一條支線到最近的道路格。

    找最近道路用 BFS（在建置期通行圖上），找到之後把整條路徑鋪成道路。
    這種店多半是落點被擠開後掉到路網邊緣的，不接的話玩家永遠走不到它。
    """
    # 尋路時要把「其他店家的格子」擋掉。不擋的話支線會穿過別家店，
    # 而店家格不鋪路，支線就在那裡斷掉，這間店還是沒有門口。
    route_ok = bytearray(build_ok)
    for idx in taken:
        route_ok[idx] = 0
    start = shop['cy'] * width + shop['cx']
    route_ok[start] = 1                      # 只開放自己這一格當起點

    seen = {start}
    queue = [start]
    head = 0
    target = None
    while head < len(queue) and target is None:
        cur = queue[head]; head += 1
        cy, cx = divmod(cur, width)
        for ox, oy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = cx + ox, cy + oy
            if not (0 <= nx < width and 0 <= ny < height):
                continue
            nxt = ny * width + nx
            if nxt in seen or not route_ok[nxt]:
                continue
            if passable[nxt]:
                target = (nx, ny)
                break
            seen.add(nxt)
            queue.append(nxt)

    if target is None:
        return False
    path = geo.astar_path(route_ok, width, height, (shop['cx'], shop['cy']), target)
    if not path:
        return False
    for cell in path:
        if cell in taken:
            continue
        _pave(terrain, cell, road_i, road_bridge_i, bridge_i, water_i)
        passable[cell] = 1
    return True


def _repair_connectivity(terrain, build_ok, width, height,
                        road_i, road_bridge_i, bridge_i, water_i, taken):
    """把碎成多塊的路網接起來，回傳補了幾條連接道。

    真實 OSM 道路一定會碎：道路跑出行政區界外會被裁掉、跨水的小橋沒被水域
    圖層抓到會斷開、匝道沒抓全也會斷。碎掉的後果是玩家走不到那一區的店，
    所以生成階段就得補，不能留給玩家發現。

    作法：連通塊只算一次，然後從最大塊做**一次**多源 BFS（在建置期通行圖上，
    可以穿過還不是路的陸地）。BFS 過程中第一次碰到某個小塊，那條回溯路徑就是
    它到主塊的最短連接，鋪成道路即可；同一次 BFS 繼續跑就能把所有小塊都接完。

    早期版本是「接一條就重算一次」，中山區的合成測資會產生上百個碎塊，
    等於重算上百次全圖 flood fill——直接跑不完。
    """
    passable = bytearray(width * height)
    for i, t in enumerate(terrain):
        passable[i] = 1 if tiled.TERRAIN[t][3] else 0

    # ── 連通塊標記（一次掃完，不重算）──────────────────────────────────
    label = [-1] * (width * height)
    sizes = []
    for start in range(width * height):
        if not passable[start] or label[start] != -1:
            continue
        cid = len(sizes)
        stack = [start]
        label[start] = cid
        n = 0
        while stack:
            cur = stack.pop()
            n += 1
            cy, cx = divmod(cur, width)
            for ox, oy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = cx + ox, cy + oy
                if not (0 <= nx < width and 0 <= ny < height):
                    continue
                nxt = ny * width + nx
                if passable[nxt] and label[nxt] == -1:
                    label[nxt] = cid
                    stack.append(nxt)
        sizes.append(n)

    if len(sizes) <= 1:
        return 0

    main = max(range(len(sizes)), key=lambda c: sizes[c])
    pending = {c for c in range(len(sizes)) if c != main}

    # ── 一次多源 BFS，把所有小塊接回主塊 ──────────────────────────────
    prev = {}
    queue = []
    for i in range(width * height):
        if label[i] == main:
            prev[i] = -1
            queue.append(i)

    added = 0
    head = 0
    while head < len(queue) and pending:
        cur = queue[head]; head += 1
        cy, cx = divmod(cur, width)
        for ox, oy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = cx + ox, cy + oy
            if not (0 <= nx < width and 0 <= ny < height):
                continue
            nxt = ny * width + nx
            if nxt in prev or not build_ok[nxt]:
                continue
            prev[nxt] = cur
            cid = label[nxt]
            if cid != -1 and cid in pending:
                pending.discard(cid)
                node = nxt
                while node != -1:
                    if node not in taken:
                        _pave(terrain, node, road_i, road_bridge_i, bridge_i, water_i)
                    node = prev[node]
                added += 1
            queue.append(nxt)

    # pending 還有剩的，是隔著水又沒有橋，接不起來——留給連通性檢查報出來
    return added


def _generated_roads(cfg, board, placed, taken, terrain, build_ok,
                     width, height, road_i, road_bridge_i, bridge_i):
    """程式生成的抽象路網（Delaunay + MST + extraEdges）。"""
    extra = int(board.get('_extraOverride', cfg.get('extraEdges', 0)))
    pts = [(s['cx'], s['cy']) for s in placed]
    cand = geo.delaunay_edges(pts)
    print(f'  路網：Delaunay {len(cand)} 條候選邊，連線中…')

    # 每間店先選一個「門口節點」，路網連的是門口對門口，不是店對店。
    #
    # 為什麼不能直接連店家格：店家格不可通行，兩條路在同一間店交會時，
    # 一條的末端可能在店北邊、另一條在店南邊，中間隔著不可通行的店家，
    # 兩條路就接不起來——症狀是路網碎成幾十塊。
    # 讓所有經過這間店的路都共用同一個門口節點，交會點才真的連得上。
    #
    # 門口朝向：挑「面向最近鄰店」的那一側，路看起來才像從店門口延伸出去。
    route_ok = bytearray(build_ok)
    for idx in taken:
        route_ok[idx] = 0

    door_cell = {}
    for i, s in enumerate(placed):
        others = [o for j, o in enumerate(placed) if j != i]
        toward = min(others, key=lambda o: abs(s['cx']-o['cx']) + abs(s['cy']-o['cy'])) \
            if others else None
        prefs = [(1, 0), (-1, 0), (0, 1), (0, -1)]
        if toward:
            dx, dy = toward['cx'] - s['cx'], toward['cy'] - s['cy']
            prefs.sort(key=lambda d: -(d[0]*dx + d[1]*dy))
        for ox, oy in prefs:
            nx, ny = s['cx'] + ox, s['cy'] + oy
            if 0 <= nx < width and 0 <= ny < height and route_ok[ny*width + nx]:
                door_cell[i] = (nx, ny)
                break

    paths = {}
    weighted = []
    for a, b in cand:
        if a not in door_cell or b not in door_cell:
            continue
        path = geo.astar_path(route_ok, width, height, door_cell[a], door_cell[b])
        if path is None:
            continue
        paths[(a, b)] = path
        weighted.append((len(path), a, b))

    kept = geo.mst_and_extras(len(pts), weighted, extra)
    tree_n = len(pts) - 1 if pts else 0
    print(f'  路網：採用 {len(kept)} 條（MST {min(tree_n, len(kept))} + 額外 {max(0, len(kept)-tree_n)}）')

    water_i = tiled.TERRAIN_INDEX['water']
    for w, a, b in kept:
        for c in paths[(a, b)]:          # 別用 cell 當迴圈變數：外層的 cell 是格子邊長
            _pave(terrain, c, road_i, road_bridge_i, bridge_i, water_i)




def build_board(cfg, board, boundary):
    print(f"\n=== {board['id']}｜{board['county']}{board['town']} ===")

    feat = fetch_boundary.find_town(boundary, board['county'], board['town'])
    shops = load_shops(board['county'], board['town'], cfg.get('excludeStatuses', []))
    print(f'  店家 {len(shops)} 間')

    # ── 版圖範圍：行政區界為主，若有店家落在界外則一併納入 ────────────────
    min_lat, min_lng, max_lat, max_lng = geo.geometry_bounds(feat['geometry'])
    for shop in shops:
        min_lat = min(min_lat, shop['lat'])
        max_lat = max(max_lat, shop['lat'])
        min_lng = min(min_lng, shop['lng'])
        max_lng = max(max_lng, shop['lng'])

    cell = float(board.get('cellSize', cfg['cellSize']))
    margin = float(cfg['marginMeters'])
    sl = board.get('slice')

    if sl:
        # 切片：以指定中心切一塊正方形，不吃行政區外框、不加 margin。
        # 用途是在小範圍上試不同的 cellSize（1 m 全區有 3,660 萬格，跑不動也讀不動）。
        mid_lat, mid_lng = float(sl['centerLat']), float(sl['centerLng'])
        m_lat, m_lng = geo.meters_per_degree(mid_lat)
        half = float(sl['sideMeters']) / 2
        origin_lat = mid_lat + half / m_lat        # 西北角
        origin_lng = mid_lng - half / m_lng
        span_x = span_y = float(sl['sideMeters'])
    else:
        mid_lat = (min_lat + max_lat) / 2
        mid_lng = (min_lng + max_lng) / 2
        m_lat, m_lng = geo.meters_per_degree(mid_lat)
        origin_lat = max_lat + margin / m_lat      # 西北角
        origin_lng = min_lng - margin / m_lng
        span_x = (max_lng - min_lng) * m_lng + 2 * margin
        span_y = (max_lat - min_lat) * m_lat + 2 * margin

    width = int(math.ceil(span_x / cell))
    height = int(math.ceil(span_y / cell))

    proj = geo.Projection(mid_lat, mid_lng, cell, origin_lat, origin_lng)
    print(f'  版圖 {span_x:,.0f} m x {span_y:,.0f} m → {width} x {height} = {width * height:,} 格'
          f'（{cell:g} m/格）')

    if sl:
        # 切片外的店必須在這裡丟掉，不能留到落點階段——那裡對界外座標會呼叫
        # nearest_free_cell 把它硬拉進盤內，整個區的店會全部擠進切片裡。
        inside = []
        for shop in shops:
            cx, cy = proj.to_cell(shop['lat'], shop['lng'])
            if 0 <= cx < width and 0 <= cy < height:
                inside.append(shop)
        print(f'  切片內店家 {len(inside)}/{len(shops)} 間')
        shops = inside

    # ── 地形填色（順序即優先權：後畫的蓋前面的）────────────────────────────
    terrain = bytearray([tiled.TERRAIN_INDEX['outside']] * (width * height))

    geo.rasterize_rings(list(geo.iter_rings(feat['geometry'])), proj, width, height,
                        terrain, tiled.TERRAIN_INDEX['land'])

    water = load_water(board.get('cacheId', board['id']))
    water_stats = Counter()
    if water:
        wr = int(cfg.get('waterLineRadiusCells', 1))
        br = int(cfg.get('bridgeRadiusCells', 1))
        for f in water['features']:
            kind = f['properties'].get('kind')
            gm = f['geometry']
            if kind == 'water':
                geo.rasterize_rings(list(geo.iter_rings(gm)), proj, width, height,
                                    terrain, tiled.TERRAIN_INDEX['water'])
            elif kind == 'water_line':
                for line in geo.iter_lines(gm):
                    geo.rasterize_line(line, proj, width, height, terrain,
                                       tiled.TERRAIN_INDEX['water'], radius=wr)
            water_stats[kind] += 1
        # 橋最後畫，把被水淹掉的通路補回來。
        # only_over 限定只覆蓋水域格：OSM 的 bridge=yes 涵蓋所有高架道路
        # （中山區 bbox 內有 882 條），蓋在陸地上方的高架對通行性沒有意義。
        water_only = {tiled.TERRAIN_INDEX['water']}
        for f in water['features']:
            if f['properties'].get('kind') != 'bridge':
                continue
            for line in geo.iter_lines(f['geometry']):
                geo.rasterize_line(line, proj, width, height, terrain,
                                   tiled.TERRAIN_INDEX['bridge'], radius=br,
                                   only_over=water_only)
        print(f'  水域圖層 {dict(water_stats)}')

    # 區外的水／橋不需要保留（棋盤只玩區內）
    outside = tiled.TERRAIN_INDEX['outside']
    in_district = bytearray(width * height)
    geo.rasterize_rings(list(geo.iter_rings(feat['geometry'])), proj, width, height,
                        in_district, 1)
    for i in range(width * height):
        if not in_district[i]:
            terrain[i] = outside

    # 建置期通行圖：陸地與橋可走、水與區外不可走。
    # 這張圖只用來「連出道路」，不是玩家的通行規則——
    # 玩家最後只能走道路，但道路本身必須避開水面、必須繞到橋上，
    # 所以連線階段要用這張比較寬鬆的圖。
    build_ok = bytearray(width * height)
    land_i, bridge_i = tiled.TERRAIN_INDEX['land'], tiled.TERRAIN_INDEX['bridge']
    for i, t in enumerate(terrain):
        build_ok[i] = 1 if t in (land_i, bridge_i) else 0

    counts = Counter(terrain)
    print('  地形：' + '、'.join(
        f'{tiled.TERRAIN[k][1]} {v:,}' for k, v in sorted(counts.items())))

    # ── 先算真實道路的遮罩（若有）─────────────────────────────────────────
    # 順序很重要：真實 OSM 道路會直接經過店家格，而店家格不可通行——
    # 先放店家再鋪路的話，路會在店家身上被切斷，路網碎成好幾塊。
    # 所以先算出路在哪，店家再落在「路旁邊」而不是路上。
    road_i, road_bridge_i = tiled.TERRAIN_INDEX['road'], tiled.TERRAIN_INDEX['road_bridge']
    road_mode = board.get('_roadModeOverride', cfg.get('roadMode', 'auto'))
    roads = load_roads(board.get('cacheId', board['id']), road_mode,
                       board.get('roadSet'))

    road_mask = None
    junction_pts = None
    if roads:
        # 先用 bbox 濾掉盤外的道路。Bresenham 會把整條線走完才丟掉界外的格，
        # 1 m 格下整份 340 km 主幹道要走上千萬步，切片會慢到不能用。
        south = origin_lat - span_y / m_lat
        east = origin_lng + span_x / m_lng
        pad = 0.001                                # 約 100 m，邊界上的線不要被誤刪
        feats = []
        for f in roads['features']:
            lo_lat, lo_lng, hi_lat, hi_lng = geo.geometry_bounds(f['geometry'])
            if hi_lat < south - pad or lo_lat > origin_lat + pad:
                continue
            if hi_lng < origin_lng - pad or lo_lng > east + pad:
                continue
            feats.append(f)

        # 路口從 OSM 幾何算，不從柵格數鄰居：同一個座標被 3 段以上道路共用才是
        # 路口。柵格版量到的是「路寬」——3 格寬的路，每個內部格都有 4 個可通行
        # 鄰居，3 m 全區會把 61% 的道路格判成路口，數字沒有意義。
        # OSM 的 way 在交叉口會共用節點座標，所以統計每個座標的「相接線段端數」
        # 就夠：路中間的點是 2、端點是 1、T 字路口 3、十字路口 4。
        ends = Counter()
        for f in feats:
            for line in geo.iter_lines(f['geometry']):
                for k, pt in enumerate(line):
                    key = (round(pt[0], 7), round(pt[1], 7))
                    ends[key] += 1 if k in (0, len(line) - 1) else 2
        junction_pts = [k for k, v in ends.items() if v >= 3]

        kinds = Counter(f['properties'].get('highway', '') for f in feats)
        skipped = len(roads['features']) - len(feats)
        print(f"  路網：真實 OSM 道路 {len(feats)} 條 {dict(kinds)}"
              + (f'（盤外略過 {skipped} 條）' if skipped else ''))

        # 筆刷寬度永遠是奇數格（2r+1），公尺寬度因此會量化：
        # cell=1 時 3→3 格、6→7 格、9→9 格；cell=25 時三種寬度都算出 0（一格寬），
        # 與舊的 roadRadiusCells: 0 相同，所以既有 25 m 棋盤重生不會變。
        widths = cfg.get('roadWidthMeters')
        radius_of = {}
        for hw in kinds:
            if widths:
                w = float(widths.get(hw, widths.get('_default', 3)))
                radius_of[hw] = max(0, int(math.floor((w / cell - 1) / 2 + 0.5)))
            else:
                radius_of[hw] = int(cfg.get('roadRadiusCells', 0))
        if widths:
            print('  路寬：' + '、'.join(
                f'{hw or "?"} {2 * radius_of[hw] + 1} 格' for hw in sorted(kinds)))

        road_mask = bytearray(width * height)
        for f in feats:
            rr = radius_of[f['properties'].get('highway', '')]
            for line in geo.iter_lines(f['geometry']):
                geo.rasterize_line(line, proj, width, height, road_mask, 1, radius=rr)

    # 店家不能落在路上（會切斷路網），所以落點用「扣掉道路」的通行圖
    place_ok = bytearray(build_ok)
    if road_mask:
        for i, on in enumerate(road_mask):
            if on:
                place_ok[i] = 0

    # ── 店家落點 ──────────────────────────────────────────────────────────
    taken = {}
    placed = []
    collisions = 0
    unplaced = []
    for shop in sorted(shops, key=lambda s: s['shop_id']):
        cx, cy = proj.to_cell(shop['lat'], shop['lng'])
        idx = cy * width + cx
        moved = False
        if not (0 <= cx < width and 0 <= cy < height) or idx in taken or not place_ok[idx]:
            spot = geo.nearest_free_cell(taken, place_ok, width, height, (cx, cy))
            if spot is None:
                unplaced.append(shop)
                continue
            if spot != (cx, cy):
                moved = True
                collisions += 1
            cx, cy = spot
            idx = cy * width + cx
        taken[idx] = shop['shop_id']
        placed.append(dict(shop, cx=cx, cy=cy, moved=moved))

    print(f'  落點：{len(placed)} 間（擠開 {collisions} 間）'
          + (f'，無法放置 {len(unplaced)} 間' if unplaced else ''))
    for shop in unplaced:
        print(f"    ✗ 放不下：{shop['shop_id']} {shop['name']}")

    # ── 道路網 ────────────────────────────────────────────────────────────
    if road_mask:
        # ── 模式 A：真實 OSM 道路 ──────────────────────────────────────────
        # 只鋪在建置期可通行的格上（自動被行政區界裁掉）；碰到水域／橋樑一律
        # 標成「過河道路」——真實道路不會穿過河，那裡現實中就是橋。
        # 不這樣做的話，水域圖層沒抓到的小橋會讓道路斷開。
        water_i = tiled.TERRAIN_INDEX['water']
        for i, on in enumerate(road_mask):
            if not on or i in taken:
                continue
            # 順序不能反：build_ok 本身就含橋樑格，先問 build_ok 的話
            # 「鋪在橋上的路」會被記成一般道路，拆橋測試就驗不出河有沒有
            # 真的切開兩岸——中山區實測就是這樣漏掉大直的。
            if terrain[i] in (water_i, bridge_i) or build_ok[i]:
                _pave(terrain, i, road_i, road_bridge_i, bridge_i, water_i)
    else:
        # ── 模式 B：程式生成的抽象路網 ────────────────────────────────────
        # Delaunay 給出「哪些店該互相連」（平面圖，連線不交叉，長得像路網不像
        # 蜘蛛網），每條連線用 A* 在建置期通行圖上走出實際路徑（自動避水、自動
        # 繞橋），再取 MST 保證「任兩店之間恰好一條路」，最後加回 extraEdges
        # 條最短的邊形成環路，才會有兩三條替代路線。
        _generated_roads(cfg, board, placed, taken, terrain, build_ok,
                         width, height, road_i, road_bridge_i, bridge_i)

    # 補起碎掉的路網（真實 OSM 道路一定會碎；生成路網理論上不會，但補了無害）
    repaired = _repair_connectivity(terrain, build_ok, width, height,
                                    road_i, road_bridge_i, bridge_i,
                                    tiled.TERRAIN_INDEX['water'], taken)
    if repaired:
        print(f'  路網：補了 {repaired} 條連接道（原本路網是斷開的）')

    # 店家格最後畫，蓋在路上面
    for shop in placed:
        terrain[shop['cy'] * width + shop['cx']] = tiled.TERRAIN_INDEX['shop']

    # ── 門口 ──────────────────────────────────────────────────────────────
    # 門口 = 與店家四相鄰、且是道路的格。店家並排時被鄰居擋住的那一側
    # 自然就不會是門口——不需要一間一間指定。
    passable = bytearray(width * height)
    for i, t in enumerate(terrain):
        passable[i] = 1 if tiled.TERRAIN[t][3] else 0

    def neighbours(cx, cy):
        for ox, oy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = cx + ox, cy + oy
            if 0 <= nx < width and 0 <= ny < height:
                yield nx, ny, ny * width + nx

    spurs = 0
    for shop in placed:
        doors = [(nx, ny) for nx, ny, idx in neighbours(shop['cx'], shop['cy'])
                 if passable[idx]]
        if not doors:
            # 沒有任何一面臨路：從店家往最近的道路格接一條支線。
            # 這種店多半是被擠開後落在路網邊緣的，不接的話玩家永遠到不了。
            spur = _spur_to_road(build_ok, terrain, passable, width, height,
                                 shop, taken, road_i, road_bridge_i, bridge_i,
                                 tiled.TERRAIN_INDEX['water'])
            if spur:
                spurs += 1
                doors = [(nx, ny) for nx, ny, idx in neighbours(shop['cx'], shop['cy'])
                         if passable[idx]]
        shop['doors'] = doors

    # 支線是「從店家連到最近的道路」，而那條最近的道路可能屬於某個小碎塊，
    # 所以補完支線要再修一次連通性，然後重算門口（修補可能在店家旁邊多鋪了路）。
    if spurs:
        again = _repair_connectivity(terrain, build_ok, width, height,
                                     road_i, road_bridge_i, bridge_i,
                                     tiled.TERRAIN_INDEX['water'], taken)
        if again:
            print(f'  路網：支線接上後再補 {again} 條連接道')
        passable = bytearray(width * height)
        for i, t in enumerate(terrain):
            passable[i] = 1 if tiled.TERRAIN[t][3] else 0
        for shop in placed:
            shop['doors'] = [(nx, ny) for nx, ny, idx in neighbours(shop['cx'], shop['cy'])
                             if passable[idx]]

    doorless = [s for s in placed if not s['doors']]
    print(f'  門口：{len(placed) - len(doorless)}/{len(placed)} 間臨路'
          + (f'（補了 {spurs} 條支線）' if spurs else ''))
    for shop in doorless:
        print(f"    ⚠ 沒有門口：{shop['shop_id']} {shop['name']} @({shop['cx']},{shop['cy']})")

    counts = Counter(terrain)
    print('  最終地形：' + '、'.join(
        f'{tiled.TERRAIN[k][1]} {v:,}' for k, v in sorted(counts.items())))

    # 路口：「路網像迷宮還是像樹」的指標，也是事件系統之後要綁的錨點
    # （事件格必經在細格下不成立，見規劃書 §十三）。
    road_total = sum(1 for t in terrain if tiled.TERRAIN[t][3])
    junction_cells = []
    if junction_pts is not None:
        seen = set()
        for lng, lat in junction_pts:
            cx, cy = proj.to_cell(lat, lng)
            if not (0 <= cx < width and 0 <= cy < height):
                continue
            idx = cy * width + cx
            if not passable[idx] or idx in seen:
                continue            # 落在區外或被裁掉的路上
            seen.add(idx)
            junction_cells.append((cx, cy))
        print(f'  路網：道路 {road_total} 格、路口 {len(junction_cells)} 個（OSM 幾何）')
    else:
        # 生成路網沒有 OSM 幾何可用。那個模式的路一律 1 格寬，柵格數鄰居還算得準。
        junctions = 0
        for i, t in enumerate(terrain):
            if not tiled.TERRAIN[t][3]:
                continue
            cy, cx = divmod(i, width)
            if sum(1 for nx, ny, idx in neighbours(cx, cy) if passable[idx]) >= 3:
                junctions += 1
        print(f'  路網：道路 {road_total} 格、路口 {junctions} 個（柵格）')

    # ── 連通性檢查（走道路，不是走陸地）──────────────────────────────────
    stranded = []
    if placed and placed[0]['doors']:
        best = geo.flood_fill_reachable(passable, width, height, placed[0]['doors'][0])
        for shop in placed:
            if not shop['doors']:
                continue
            if (shop['doors'][0][1] * width + shop['doors'][0][0]) in best:
                continue
            comp = geo.flood_fill_reachable(passable, width, height, shop['doors'][0])
            if len(comp) > len(best):
                best = comp
        stranded = [s for s in placed
                    if s['doors'] and (s['doors'][0][1] * width + s['doors'][0][0]) not in best]
        print(f'  連通性：主要路網 {len(best):,} 格，'
              f'{len(placed) - len(stranded) - len(doorless)}/{len(placed)} 間店互相走得到')
        for shop in stranded:
            print(f"    ⚠ 走不到：{shop['shop_id']} {shop['name']}")

    # ── 輸出 ──────────────────────────────────────────────────────────────
    out_path = REPO_ROOT / board['out']
    out_path.parent.mkdir(parents=True, exist_ok=True)
    image_name = 'tiles-placeholder.png'
    image_size = tiled.write_placeholder_tileset(out_path.parent / image_name)

    meta = {
        'boardId': board['id'],
        'county': board['county'],
        'town': board['town'],
        'townId': feat['properties'].get('town_id', ''),
        'cellSize': int(cell),
        'originLat': origin_lat,
        'originLng': origin_lng,
        'metersPerDegLat': m_lat,
        'metersPerDegLng': m_lng,
        'shopCount': len(placed),
        'hasWaterLayer': bool(water),
        'roadSource': 'osm' if roads else 'generated',
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'generator': 'tools/board-gen/gen_board.py',
    }
    tmap = tiled.build_map(terrain, width, height, placed, meta, image_name, image_size,
                           junctions=junction_cells)
    tiled.save_map(out_path, tmap)
    size = out_path.stat().st_size
    print(f'  ✓ 已輸出 {board["out"]}（{size / 1024:,.0f} KB）')
    return {'board': board['id'], 'shops': len(placed), 'stranded': len(stranded),
            'cells': width * height}


def main():
    cfg = fetch_boundary.load_config()
    boundary = fetch_boundary.fetch()

    args = [a for a in sys.argv[1:]]
    extra_override = None
    if '--extra' in args:
        i = args.index('--extra')
        extra_override = int(args[i + 1])
        del args[i:i + 2]
    roads_override = None
    if '--roads' in args:
        i = args.index('--roads')
        roads_override = args[i + 1]
        del args[i:i + 2]
    only = args[0] if args else None

    results = []
    for board in cfg['boards']:
        if only and board['id'] != only:
            continue
        if extra_override is not None:
            board = dict(board, _extraOverride=extra_override)
        if roads_override is not None:
            board = dict(board, _roadModeOverride=roads_override)
        results.append(build_board(cfg, board, boundary))

    if not results:
        raise SystemExit(f'config.json 的 boards 裡找不到 {only}')

    print('\n=== 總計 ===')
    for r in results:
        flag = f"（{r['stranded']} 間走不到）" if r['stranded'] else ''
        print(f"  {r['board']}: {r['shops']} 間店 / {r['cells']:,} 格 {flag}")


if __name__ == '__main__':
    main()
