import json
import os
import re
import subprocess
import sys

# 安裝需要的套件
def install(pkg):
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', pkg, '-q'])

try:
    import openpyxl
except ImportError:
    print('安裝 openpyxl 中...')
    install('openpyxl')
    import openpyxl

# ── 地址解析 ──────────────────────────────────────────────────────────────────
def parse_city_district(addr):
    """從地址拆出縣市與鄉鎮市區，例：臺北市士林區大北路9號 → ('臺北市', '士林區')"""
    m = re.match(r'^(.{2,3}[市縣])(.{2,4}[區市鎮鄉])', addr)
    if m:
        return m.group(1), m.group(2)
    return '', ''

# ── 路徑設定 ──────────────────────────────────────────────────────────────────
script_dir = os.path.dirname(os.path.abspath(__name__))
json_path  = os.path.join(script_dir, 'data.json')
xlsx_path  = os.path.join(script_dir, 'data.xlsx')

# ── 讀取 JSON ─────────────────────────────────────────────────────────────────
print('📂 讀取 data.json...')
with open(json_path, 'r', encoding='utf-8') as f:
    rows = json.load(f)

if not rows:
    print('❌ data.json 是空的')
    input('按 Enter 關閉...')
    sys.exit(1)

# 若縣市或鄉鎮市區為空，自動從地址解析
for row in rows:
    if not row.get('縣市', '').strip() or not row.get('鄉鎮市區', '').strip():
        city, district = parse_city_district(row.get('地址', ''))
        if not row.get('縣市', '').strip():
            row['縣市'] = city
        if not row.get('鄉鎮市區', '').strip():
            row['鄉鎮市區'] = district

# ── 星期排序正規化 ─────────────────────────────────────────────────────────────
DAY_ORDER = {'一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7}
DAY_FIELDS = {'營業日', '店休日'}

def normalize_days(value):
    """將逗號分隔的星期字串排序為一二三四五六日順序"""
    if not value or not isinstance(value, str):
        return value
    parts = [p.strip() for p in value.split(',')]
    # 若任一部分不在 DAY_ORDER，視為非星期格式，原樣返回
    if not all(p in DAY_ORDER for p in parts if p):
        return value
    parts_sorted = sorted(parts, key=lambda d: DAY_ORDER.get(d, 99))
    return ', '.join(parts_sorted)

# ── 寫入 Excel ────────────────────────────────────────────────────────────────
wb = openpyxl.Workbook()
ws = wb.active
ws.title = '店家資料'

headers = list(rows[0].keys())

# 標題列樣式
from openpyxl.styles import PatternFill, Font, Alignment
header_fill = PatternFill(start_color='C8272D', end_color='C8272D', fill_type='solid')
header_font = Font(color='FFFFFF', bold=True, size=11)

for col_idx, h in enumerate(headers, 1):
    cell = ws.cell(row=1, column=col_idx, value=h)
    cell.fill   = header_fill
    cell.font   = header_font
    cell.alignment = Alignment(horizontal='center', vertical='center')

# 資料列
for row_idx, row in enumerate(rows, 2):
    for col_idx, h in enumerate(headers, 1):
        val = row.get(h, '')
        if h in DAY_FIELDS:
            val = normalize_days(val)
        ws.cell(row=row_idx, column=col_idx, value=val)

# 凍結第一列
ws.freeze_panes = 'A2'

# 自動調整欄寬（最大 40）
for col in ws.columns:
    max_len = max((len(str(cell.value or '')) for cell in col), default=0)
    ws.column_dimensions[col[0].column_letter].width = min(max_len + 2, 40)

wb.save(xlsx_path)
print(f'✅ 完成！已產生 data.xlsx（共 {len(rows)} 筆）')
print(f'📍 檔案位置：{xlsx_path}')
print()
print('👉 請用 Excel 開啟 data.xlsx 進行編輯')
print('👉 編輯完存檔後，執行 excel_to_json.py 轉回 JSON')
print()
input('按 Enter 關閉...')
