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
    python gen_board.py                  # 產生 config.json 裡所有棋盤
    python gen_board.py tpe-zhongshan    # 只產生指定棋盤
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


def _spur_to_road(build_ok, terrain, passable, width, height, shop, taken,
                  road_i, road_bridge_i, bridge_i):
    """從沒有臨路的店家接一條支線到最近的道路格。

    找最近道路用 BFS（在建置期通行圖上），找到之後把整條路徑鋪成道路。
    這種店多半是落點被擠開後掉到路網邊緣的，不接的話玩家永遠走不到它。
    """
    start = shop['cy'] * width + shop['cx']
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
            if nxt in seen or not build_ok[nxt]:
                continue
            if passable[nxt]:
                target = (nx, ny)
                break
            seen.add(nxt)
            queue.append(nxt)

    if target is None:
        return False
    path = geo.astar_path(build_ok, width, height, (shop['cx'], shop['cy']), target)
    if not path:
        return False
    for cell in path:
        if cell in taken:
            continue
        terrain[cell] = road_bridge_i if terrain[cell] == bridge_i else road_i
        passable[cell] = 1
    return True


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

    cell = float(cfg['cellSize'])
    margin = float(cfg['marginMeters'])
    mid_lat = (min_lat + max_lat) / 2
    m_lat, m_lng = geo.meters_per_degree(mid_lat)

    origin_lat = max_lat + margin / m_lat          # 西北角
    origin_lng = min_lng - margin / m_lng
    span_x = (max_lng - min_lng) * m_lng + 2 * margin
    span_y = (max_lat - min_lat) * m_lat + 2 * margin
    width = int(math.ceil(span_x / cell))
    height = int(math.ceil(span_y / cell))

    proj = geo.Projection(mid_lat, (min_lng + max_lng) / 2, cell, origin_lat, origin_lng)
    print(f'  版圖 {span_x:,.0f} m x {span_y:,.0f} m → {width} x {height} = {width * height:,} 格')

    # ── 地形填色（順序即優先權：後畫的蓋前面的）────────────────────────────
    terrain = bytearray([tiled.TERRAIN_INDEX['outside']] * (width * height))

    geo.rasterize_rings(list(geo.iter_rings(feat['geometry'])), proj, width, height,
                        terrain, tiled.TERRAIN_INDEX['land'])

    water = load_water(board['id'])
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

    # ── 店家落點 ──────────────────────────────────────────────────────────
    taken = {}
    placed = []
    collisions = 0
    unplaced = []
    for shop in sorted(shops, key=lambda s: s['shop_id']):
        cx, cy = proj.to_cell(shop['lat'], shop['lng'])
        idx = cy * width + cx
        moved = False
        if not (0 <= cx < width and 0 <= cy < height) or idx in taken or not build_ok[idx]:
            spot = geo.nearest_free_cell(taken, build_ok, width, height, (cx, cy))
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
    # Delaunay 給出「哪些店該互相連」（平面圖，連線不交叉，長得像路網不像蜘蛛網），
    # 每條連線用 A* 在建置期通行圖上走出實際路徑（自動避水、自動繞橋），
    # 再取 MST 保證「任兩店之間恰好一條路」，最後加回 extraEdges 條最短的邊
    # 形成環路，才會有兩三條替代路線。
    extra = int(cfg.get('extraEdges', 0))
    road_i, road_bridge_i = tiled.TERRAIN_INDEX['road'], tiled.TERRAIN_INDEX['road_bridge']
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

    for w, a, b in kept:
        for c in paths[(a, b)]:          # 別用 cell 當迴圈變數：外層的 cell 是格子邊長
            terrain[c] = road_bridge_i if terrain[c] == bridge_i else road_i

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
                                 shop, taken, road_i, road_bridge_i, bridge_i)
            if spur:
                spurs += 1
                doors = [(nx, ny) for nx, ny, idx in neighbours(shop['cx'], shop['cy'])
                         if passable[idx]]
        shop['doors'] = doors

    doorless = [s for s in placed if not s['doors']]
    print(f'  門口：{len(placed) - len(doorless)}/{len(placed)} 間臨路'
          + (f'（補了 {spurs} 條支線）' if spurs else ''))
    for shop in doorless:
        print(f"    ⚠ 沒有門口：{shop['shop_id']} {shop['name']} @({shop['cx']},{shop['cy']})")

    counts = Counter(terrain)
    print('  最終地形：' + '、'.join(
        f'{tiled.TERRAIN[k][1]} {v:,}' for k, v in sorted(counts.items())))

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
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'generator': 'tools/board-gen/gen_board.py',
    }
    tmap = tiled.build_map(terrain, width, height, placed, meta, image_name, image_size)
    tiled.save_map(out_path, tmap)
    size = out_path.stat().st_size
    print(f'  ✓ 已輸出 {board["out"]}（{size / 1024:,.0f} KB）')
    return {'board': board['id'], 'shops': len(placed), 'stranded': len(stranded),
            'cells': width * height}


def main():
    cfg = fetch_boundary.load_config()
    boundary = fetch_boundary.fetch()
    only = sys.argv[1] if len(sys.argv) > 1 else None

    results = []
    for board in cfg['boards']:
        if only and board['id'] != only:
            continue
        results.append(build_board(cfg, board, boundary))

    if not results:
        raise SystemExit(f'config.json 的 boards 裡找不到 {only}')

    print('\n=== 總計 ===')
    for r in results:
        flag = f"（{r['stranded']} 間走不到）" if r['stranded'] else ''
        print(f"  {r['board']}: {r['shops']} 間店 / {r['cells']:,} 格 {flag}")


if __name__ == '__main__':
    main()
