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


def fetch_board(cfg, board, boundary):
    feat = fetch_boundary.find_town(boundary, board['county'], board['town'])
    min_lat, min_lng, max_lat, max_lng = geometry_bounds(feat['geometry'])
    pad = 0.005
    bbox = f'{min_lat - pad},{min_lng - pad},{max_lat + pad},{max_lng + pad}'

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
    out = CACHE_DIR / f"roads-{board['id']}.geojson"
    with open(out, 'w', encoding='utf-8') as fh:
        json.dump(geojson, fh, ensure_ascii=False, separators=(',', ':'))
    print(f'[roads] 已寫入 {out}')
    print(f'[roads] 接著跑：python gen_board.py {board["id"]}')


def main():
    cfg = fetch_boundary.load_config()
    boundary = fetch_boundary.fetch()
    only = sys.argv[1] if len(sys.argv) > 1 else None
    for board in cfg['boards']:
        if only and board['id'] != only:
            continue
        fetch_board(cfg, board, boundary)
        time.sleep(2)          # Overpass 是免費公共服務，別連續轟炸


if __name__ == '__main__':
    main()
