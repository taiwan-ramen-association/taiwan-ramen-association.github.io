#!/usr/bin/env python
# -*- coding: utf-8 -*-
r"""regress.py — 棋盤回歸測試（離線、零外部依賴）。

每個 phase 改完都跑一次；任何一項 FAIL 就 exit 1。
檢查的是「遊戲意義上對不對」，不是「檔案跟上次一不一樣」——
data.json 更新讓棋盤改變是正常的，壞掉才不正常。

對 config.json 裡的每一張棋盤：
  ① 狀態   店家全是白名單內的營業狀態（includeStatuses）
  ② 落點   照棋盤自己的投影，應落在盤內的店一間都不能少、也不能多
  ③ 行政區 店家座標都在所屬行政區內（座標錯誤會讓店被擠到錯的地方）
  ④ 地形   店家所在格的地形是店家
  ⑤ 門口   每間店至少一個四鄰可通行的門口
  ⑥ 連通   全部店家互相走得到（從道路格做 BFS）
  ⑦ 預覽   預覽圖存在

通行性從 tileset 的 tile property 讀，與網頁端同一份真相，不寫死索引。

用法：
    python regress.py              # 全部棋盤
    python regress.py tpe-daan-3m  # 只測一張
    python regress.py --fixtures lab/game-world-3d/test/fixtures.json
                                   # 另外輸出每張棋盤的解碼摘要（尺寸、店家、各地形格數），
                                   # 給 3D 頁的 test/ 比對 JS 解碼結果與 Python 一致
"""
import array
import base64
import json
import sys
import zlib
from collections import Counter, deque
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import fetch_boundary  # noqa: E402
import gen_board       # noqa: E402

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

REPO_ROOT = HERE.parent.parent
DIRS = ((1, 0), (-1, 0), (0, 1), (0, -1))
CHECKS = ['狀態', '落點', '行政區', '地形', '門口', '連通', '預覽']


def decode_terrain(layer):
    if isinstance(layer['data'], list):
        return layer['data']
    raw = base64.b64decode(layer['data'])
    if layer.get('compression') == 'zlib':
        raw = zlib.decompress(raw)
    elif layer.get('compression'):
        raise ValueError('不支援的 compression: ' + layer['compression'])
    tiles = array.array('I')
    tiles.frombytes(raw)
    if sys.byteorder != 'little':
        tiles.byteswap()
    return tiles


def rings(geometry):
    if geometry['type'] == 'Polygon':
        return [geometry['coordinates'][0]]
    return [poly[0] for poly in geometry['coordinates']]


def inside(geometry, lat, lng):
    for ring in rings(geometry):
        hit = False
        for i in range(len(ring)):
            x1, y1 = ring[i][0], ring[i][1]
            x2, y2 = ring[i - 1][0], ring[i - 1][1]
            if (y1 > lat) != (y2 > lat) and lng < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
                hit = not hit
        if hit:
            return True
    return False


def check_board(cfg, board, boundary, rows_by_id):
    """回傳 (店數, {檢查名: (ok, 說明)}, 解碼摘要)。"""
    results = {}
    path = REPO_ROOT / board['out']
    tmap = json.loads(path.read_text(encoding='utf-8'))
    props = {p['name']: p['value'] for p in tmap['properties']}
    W, H = tmap['width'], tmap['height']
    cell = float(props['cellSize'])

    ts = tmap['tilesets'][0]
    first = ts['firstgid']
    passable_tile, terrain_of = {}, {}
    for t in ts['tiles']:
        p = {x['name']: x['value'] for x in t['properties']}
        passable_tile[t['id']] = bool(p.get('passable'))
        terrain_of[t['id']] = p.get('terrain')
    tiles = decode_terrain(next(l for l in tmap['layers'] if l['name'] == 'terrain'))
    if len(tiles) != W * H:
        results['地形'] = (False, f'地形格數 {len(tiles)} ≠ {W}x{H}')
        return 0, results, None
    passable = bytearray(passable_tile.get(g - first, False) for g in tiles)

    shops = []
    for o in next(l for l in tmap['layers'] if l['name'] == 'shops')['objects']:
        p = {x['name']: x['value'] for x in o['properties']}
        shops.append({'id': p['shopId'], 'name': o['name'], 'cx': int(p['cx']), 'cy': int(p['cy']),
                      'lat': float(p['lat']), 'lng': float(p['lng'])})

    # ① 狀態
    include = cfg.get('includeStatuses')
    exclude = cfg.get('excludeStatuses', [])
    bad = []
    for s in shops:
        st = (rows_by_id.get(s['id']) or {}).get('營業狀態')
        if (include is not None and st not in include) or st in exclude:
            bad.append(f"{s['id']} {s['name']}（{st}）")
    results['狀態'] = (not bad, '、'.join(bad))

    # ② 落點：用棋盤自己存的投影參數，算出該落在盤內的店
    o_lat, o_lng = props['originLat'], props['originLng']
    m_lat, m_lng = props['metersPerDegLat'], props['metersPerDegLng']
    want = {}
    for s in gen_board.load_shops(board['county'], board['town'], exclude, include):
        cx = int((s['lng'] - o_lng) * m_lng // cell)
        cy = int((o_lat - s['lat']) * m_lat // cell)
        if 0 <= cx < W and 0 <= cy < H:
            want[s['shop_id']] = s['name']
    have = {s['id'] for s in shops}
    missing = [f'{k} {v}' for k, v in want.items() if k not in have]
    extra = sorted(have - set(want))
    msg = ('少了：' + '、'.join(missing) if missing else '') + (' 多了：' + '、'.join(extra) if extra else '')
    results['落點'] = (not missing and not extra, msg.strip())

    # ③ 行政區
    feat = fetch_boundary.find_town(boundary, board['county'], board['town'])
    out = [f"{s['id']} {s['name']}" for s in shops if not inside(feat['geometry'], s['lat'], s['lng'])]
    results['行政區'] = (not out, '座標不在本區：' + '、'.join(out) if out else '')

    # ④ 地形
    wrong = [s['id'] for s in shops
             if terrain_of.get(tiles[s['cy'] * W + s['cx']] - first) not in ('shop', 'shop_coop')]
    results['地形'] = (not wrong, '店家格不是店家地形：' + '、'.join(wrong) if wrong else '')

    # ⑤ 門口
    doors = {}
    for s in shops:
        ds = []
        for ox, oy in DIRS:
            nx, ny = s['cx'] + ox, s['cy'] + oy
            if 0 <= nx < W and 0 <= ny < H and passable[ny * W + nx]:
                ds.append(ny * W + nx)
        doors[s['id']] = ds
    nodoor = [k for k, v in doors.items() if not v]
    results['門口'] = (not nodoor, '沒有門口：' + '、'.join(nodoor) if nodoor else '')

    # ⑥ 連通
    starts = next((v for v in doors.values() if v), None)
    if starts is None:
        results['連通'] = (False, '沒有任何門口可當起點')
    else:
        seen = bytearray(W * H)
        q = deque([starts[0]])
        seen[starts[0]] = 1
        while q:
            i = q.popleft()
            x, y = i % W, i // W
            for ox, oy in DIRS:
                nx, ny = x + ox, y + oy
                if 0 <= nx < W and 0 <= ny < H:
                    j = ny * W + nx
                    if passable[j] and not seen[j]:
                        seen[j] = 1
                        q.append(j)
        stranded = [k for k, v in doors.items() if v and not any(seen[d] for d in v)]
        results['連通'] = (not stranded, '走不到：' + '、'.join(stranded) if stranded else '')

    # ⑦ 預覽
    pv = REPO_ROOT / 'data' / 'boards' / f"{board['id']}-preview.png"
    results['預覽'] = (pv.exists(), '' if pv.exists() else f'缺 {pv.name}')

    summary = {
        'id': board['id'], 'W': W, 'H': H, 'cell': props['cellSize'],
        'county': props.get('county'), 'town': props.get('town'),
        'shops': sorted(s['id'] for s in shops),
        'terrainCounts': {terrain_of[g - first]: n for g, n in sorted(Counter(tiles).items())},
    }
    return len(shops), results, summary


def main():
    cfg = fetch_boundary.load_config()
    boundary = fetch_boundary.fetch()
    rows = json.loads((REPO_ROOT / 'data' / 'data.json').read_text(encoding='utf-8'))
    rows_by_id = {r.get('ID'): r for r in rows}
    args = sys.argv[1:]
    fixtures = None
    if '--fixtures' in args:
        i = args.index('--fixtures')
        fixtures = args[i + 1]
        del args[i:i + 2]
    only = args[0] if args else None

    print(f"\n{'棋盤':<22}{'店數':>4}  " + '  '.join(CHECKS))
    failed = []
    summaries = []
    for board in cfg['boards']:
        if only and board['id'] != only:
            continue
        try:
            n, res, summary = check_board(cfg, board, boundary, rows_by_id)
        except Exception as e:  # 檔案壞掉也算 FAIL，不要讓整支測試炸掉
            n, res, summary = 0, {k: (False, '') for k in CHECKS}, None
            res['狀態'] = (False, f'{type(e).__name__}: {e}')
        if summary:
            summaries.append(summary)
        marks = '  '.join(('✓' if res.get(k, (True, ''))[0] else '✗').center(len(k) * 2) for k in CHECKS)
        print(f"{board['id']:<22}{n:>4}  {marks}")
        for k in CHECKS:
            ok, why = res.get(k, (True, ''))
            if not ok:
                failed.append(f"{board['id']}｜{k}｜{why}")

    if fixtures:
        out = Path(fixtures)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps({'generatedBy': 'tools/board-gen/regress.py --fixtures', 'boards': summaries},
                                  ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
        print(f'\nfixtures → {out}（{len(summaries)} 張棋盤）')

    print()
    if failed:
        print(f'✗ FAIL {len(failed)} 項')
        for f in failed:
            print('   ' + f)
        sys.exit(1)
    print('✓ 全部通過')


if __name__ == '__main__':
    main()
