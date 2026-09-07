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

import fetch_boundary
import geo
import tiled

HERE = Path(__file__).resolve().parent
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
        # 橋最後畫，把被水淹掉的通路補回來
        for f in water['features']:
            if f['properties'].get('kind') != 'bridge':
                continue
            for line in geo.iter_lines(f['geometry']):
                geo.rasterize_line(line, proj, width, height, terrain,
                                   tiled.TERRAIN_INDEX['bridge'], radius=br)
            water_stats['bridge'] += 1
        print(f'  水域圖層 {dict(water_stats)}')

    # 區外的水／橋不需要保留（棋盤只玩區內）
    outside = tiled.TERRAIN_INDEX['outside']
    land = tiled.TERRAIN_INDEX['land']
    in_district = bytearray(width * height)
    geo.rasterize_rings(list(geo.iter_rings(feat['geometry'])), proj, width, height,
                        in_district, 1)
    for i in range(width * height):
        if not in_district[i]:
            terrain[i] = outside

    passable = bytearray(width * height)
    for i, t in enumerate(terrain):
        passable[i] = 1 if tiled.TERRAIN[t][3] else 0

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
        if not (0 <= cx < width and 0 <= cy < height) or idx in taken or not passable[idx]:
            spot = geo.nearest_free_cell(taken, passable, width, height, (cx, cy))
            if spot is None:
                unplaced.append(shop)
                continue
            if spot != (cx, cy):
                moved = True
                collisions += 1
            cx, cy = spot
            idx = cy * width + cx
        taken[idx] = shop['shop_id']
        entry = dict(shop, cx=cx, cy=cy, moved=moved)
        placed.append(entry)
        terrain[idx] = tiled.TERRAIN_INDEX['shop']

    print(f'  落點：{len(placed)} 間（擠開 {collisions} 間）'
          + (f'，無法放置 {len(unplaced)} 間' if unplaced else ''))
    for shop in unplaced:
        print(f"    ✗ 放不下：{shop['shop_id']} {shop['name']}")

    # ── 連通性檢查 ────────────────────────────────────────────────────────
    if placed:
        # 從店家最多的連通塊出發，看誰走不到
        reachable = geo.flood_fill_reachable(passable, width, height,
                                             (placed[0]['cx'], placed[0]['cy']))
        best = reachable
        for shop in placed:
            idx = shop['cy'] * width + shop['cx']
            if idx in best:
                continue
            comp = geo.flood_fill_reachable(passable, width, height, (shop['cx'], shop['cy']))
            if len(comp) > len(best):
                best = comp
        stranded = [s for s in placed if (s['cy'] * width + s['cx']) not in best]
        print(f'  連通性：主要區塊 {len(best):,} 格，'
              f'{len(placed) - len(stranded)}/{len(placed)} 間店互相走得到')
        for shop in stranded:
            print(f"    ⚠ 走不到：{shop['shop_id']} {shop['name']} @({shop['cx']},{shop['cy']})")
        if stranded and not water:
            print('    （尚未載入水域圖層，這通常代表店家落在區界外的孤島）')
    else:
        stranded = []

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
