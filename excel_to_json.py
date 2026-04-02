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
    m = re.match(r'^(.{2,3}[市縣])(.{1,4}?[區市鎮鄉])(?![區市鎮鄉])', addr)
    if m:
        return m.group(1), m.group(2)
    return '', ''

# ── 路徑設定 ──────────────────────────────────────────────────────────────────
script_dir = os.path.dirname(os.path.abspath(__file__))
xlsx_path  = os.path.join(script_dir, 'data.xlsx')
json_path  = os.path.join(script_dir, 'data.json')

# ── 檢查檔案存在 ──────────────────────────────────────────────────────────────
if not os.path.exists(xlsx_path):
    print('❌ 找不到 data.xlsx，請先執行 json_to_excel.py')
    input('按 Enter 關閉...')
    sys.exit(1)

# ── 讀取 Excel ────────────────────────────────────────────────────────────────
print('📂 讀取 data.xlsx...')
wb = openpyxl.load_workbook(xlsx_path)
ws = wb.active

rows_raw = list(ws.values)
if not rows_raw:
    print('❌ Excel 是空的')
    input('按 Enter 關閉...')
    sys.exit(1)

headers = [str(h).strip() for h in rows_raw[0]]

rows = []
for row in rows_raw[1:]:
    # 跳過完全空白的列
    if all((v is None or str(v).strip() == '') for v in row):
        continue
    obj = {}
    for i, h in enumerate(headers):
        val = row[i] if i < len(row) else ''
        # None 轉空字串，數字保留
        if val is None:
            val = ''
        else:
            val = str(val).strip()
            # 移除 Excel 自動加的 .0（例如 7.0 → 7）
            if val.endswith('.0') and val[:-2].lstrip('-').isdigit():
                val = val[:-2]
        obj[h] = val
    if obj.get('店名', '').strip():  # 只保留有店名的列
        # 若縣市或鄉鎮市區為空，自動從地址解析
        if not obj.get('縣市', '').strip() or not obj.get('鄉鎮市區', '').strip():
            city, district = parse_city_district(obj.get('地址', ''))
            if not obj.get('縣市', '').strip():
                obj['縣市'] = city
            if not obj.get('鄉鎮市區', '').strip():
                obj['鄉鎮市區'] = district
        rows.append(obj)

# ── 寫回 JSON ─────────────────────────────────────────────────────────────────
with open(json_path, 'w', encoding='utf-8') as f:
    json.dump(rows, f, ensure_ascii=False, indent=2)

print(f'✅ 完成！已更新 data.json（共 {len(rows)} 筆）')
print(f'📍 檔案位置：{json_path}')
print()
print('👉 接下來執行以下指令推上 GitHub：')
print()
print('   git add data.json')
print('   git commit -m "更新店家資料"')
print('   git push')
print()
input('按 Enter 關閉...')
