"""
setup_data.py — 資料處理工具
執行後選擇步驟，0 為全部執行
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
json_path = os.path.join(root_dir, 'data', 'data.json')
dist_path = os.path.join(tools_dir, 'districts.json')

# ── 共用 I/O ──────────────────────────────────────────────────────────────────
def load_data():
    with open(json_path, 'r', encoding='utf-8') as f:
        return json.load(f)

def save_data(rows):
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)

def load_districts():
    if not os.path.exists(dist_path):
        return {}
    with open(dist_path, 'r', encoding='utf-8') as f:
        return json.load(f)

def section(num, title):
    print()
    print('─' * 52)
    print(f'  {num}  {title}')
    print('─' * 52)

# ════════════════════════════════════════════════════════════════════════════════
# STEP 1：更新行政區清單
# ════════════════════════════════════════════════════════════════════════════════
def step_update_districts():
    section(1, '更新行政區清單（內政部 API）')

    API_BASE = 'https://api.nlsc.gov.tw/other/ListTown1'
    districts_raw = {}

    for code in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ':
        try:
            r = requests.get(f'{API_BASE}/{code}', timeout=10, verify=False)
            if r.status_code != 200 or '<townItem>' not in r.text:
                continue
            root  = ET.fromstring(r.content)
            items = root.findall('townItem')
            if items:
                districts_raw[code] = [item.findtext('townname') for item in items]
                print(f'    {code}: {len(districts_raw[code])} 個鄉鎮市區')
        except Exception as e:
            print(f'    {code}: 失敗 ({e})')

    county_names = {}
    try:
        r = requests.get('https://api.nlsc.gov.tw/other/ListCounty', timeout=10, verify=False)
        root = ET.fromstring(r.content)
        for item in root.findall('countyItem'):
            county_names[item.findtext('countycode')] = item.findtext('countyname')
    except Exception as e:
        print(f'    縣市名稱 API 失敗: {e}')

    districts = {county_names.get(c, c): towns for c, towns in districts_raw.items()}
    with open(dist_path, 'w', encoding='utf-8') as f:
        json.dump(districts, f, ensure_ascii=False, indent=2)

    total = sum(len(v) for v in districts.values())
    print(f'\n  ✅ 完成：{len(districts)} 縣市，{total} 鄉鎮市區')
    return len(districts)

# ════════════════════════════════════════════════════════════════════════════════
# STEP 2：補縣市／鄉鎮市區
# ════════════════════════════════════════════════════════════════════════════════
def step_fill_city_district():
    section(2, '補縣市／鄉鎮市區')

    districts = load_districts()
    if not districts:
        print('  ⚠  找不到 districts.json，請先執行步驟 1')
        return 0

    rows = load_data()

    def parse(addr):
        if not addr:
            return '', ''
        s = re.sub(r'^\d{3,6}', '', addr.replace('台', '臺')).strip()
        for county, towns in districts.items():
            if s.startswith(county):
                rest = s[len(county):]
                for town in towns:
                    if rest.startswith(town):
                        return county, town
        return '', ''

    updated = 0
    for row in rows:
        addr = row.get('地址', '')
        if addr:
            cleaned = re.sub(r'^\d{3,6}', '', addr).strip()
            if cleaned != addr:
                row['地址'] = cleaned

        need_city = not row.get('縣市', '').strip()
        need_dist = not row.get('鄉鎮市區', '').strip()
        if not need_city and not need_dist:
            continue

        city, dist = parse(row.get('地址', ''))
        if need_city and city:
            row['縣市'] = city
        if need_dist and dist:
            row['鄉鎮市區'] = dist

        if city or dist:
            updated += 1
            print(f'    ✓ {row["店名"]}：{city} {dist}')
        else:
            print(f'    ✗ {row["店名"]}：地址解析失敗')

    save_data(rows)
    print(f'\n  ✅ 完成：補填 {updated} 筆（共 {len(rows)} 筆）')
    return updated

# ════════════════════════════════════════════════════════════════════════════════
# STEP 3：補 lat/lng 座標
# ════════════════════════════════════════════════════════════════════════════════
def step_geocode():
    section(3, '補 lat/lng 座標')

    print('  模式選擇（直接 Enter = 只補缺少座標）：')
    print('    1. 只補缺少座標的店家  ← 預設')
    print('    2. 重新更正所有有 Map URL 的店家（修正舊座標精度）')
    mode = input('  請輸入 1 或 2：').strip() or '1'

    rows  = load_data()
    total = len(rows)
    if mode == '2':
        to_geocode = [r for r in rows if r.get('Map', '').startswith('http') or not r.get('lat')]
        print(f'  重新 geocode：{len(to_geocode)} 筆（共 {total} 筆）')
    else:
        to_geocode = [r for r in rows if not r.get('lat') or not r.get('lng')]
        print(f'  需要 geocode：{len(to_geocode)} 筆（共 {total} 筆）')

    if not to_geocode:
        print('  ✅ 無需處理')
        return 0

    UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    updated    = 0
    failed     = []
    consecutive = 0
    MAX_CONSEC  = 5

    def from_map_url(url):
        if not url or not url.startswith('http'):
            return None, None
        r = requests.get(url, headers=UA, timeout=10, verify=False, allow_redirects=True)
        m = re.search(r'!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)', r.url)
        if m:
            return float(m.group(1)), float(m.group(2))
        m = re.search(r'/@(-?\d+\.\d+),(-?\d+\.\d+)', r.url)
        if m:
            return float(m.group(1)), float(m.group(2))
        return None, None

    def from_nominatim(address):
        r = requests.get('https://nominatim.openstreetmap.org/search',
            params={'q': address, 'format': 'json', 'limit': 1},
            headers=UA, timeout=10, verify=False)
        res = r.json()
        return (float(res[0]['lat']), float(res[0]['lon'])) if res else (None, None)

    for i, row in enumerate(to_geocode):
        name    = row.get('店名', '')
        address = row.get('地址', '') or name
        print(f'  [{i+1}/{len(to_geocode)}] {name}')
        try:
            lat, lng = from_map_url(row.get('Map', ''))
            if lat:
                print(f'    ✓ (Map URL) {lat:.6f}, {lng:.6f}')
            else:
                lat, lng = from_nominatim(address)
                if lat:
                    print(f'    ✓ (Nominatim) {lat:.6f}, {lng:.6f}')

            if lat:
                row['lat'] = lat
                row['lng'] = lng
                updated   += 1
                consecutive = 0
            else:
                failed.append(name)
                consecutive += 1
                print(f'    ✗ 找不到座標（連續失敗 {consecutive}/{MAX_CONSEC}）')
        except Exception as e:
            failed.append(name)
            consecutive += 1
            print(f'    ✗ 錯誤：{e}')

        if consecutive >= MAX_CONSEC:
            print(f'\n  ⚠  連續失敗 {MAX_CONSEC} 筆，中斷作業')
            break
        time.sleep(1.1)

    save_data(rows)
    print(f'\n  ✅ 完成：更新 {updated} 筆（共 {total} 筆）')
    if failed:
        print(f'  ⚠  無法取得座標：{", ".join(failed)}')
    return updated

# ════════════════════════════════════════════════════════════════════════════════
# STEP 4：正規化營業時段
# ════════════════════════════════════════════════════════════════════════════════
HOURS_FIELDS = ['週一', '週二', '週三', '週四', '週五', '週六', '週日', '營業時段']

def normalize_hours(value):
    if not isinstance(value, str) or not value.strip():
        return value
    v = value.strip()
    v = re.sub(r'(?<=\d)[—\-~～](?=\d)', '–', v)
    segments = re.findall(r'\d{1,2}:\d{2}–\d{1,2}:\d{2}', v)
    return '、'.join(segments) if segments else v

def step_normalize_hours():
    section(4, '正規化營業時段格式')

    rows    = load_data()
    updated = 0
    for row in rows:
        for field in HOURS_FIELDS:
            original   = row.get(field, '')
            normalized = normalize_hours(original)
            if normalized != original:
                row[field] = normalized
                updated   += 1
                print(f'    {row["店名"]} [{field}]  {original!r} → {normalized!r}')

    save_data(rows)
    print(f'\n  ✅ 完成：更新 {updated} 個欄位（共 {len(rows)} 筆）')
    return updated

# ════════════════════════════════════════════════════════════════════════════════
# STEP 5：正規化星期排序
# ════════════════════════════════════════════════════════════════════════════════
DAY_ORDER  = {'一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7}
DAY_FIELDS = ['營業日', '店休日']

def normalize_days(value):
    if not value or not isinstance(value, str):
        return value
    parts = [p.strip() for p in value.split(',')]
    if not all(p in DAY_ORDER for p in parts if p):
        return value
    return ', '.join(sorted(parts, key=lambda d: DAY_ORDER.get(d, 99)))

def step_normalize_days():
    section(5, '正規化星期排序')

    rows    = load_data()
    updated = 0
    for row in rows:
        for field in DAY_FIELDS:
            original   = row.get(field, '')
            normalized = normalize_days(original)
            if normalized != original:
                row[field] = normalized
                updated   += 1
                print(f'    {row["店名"]} [{field}]  {original!r} → {normalized!r}')

    save_data(rows)
    print(f'\n  ✅ 完成：更新 {updated} 個欄位（共 {len(rows)} 筆）')
    return updated

# ════════════════════════════════════════════════════════════════════════════════
# STEP 6：正規化開幕日期
# ════════════════════════════════════════════════════════════════════════════════
DATE_FIELDS = ['開幕日']

def normalize_date(value):
    """各種日期格式統一為 YYYY-MM-DD，無法辨識則原樣返回"""
    if not value or not isinstance(value, str) or not value.strip():
        return value
    v = value.strip()

    # 已經是標準格式
    if re.match(r'^\d{4}-\d{2}-\d{2}$', v):
        return v

    # YYYY-MM-DD HH:MM:SS 或 YYYY-MM-DD HH:MM（Excel datetime）
    m = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})[\sT]\d{1,2}:\d{2}', v)
    if m:
        return f'{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}'

    # YYYY/MM/DD 或 YYYY/M/D
    m = re.match(r'^(\d{4})/(\d{1,2})/(\d{1,2})$', v)
    if m:
        return f'{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}'

    # YYYY.MM.DD 或 YYYY.M.D
    m = re.match(r'^(\d{4})\.(\d{1,2})\.(\d{1,2})$', v)
    if m:
        return f'{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}'

    # YYYY-M-D（有破折號但未補零）
    m = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})$', v)
    if m:
        return f'{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}'

    # YYYYMMDD（純數字 8 碼）
    m = re.match(r'^(\d{4})(\d{2})(\d{2})$', v)
    if m:
        return f'{m.group(1)}-{m.group(2)}-{m.group(3)}'

    return v  # 無法辨識，原樣返回

def step_normalize_dates():
    section(6, '正規化開幕日期（→ YYYY-MM-DD）')

    rows    = load_data()
    updated = 0
    failed  = []

    for row in rows:
        for field in DATE_FIELDS:
            original = row.get(field, '')
            if not original:
                continue
            normalized = normalize_date(original)
            if normalized == original:
                continue
            if re.match(r'^\d{4}-\d{2}-\d{2}$', normalized):
                row[field] = normalized
                updated   += 1
                print(f'    ✓ {row["店名"]} [{field}]  {original!r} → {normalized!r}')
            else:
                failed.append((row['店名'], field, original))

    save_data(rows)
    print(f'\n  ✅ 完成：更新 {updated} 個欄位（共 {len(rows)} 筆）')
    if failed:
        print(f'  ⚠  無法辨識格式（請手動修正）：')
        for name, field, val in failed:
            print(f'      {name} [{field}] = {val!r}')
    return updated

# ════════════════════════════════════════════════════════════════════════════════
# STEP 7：分配店家 ID
# ════════════════════════════════════════════════════════════════════════════════
CITY_CODE = {
    '臺北市': 'A', '台北市': 'A',
    '新北市': 'B',
    '桃園市': 'C',
    '臺中市': 'D', '台中市': 'D',
    '臺南市': 'E', '台南市': 'E',
    '高雄市': 'F',
    '基隆市': 'G',
    '新竹市': 'H',
    '新竹縣': 'I',
    '苗栗縣': 'J',
    '彰化縣': 'K',
    '南投縣': 'L',
    '雲林縣': 'M',
    '嘉義市': 'N',
    '嘉義縣': 'O',
    '屏東縣': 'P',
    '宜蘭縣': 'Q',
    '花蓮縣': 'R',
    '臺東縣': 'S', '台東縣': 'S',
    '澎湖縣': 'T',
    '金門縣': 'U',
    '連江縣': 'V',
}
ID_RE = re.compile(r'^[A-Z]\d{5}$')

CODE_TO_CITY = {
    'A': '臺北市', 'B': '新北市', 'C': '桃園市', 'D': '臺中市',
    'E': '臺南市', 'F': '高雄市', 'G': '基隆市', 'H': '新竹市',
    'I': '新竹縣', 'J': '苗栗縣', 'K': '彰化縣', 'L': '南投縣',
    'M': '雲林縣', 'N': '嘉義市', 'O': '嘉義縣', 'P': '屏東縣',
    'Q': '宜蘭縣', 'R': '花蓮縣', 'S': '臺東縣', 'T': '澎湖縣',
    'U': '金門縣', 'V': '連江縣', 'Z': '未知縣市',
}

def _get_city_for_id(row):
    city = str(row.get('縣市', '')).strip()
    if not city:
        addr = str(row.get('地址', '')).strip()
        addr = re.sub(r'^\d{3,6}', '', addr)
        city = addr[:3]
    return city.replace('台', '臺')

def step_assign_ids():
    section(7, '分配店家 ID（縣市代碼 + 5位流水號）')

    rows = load_data()

    # 掃描現有最大流水號
    city_max = {}
    for row in rows:
        eid = str(row.get('ID', '')).strip()
        if ID_RE.match(eid):
            letter = eid[0]
            city_max[letter] = max(city_max.get(letter, 0), int(eid[1:]))

    assigned = 0
    for row in rows:
        eid = str(row.get('ID', '')).strip()
        if ID_RE.match(eid):
            continue
        city   = _get_city_for_id(row)
        letter = CITY_CODE.get(city, 'Z')
        next_n = city_max.get(letter, 0) + 1
        city_max[letter] = next_n
        row['ID'] = f'{letter}{next_n:05d}'
        assigned += 1
        print(f'    ✓ {row["店名"]}  →  {row["ID"]}')

    # 確保 ID 排在第一欄
    rows = [{'ID': r.get('ID', ''), **{k: v for k, v in r.items() if k != 'ID'}} for r in rows]

    save_data(rows)
    print(f'\n  ✅ 完成：新分配 {assigned} 筆，共 {len(rows)} 筆')

    city_counts = {}
    for row in rows:
        letter = row.get('ID', 'Z')[0] if row.get('ID') else 'Z'
        city_counts[letter] = city_counts.get(letter, 0) + 1
    print('\n  各縣市店家數量：')
    for letter in sorted(city_counts):
        print(f'    {letter} {CODE_TO_CITY.get(letter, letter)}: {city_counts[letter]} 間')

    return assigned

# ════════════════════════════════════════════════════════════════════════════════
# 選單
# ════════════════════════════════════════════════════════════════════════════════
STEPS = [
    (1, '更新行政區清單（內政部 API）',   step_update_districts),
    (2, '補縣市／鄉鎮市區',               step_fill_city_district),
    (3, '補 lat/lng 座標',                step_geocode),
    (4, '正規化營業時段格式',             step_normalize_hours),
    (5, '正規化星期排序',                 step_normalize_days),
    (6, '正規化開幕日期（→ YYYY-MM-DD）', step_normalize_dates),
    (7, '分配店家 ID',                    step_assign_ids),
]

def show_menu():
    print()
    print('╔' + '═' * 50 + '╗')
    print('║{:^50}║'.format('資料處理工具　Setup Data'))
    print('╠' + '═' * 50 + '╣')
    print('║  0  全部執行{:<37}║'.format(''))
    print('║  ' + '─' * 47 + '║')
    for num, desc, _ in STEPS:
        print(f'║  {num}  {desc:<44}║')
    print('║  ' + '─' * 47 + '║')
    print('║  q  離開{:<41}║'.format(''))
    print('╚' + '═' * 50 + '╝')

while True:
    show_menu()
    choice = input('\n請輸入數字：').strip().lower()

    if choice == 'q':
        print('\n👋 掰掰')
        break

    elif choice == '0':
        print('\n▶ 全部執行')
        for _, _, fn in STEPS:
            fn()
        print()
        print('═' * 52)
        print('  全部完成！data.json 已更新')
        print('═' * 52)

    elif choice.isdigit() and 1 <= int(choice) <= len(STEPS):
        _, _, fn = STEPS[int(choice) - 1]
        fn()

    else:
        print(f'\n  ⚠  「{choice}」不是有效的選項')

    input('\n按 Enter 繼續...')
