#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""preview.py — 把生成好的 Tiled 棋盤畫成一張 PNG，一格一像素。

沒裝 Tiled 也能立刻看到結果對不對：河有沒有切開兩岸、橋在不在、
店家散得合不合理。純標準函式庫。

用法：
    python preview.py tpe-zhongshan            # 一格 1 px
    python preview.py tpe-zhongshan 3          # 一格 3 px（放大看細節）
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
# 明確把腳本目錄放進 sys.path。通常 Python 會自動加，但環境設了
# PYTHONSAFEPATH=1（3.11+）或以其他方式啟動時不會，同目錄的 import 就會失敗。
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import fetch_boundary   # noqa: E402  （必須在 sys.path 補好之後）
import tiled            # noqa: E402

REPO_ROOT = HERE.parent.parent


def render(board_id, scale=1):
    cfg = fetch_boundary.load_config()
    board = next((b for b in cfg['boards'] if b['id'] == board_id), None)
    if board is None:
        raise SystemExit(f'config.json 裡找不到 {board_id}')

    src = REPO_ROOT / board['out']
    with open(src, encoding='utf-8') as fh:
        tmap = json.load(fh)

    width, height = tmap['width'], tmap['height']
    terrain = next(l for l in tmap['layers'] if l['name'] == 'terrain')['data']
    palette = [rgba for _, _, rgba, _ in tiled.TERRAIN]

    rows = []
    for y in range(height):
        row = bytearray()
        base = y * width
        for x in range(width):
            gid = terrain[base + x]
            r, g, b, a = palette[gid - 1]
            row += bytes((r, g, b, a)) * scale
        for _ in range(scale):
            rows.append(bytes(row))

    out = src.with_name(src.stem + '-preview.png')
    tiled.write_png(out, width * scale, height * scale, rows)
    print(f'✓ {out}  ({width * scale} x {height * scale} px)')

    counts = {}
    for gid in terrain:
        counts[gid] = counts.get(gid, 0) + 1
    for gid, n in sorted(counts.items()):
        print(f'  {tiled.TERRAIN[gid - 1][1]:<6} {n:>8,}')
    return out


if __name__ == '__main__':
    render(sys.argv[1] if len(sys.argv) > 1 else 'tpe-zhongshan',
           int(sys.argv[2]) if len(sys.argv) > 2 else 1)
