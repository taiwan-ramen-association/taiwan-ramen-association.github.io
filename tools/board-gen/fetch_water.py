#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""fetch_water.py — 從 OpenStreetMap（Overpass API）抓水域與橋樑。

⚠️ 這支需要能連到 overpass-api.de。Claude Code 的雲端執行環境對外連線受
   政策限制（overpass 被擋），所以這支請在**你自己的機器**上跑一次；
   產出的快取檔進版控，之後 gen_board.py 就不需要網路。

抓兩類東西，缺一不可：
  ① 水域（面）：natural=water、waterway=riverbank、landuse=reservoir
  ② 橋樑（線）：bridge=yes 的道路
     橋在 OSM 是 way 不是面。只填水域的話，河會把兩岸完全切開，
     A* 找不到路，大直那兩間店就變成永遠走不到的孤島。

用法：
    python fetch_water.py                  # 依 config.json 的 boards 逐一抓
    python fetch_water.py tpe-zhongshan    # 只抓指定棋盤
"""

import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
# 明確把腳本目錄放進 sys.path。通常 Python 會自動加，但環境設了
# PYTHONSAFEPATH=1（3.11+）或以其他方式啟動時不會，同目錄的 import 就會失敗。
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import fetch_boundary          # noqa: E402  （必須在 sys.path 補好之後）
from geo import geometry_bounds  # noqa: E402
CACHE_DIR = HERE / 'cache'

QUERY = """
[out:json][timeout:240];
(
  way["natural"="water"]({bbox});
  relation["natural"="water"]({bbox});
  way["waterway"="riverbank"]({bbox});
  way["landuse"="reservoir"]({bbox});
);
out geom;
(
  way["waterway"~"^(river|canal)$"]({bbox});
);
out geom;
(
  way["bridge"]["highway"]({bbox});
);
out geom;
"""


def _ring_from_geometry(geom):
    return [[pt['lon'], pt['lat']] for pt in geom]


def overpass_to_geojson(elements):
    """把 Overpass 的 `out geom` 結果轉成 GeoJSON FeatureCollection。

    每個 feature 標上 properties.kind：
      water      面狀水域 → 直接填色
      water_line 河道中心線 → 以筆刷寬度畫線（沒有 riverbank 面時的後備）
      bridge     橋 → 疊在水域之上恢復通行
    """
    features = []
    for el in elements:
        tags = el.get('tags', {}) or {}
        if tags.get('bridge') and tags.get('highway'):
            kind = 'bridge'
        elif tags.get('waterway') in ('river', 'canal') and 'riverbank' not in tags.values():
            kind = 'water_line'
        else:
            kind = 'water'

        if el['type'] == 'way' and el.get('geometry'):
            coords = _ring_from_geometry(el['geometry'])
            if kind in ('water',) and len(coords) >= 4 and coords[0] == coords[-1]:
                geometry = {'type': 'Polygon', 'coordinates': [coords]}
            else:
                geometry = {'type': 'LineString', 'coordinates': coords}
                if kind == 'water':
                    # 沒閉合的水域 way（河岸被切段）當線處理，才不會整條漏掉
                    kind = 'water_line'
        elif el['type'] == 'relation':
            outers = [_ring_from_geometry(m['geometry'])
                      for m in el.get('members', [])
                      if m.get('role') == 'outer' and m.get('geometry')]
            if not outers:
                continue
            geometry = {'type': 'MultiPolygon', 'coordinates': [[ring] for ring in outers]}
        else:
            continue

        features.append({
            'type': 'Feature',
            'properties': {'kind': kind, 'osm_id': el.get('id'), 'name': tags.get('name', '')},
            'geometry': geometry,
        })
    return {'type': 'FeatureCollection', 'features': features}


def fetch_board(cfg, board, boundary):
    feat = fetch_boundary.find_town(boundary, board['county'], board['town'])
    min_lat, min_lng, max_lat, max_lng = geometry_bounds(feat['geometry'])
    pad = 0.01                                    # 約 1 km，確保橋的兩端都抓得到
    bbox = f'{min_lat - pad},{min_lng - pad},{max_lat + pad},{max_lng + pad}'

    query = QUERY.format(bbox=bbox)
    print(f"[water] {board['id']} 查詢 bbox={bbox}")

    body = urllib.parse.urlencode({'data': query}).encode()
    req = urllib.request.Request(cfg['overpassEndpoint'], data=body,
                                 headers={'User-Agent': 'taiwan-ramen-board-gen/1.0'})
    with urllib.request.urlopen(req, timeout=300) as resp:
        payload = json.loads(resp.read().decode('utf-8'))

    geojson = overpass_to_geojson(payload.get('elements', []))
    counts = {}
    for f in geojson['features']:
        counts[f['properties']['kind']] = counts.get(f['properties']['kind'], 0) + 1
    print(f"[water] {board['id']} 取得 {counts}")

    CACHE_DIR.mkdir(exist_ok=True)
    out = CACHE_DIR / f"water-{board['id']}.geojson"
    with open(out, 'w', encoding='utf-8') as fh:
        json.dump(geojson, fh, ensure_ascii=False, separators=(',', ':'))
    print(f'[water] 已寫入 {out}')


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
