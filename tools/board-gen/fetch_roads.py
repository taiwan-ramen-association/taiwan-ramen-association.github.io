#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""fetch_roads.py — 從 OpenStreetMap 抓真實道路。

⚠️ 需要能連到 overpass-api.de。Claude Code 的雲端環境對外連線受政策限制
   （overpass 被擋），所以請在**你自己的機器**上跑；產出的快取進版控，
   之後 gen_board.py 就不需要網路。

抓哪些路由 config.json 的 roadTypes 決定。預設是 R1（只抓主幹道）：

    trunk / primary / secondary / tertiary（含各自的 _link 匝道）

只抓主幹道而不是全部 highway，是刻意的取捨：
    全抓（含 residential / service / footway）在 25 m 的格子下會糊成一團網，
    而且店與店之間會有數百條等價路徑——事件格再也不是「必經」，
    路網對玩法就失去意義，只剩導航。
    主幹道的間距動輒數百公尺，替代路線仍然有限，地理感和選擇感可以並存。

用法：
    python fetch_roads.py                  # 依 config.json 的 boards 逐一抓
    python fetch_roads.py tpe-zhongshan    # 只抓指定棋盤
    python fetch_roads.py tpe-zhongshan --set r2
                                           # 用 config.json 的 roadSets.r2（含巷弄）抓，
                                           # 寫到 cache/roads-tpe-zhongshan-r2.geojson，
                                           # 不會覆蓋 R1 的 roads-tpe-zhongshan.geojson

R1 與 R2 是長期並存的：25 m 的正式棋盤要 R1（巷弄在那個格子下會糊成一團），
小格子的實驗切片要 R2（3 m 格分得出 3 m 的巷子和 9 m 的幹道）。所以兩份快取
各自存檔，用 --set 決定抓哪一份、用 board 的 cacheId 決定生成時吃哪一份。
"""

import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import fetch_boundary          # noqa: E402
from geo import geometry_bounds  # noqa: E402

CACHE_DIR = HERE / 'cache'

QUERY = """
[out:json][timeout:240];
(
  way["highway"~"^({types})$"]({bbox});
);
out geom;
"""


def overpass_to_geojson(elements):
    """Overpass `out geom` → GeoJSON FeatureCollection（全部是 LineString）。"""
    features = []
    for el in elements:
        geom = el.get('geometry')
        if el.get('type') != 'way' or not geom or len(geom) < 2:
            continue
        tags = el.get('tags', {}) or {}
        features.append({
            'type': 'Feature',
            'properties': {
                'highway': tags.get('highway', ''),
                'name': tags.get('name', ''),
                'osm_id': el.get('id'),
            },
            'geometry': {
                'type': 'LineString',
                'coordinates': [[pt['lon'], pt['lat']] for pt in geom],
            },
        })
    return {'type': 'FeatureCollection', 'features': features}


def fetch_board(cfg, board, boundary, road_set=None):
    feat = fetch_boundary.find_town(boundary, board['county'], board['town'])
    min_lat, min_lng, max_lat, max_lng = geometry_bounds(feat['geometry'])
    pad = 0.005
    bbox = f'{min_lat - pad},{min_lng - pad},{max_lat + pad},{max_lng + pad}'

    if road_set:
        sets = cfg.get('roadSets') or {}
        if road_set not in sets:
            raise SystemExit(f'config.json 的 roadSets 裡沒有 "{road_set}"'
                             f'（現有：{", ".join(sorted(sets)) or "無"}）')
        types = sets[road_set]
    else:
        types = cfg.get('roadTypes') or ['trunk', 'primary', 'secondary', 'tertiary']
    # _link 是匝道／連接道，不抓的話交流道附近會斷開
    expanded = []
    for t in types:
        expanded.append(t)
        if t in ('trunk', 'primary', 'secondary', 'tertiary'):
            expanded.append(t + '_link')

    query = QUERY.format(types='|'.join(expanded), bbox=bbox)
    print(f"[roads] {board['id']} 抓 {'/'.join(types)}，bbox={bbox}")

    body = urllib.parse.urlencode({'data': query}).encode()
    req = urllib.request.Request(cfg['overpassEndpoint'], data=body,
                                 headers={'User-Agent': 'taiwan-ramen-board-gen/1.0'})
    with urllib.request.urlopen(req, timeout=300) as resp:
        payload = json.loads(resp.read().decode('utf-8'))

    geojson = overpass_to_geojson(payload.get('elements', []))
    from collections import Counter
    kinds = Counter(f['properties']['highway'] for f in geojson['features'])
    named = sum(1 for f in geojson['features'] if f['properties']['name'])
    print(f"[roads] {board['id']} 取得 {len(geojson['features'])} 條"
          f"（有路名 {named} 條）{dict(kinds)}")

    CACHE_DIR.mkdir(exist_ok=True)
    suffix = f'-{road_set}' if road_set else ''
    out = CACHE_DIR / f"roads-{board['id']}{suffix}.geojson"
    with open(out, 'w', encoding='utf-8') as fh:
        json.dump(geojson, fh, ensure_ascii=False, separators=(',', ':'))
    print(f'[roads] 已寫入 {out}')
    print(f'[roads] 接著跑：python gen_board.py {board["id"]}')


def main():
    cfg = fetch_boundary.load_config()
    boundary = fetch_boundary.fetch()

    args = list(sys.argv[1:])
    road_set = None
    if '--set' in args:
        i = args.index('--set')
        road_set = args[i + 1]
        del args[i:i + 2]
    only = args[0] if args else None

    hit = False
    for board in cfg['boards']:
        if only and board['id'] != only:
            continue
        # 帶 cacheId 的 board 是借用別人的快取（例如實驗切片借母區的），
        # 自己沒有要抓的東西——不然無參數執行會對同一個 bbox 轟 Overpass 好幾次。
        if board.get('cacheId'):
            print(f"[roads] {board['id']} 借用 {board['cacheId']} 的快取，略過")
            hit = True
            continue
        hit = True
        fetch_board(cfg, board, boundary, road_set)
        time.sleep(2)          # Overpass 是免費公共服務，別連續轟炸

    if only and not hit:
        raise SystemExit(f'config.json 的 boards 裡找不到 {only}')


if __name__ == '__main__':
    main()
