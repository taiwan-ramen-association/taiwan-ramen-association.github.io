"""
setup_data.py
一鍵執行：更新行政區清單 → 補縣市/鄉鎮市區 → 補 lat/lng
"""
import json
import os
import re
import subprocess
import sys
import time
import warnings
import xml.etree.ElementTree as ET

warnings.filterwarnings('ignore')

def install(pkg):
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', pkg, '-q'])

try:
    import requests
except ImportError:
    print('安裝 requests 中...')
    install('requests')
    import requests

import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

tools_dir = os.path.dirname(os.path.abspath(__file__))
root_dir  = os.path.dirname(tools_dir)
json_path = os.path.join(root_dir, 'data.json')
dist_path = os.path.join(tools_dir, 'districts.json')

# ════════════════════════════════════════════════════════════════════════════
# STEP 1：更新行政區清單
# ════════════════════════════════════════════════════════════════════════════
print('=' * 60)
print('STEP 1／3　更新行政區清單（內政部 API）')
print('=' * 60)

COUNTY_CODES = list('ABCDEFGHIJKLMNOPQRSTUVWXYZ')
API_BASE = 'https://api.nlsc.gov.tw/other/ListTown1'

districts_raw = {}
for code in COUNTY_CODES:
    try:
        r = requests.get(f'{API_BASE}/{code}', timeout=10, verify=False)
        if r.status_code != 200 or '<townItem>' not in r.text:
            continue
        root = ET.fromstring(r.content)
        items = root.findall('townItem')
        if items:
            districts_raw[code] = [item.findtext('townname') for item in items]
            print(f'  {code}: {len(districts_raw[code])} 個鄉鎮市區')
    except Exception as e:
        print(f'  {code}: 失敗 ({e})')

county_names = {}
try:
    r = requests.get('https://api.nlsc.gov.tw/other/ListCounty', timeout=10, verify=False)
    root = ET.fromstring(r.content)
    for item in root.findall('countyItem'):
        county_names[item.findtext('countycode')] = item.findtext('countyname')
except Exception as e:
    print(f'  縣市名稱 API 失敗: {e}')

districts = {county_names.get(code, code): towns for code, towns in districts_raw.items()}

with open(dist_path, 'w', encoding='utf-8') as f:
    json.dump(districts, f, ensure_ascii=False, indent=2)

total = sum(len(v) for v in districts.values())
print(f'\n✅ 行政區清單完成：{len(districts)} 縣市，{total} 鄉鎮市區\n')

# ════════════════════════════════════════════════════════════════════════════
# STEP 2：補縣市／鄉鎮市區
# ════════════════════════════════════════════════════════════════════════════
print('=' * 60)
print('STEP 2／3　補縣市／鄉鎮市區')
print('=' * 60)

with open(json_path, 'r', encoding='utf-8') as f:
    rows = json.load(f)

def parse_city_district(addr):
    if not addr:
        return '', ''
    addr_n = addr.replace('台', '臺')
    # 去除開頭的郵遞區號（3~6 位數字）
    addr_n = re.sub(r'^\d{3,6}', '', addr_n).strip()
    for county, towns in districts.items():
        if addr_n.startswith(county):
            rest = addr_n[len(county):]
            for town in towns:
                if rest.startswith(town):
                    return county, town
    return '', ''

updated_dist = 0
for row in rows:
    # 去除地址欄位開頭的郵遞區號
    addr = row.get('地址', '')
    if addr:
        cleaned = re.sub(r'^\d{3,6}', '', addr).strip()
        if cleaned != addr:
            row['地址'] = cleaned
    need_city = not row.get('縣市', '').strip()
    need_dist = not row.get('鄉鎮市區', '').strip()
    if not need_city and not need_dist:
        continue
    city, dist = parse_city_district(row.get('地址', ''))
    if need_city and city:
        row['縣市'] = city
    if need_dist and dist:
        row['鄉鎮市區'] = dist
    if city or dist:
        updated_dist += 1
        print(f'  ✓ {row["店名"]}：{city} {dist}')
    else:
        print(f'  ✗ {row["店名"]}：地址解析失敗')

print(f'\n✅ 縣市／鄉鎮市區完成：補填 {updated_dist} 筆\n')

# ════════════════════════════════════════════════════════════════════════════
# STEP 3：補 lat/lng
# ════════════════════════════════════════════════════════════════════════════
print('=' * 60)
print('STEP 3／3　補 lat/lng 座標')
print('=' * 60)

to_geocode = [r for r in rows if not r.get('lat') or not r.get('lng')]

print(f'需要 geocode：{len(to_geocode)} 筆\n')

HEADERS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
updated_geo = 0
failed_geo  = []
consecutive = 0
MAX_CONSEC  = 5

def coords_from_map_url(url):
    if not url or not url.startswith('http'):
        return None, None
    r = requests.get(url, headers=HEADERS, timeout=10, verify=False, allow_redirects=True)
    m = re.search(r'!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)', r.url)
    if m:
        return float(m.group(1)), float(m.group(2))
    m = re.search(r'/@(-?\d+\.\d+),(-?\d+\.\d+)', r.url)
    if m:
        return float(m.group(1)), float(m.group(2))
    return None, None

def geocode_nominatim(address):
    r = requests.get('https://nominatim.openstreetmap.org/search',
        params={'q': address, 'format': 'json', 'limit': 1},
        headers=HEADERS, timeout=10, verify=False)
    results = r.json()
    return (float(results[0]['lat']), float(results[0]['lon'])) if results else (None, None)

for i, row in enumerate(to_geocode):
    name    = row.get('店名', '')
    address = row.get('地址', '') or name
    map_url = row.get('Map', '')
    print(f'[{i+1}/{len(to_geocode)}] {name}')
    try:
        lat, lng = coords_from_map_url(map_url)
        if lat:
            print(f'  ✓ (Map) {lat:.6f}, {lng:.6f}')
        else:
            lat, lng = geocode_nominatim(address)
            if lat:
                print(f'  ✓ (Nominatim) {lat:.6f}, {lng:.6f}')

        if lat:
            row['lat'] = lat
            row['lng'] = lng
            updated_geo += 1
            consecutive = 0
        else:
            failed_geo.append(name)
            consecutive += 1
            print(f'  ✗ 找不到座標（連續失敗 {consecutive}/{MAX_CONSEC}）')
    except Exception as e:
        failed_geo.append(name)
        consecutive += 1
        print(f'  ✗ 錯誤：{e}')

    if consecutive >= MAX_CONSEC:
        print(f'\n⚠ 連續失敗 {MAX_CONSEC} 筆，中斷作業')
        break
    time.sleep(1.1)

print(f'\n✅ 座標完成：更新 {updated_geo} 筆')
if failed_geo:
    print(f'⚠ 找不到座標：{", ".join(failed_geo)}')

# ════════════════════════════════════════════════════════════════════════════
# STEP 4：正規化營業時段格式
# ════════════════════════════════════════════════════════════════════════════
print('=' * 60)
print('STEP 4／4　正規化營業時段格式')
print('=' * 60)

HOURS_FIELDS = ['週一', '週二', '週三', '週四', '週五', '週六', '週日']

def normalize_hours(value):
    if not isinstance(value, str) or not value.strip():
        return value
    v = value.strip()
    # 統一破折號為全形 en dash (–)
    v = re.sub(r'(?<=\d)[—\-~～](?=\d)', '–', v)
    # 找出所有時段，以頓號重新組合
    segments = re.findall(r'\d{1,2}:\d{2}–\d{1,2}:\d{2}', v)
    return '、'.join(segments) if segments else value

updated_fmt = 0
for row in rows:
    for field in HOURS_FIELDS:
        original = row.get(field, '')
        normalized = normalize_hours(original)
        if normalized != original:
            row[field] = normalized
            updated_fmt += 1

print(f'✅ 格式正規化完成：更新 {updated_fmt} 個欄位\n')

# ════════════════════════════════════════════════════════════════════════════
# 寫回 data.json
# ════════════════════════════════════════════════════════════════════════════
with open(json_path, 'w', encoding='utf-8') as f:
    json.dump(rows, f, ensure_ascii=False, indent=2)

print('\n' + '=' * 60)
print(f'全部完成！data.json 已更新')
print('=' * 60)
print()
input('按 Enter 關閉...')
