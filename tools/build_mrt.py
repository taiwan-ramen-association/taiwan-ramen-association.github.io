"""
build_mrt.py — 產生 finder 地圖的捷運路線疊加層 data/mrt.json

資料來源：OpenStreetMap（Overpass API），授權 ODbL，地圖右下已標示 © OpenStreetMap。
只在有新路線／新車站通車時手動執行一次：
    python tools/build_mrt.py

OSM 上同一條線的 ref／colour 標註不一致，且分上下行多筆 relation，
所以用 code_of() 歸類到 LINES 對照表，同一條線的 way 以 id 去重。
"""
import datetime
import json
import math
import os
import sys
import warnings

import requests

warnings.filterwarnings('ignore')

tools_dir = os.path.dirname(os.path.abspath(__file__))
root_dir  = os.path.dirname(tools_dir)
out_path  = os.path.join(root_dir, 'data', 'mrt.json')

# 主站常忙線（504），依序改用備用伺服器
ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
]
UA = {'User-Agent': 'taiwan-ramen-association-mrt-builder/1.0 (taiwanramen.org)'}

# 台灣本島範圍（金馬澎無捷運）
QUERY = '''[out:json][timeout:180][bbox:21.8,119.9,25.4,122.1];
rel["route"~"^(subway|light_rail|monorail)$"];
out geom;
(
  node["railway"="station"]["station"~"^(subway|light_rail|monorail)$"];
  node["public_transport"="station"]["subway"="yes"];
  node["public_transport"="station"]["light_rail"="yes"];
);
out;'''

# 繪製順序＝列表順序（後面的疊在上面）；顏色：北捷與機捷用官方色，其餘沿用 OSM 標註
LINES = [
    ('KC',   '高雄環狀輕軌', '#80b352'),
    ('KO',   '高雄捷運橘線', '#ffa500'),
    ('KR',   '高雄捷運紅線', '#ff0000'),
    ('TG',   '台中捷運綠線', '#6fb92c'),   # OSM 未標顏色
    ('K',    '安坑輕軌',     '#c3b091'),
    ('V',    '淡海輕軌',     '#febeb5'),
    ('LB',   '三鶯線',       '#6db7d0'),
    ('A',    '機場捷運',     '#8246af'),
    ('G03A', '小碧潭支線',   '#cedc00'),
    ('R22A', '新北投支線',   '#f890a5'),
    ('Y',    '環狀線',       '#ffdb00'),
    ('BR',   '文湖線',       '#c48c31'),
    ('O',    '中和新蘆線',   '#f8b61c'),
    ('G',    '松山新店線',   '#008659'),
    ('BL',   '板南線',       '#0070bd'),
    ('R',    '淡水信義線',   '#e3002c'),
]
LINE_CODES = {code for code, _, _ in LINES}

SIMPLIFY_M = 3      # 軌道簡化容差（公尺）：3m 肉眼無差，檔案約縮為 1/3
STATION_MERGE_M = 400   # 同名車站在此距離內視為同一站（轉乘站各線各有一個 node）


def code_of(tags):
    """OSM relation tags → LINES 的 code；無法歸類回傳 None（例如無 ref 的 新港東線）"""
    ref, net, col = tags.get('ref', ''), tags.get('network', ''), tags.get('colour', '')
    if net == '高雄捷運':
        return 'K' + ref
    if net == '環狀輕軌':
        return 'KC'
    if net == '臺中捷運':
        return 'TG'
    if '新北投' in ref:
        return 'R22A'
    if ref == 'G' and col.upper() == '#CEDC00':
        return 'G03A'
    return ref if ref in LINE_CODES else None


def simplify(pts, tol):
    """Douglas-Peucker；pts 為 [(lat, lng), ...]，tol 單位為度"""
    if len(pts) < 3:
        return pts
    (y1, x1), (y2, x2) = pts[0], pts[-1]
    dx, dy = x2 - x1, y2 - y1
    length = math.hypot(dx, dy) or 1e-12
    dmax, idx = 0, 0
    for i in range(1, len(pts) - 1):
        y, x = pts[i]
        dist = abs(dy * x - dx * y + x2 * y1 - y2 * x1) / length
        if dist > dmax:
            dmax, idx = dist, i
    if dmax > tol:
        return simplify(pts[:idx + 1], tol)[:-1] + simplify(pts[idx:], tol)
    return [pts[0], pts[-1]]


def haversine_m(lat1, lng1, lat2, lng2):
    to_rad = math.radians
    d_lat, d_lng = to_rad(lat2 - lat1), to_rad(lng2 - lng1)
    a = math.sin(d_lat / 2) ** 2 + math.cos(to_rad(lat1)) * math.cos(to_rad(lat2)) * math.sin(d_lng / 2) ** 2
    return 6371000 * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def fetch_overpass():
    for ep in ENDPOINTS:
        print(f'  📡 {ep}')
        try:
            r = requests.post(ep, data={'data': QUERY}, headers=UA, timeout=240, verify=False)
        except Exception as e:
            print(f'    ✗ 連線失敗：{e}')
            continue
        if r.status_code == 200:
            return r.json()
        print(f'    ✗ HTTP {r.status_code}')
    return None


def main():
    print('▶ 從 OpenStreetMap 抓取捷運路線與車站...')
    data = fetch_overpass()
    if not data:
        print('  ❌ 所有 Overpass 伺服器都失敗，data/mrt.json 未變更')
        sys.exit(1)

    # ── 路線：依 code 歸類，way 以 id 去重（上下行 relation 共用同一批 way）──
    ways_by_code = {code: {} for code in LINE_CODES}
    skipped = set()
    for e in data['elements']:
        if e['type'] != 'relation':
            continue
        tags = e.get('tags', {})
        code = code_of(tags)
        if not code:
            skipped.add(tags.get('name', str(e['id'])))
            continue
        for m in e['members']:
            # role 為 platform／stop 的是月台與停靠點，不是軌道
            if m['type'] == 'way' and m.get('role', '') in ('', 'forward', 'backward', 'main') and 'geometry' in m:
                ways_by_code[code][m['ref']] = [(p['lat'], p['lon']) for p in m['geometry']]

    tol = SIMPLIFY_M / 111000
    lines = []
    for code, name, color in LINES:
        ways = ways_by_code[code]
        if not ways:
            print(f'  ⚠  {code} {name}：OSM 找不到軌道，略過')
            continue
        paths = [[[round(lat, 5), round(lng, 5)] for lat, lng in simplify(w, tol)] for w in ways.values()]
        lines.append({'code': code, 'name': name, 'color': color, 'paths': paths})
        print(f'  ✓ {code:<5}{name}：{len(ways)} 段')
    if skipped:
        print(f'  ℹ  無法歸類而略過：{"、".join(sorted(skipped))}')

    # ── 車站：同名且相距 STATION_MERGE_M 內合併 ──
    stations = []
    for e in data['elements']:
        if e['type'] != 'node':
            continue
        name = e.get('tags', {}).get('name', '').strip()
        if not name:
            continue
        lat, lng = e['lat'], e['lon']
        if any(s['name'] == name and haversine_m(lat, lng, s['lat'], s['lng']) < STATION_MERGE_M for s in stations):
            continue
        stations.append({'name': name, 'lat': round(lat, 5), 'lng': round(lng, 5)})
    print(f'  ✓ 車站：{len(stations)} 站')

    out = {
        'generated_at': datetime.datetime.now().strftime('%Y-%m-%d'),
        'source': '© OpenStreetMap contributors (ODbL)',
        'lines': lines,
        'stations': stations,
    }
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(f'\n  ✅ 完成：data/mrt.json（{os.path.getsize(out_path) // 1024} KB）')


if __name__ == '__main__':
    main()
