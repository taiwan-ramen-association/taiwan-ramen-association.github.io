#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""fetch_boundary.py — 下載鄉鎮市區邊界 GeoJSON 並快取。

資料來源與 domination.html 用的同一份（ronnywang/twgeojson），
制霸地圖與遊戲棋盤因此吃同一組行政區界，不會出現「制霸算你走過、
棋盤卻說你不在這區」的分歧。

用法：
    python fetch_boundary.py            # 沒快取才下載
    python fetch_boundary.py --force    # 強制重抓
"""

import json
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE_DIR = HERE / 'cache'
CACHE_FILE = CACHE_DIR / 'twtown2010.json'


def load_config():
    with open(HERE / 'config.json', encoding='utf-8') as fh:
        return json.load(fh)


def fetch(force=False):
    cfg = load_config()
    CACHE_DIR.mkdir(exist_ok=True)

    if CACHE_FILE.exists() and not force:
        print(f'[boundary] 使用快取 {CACHE_FILE}')
        with open(CACHE_FILE, encoding='utf-8') as fh:
            return json.load(fh)

    url = cfg['boundarySource']
    print(f'[boundary] 下載 {url}')
    with urllib.request.urlopen(url, timeout=300) as resp:
        raw = resp.read()
    data = json.loads(raw.decode('utf-8'))

    with open(CACHE_FILE, 'w', encoding='utf-8') as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(',', ':'))
    print(f'[boundary] 已快取 {len(raw):,} bytes → {CACHE_FILE}')
    return data


def find_town(geo, county, town):
    """在 FeatureCollection 裡找出指定的鄉鎮市區。

    county 需完整比對——「中山區」在臺北市與基隆市都有，只比 town 會抓錯。
    """
    for feat in geo['features']:
        props = feat.get('properties', {})
        if props.get('county') == county and props.get('town') == town:
            return feat
    raise SystemExit(f'找不到 {county}{town}；請確認寫法（例如「臺北市」不是「台北市」）')


if __name__ == '__main__':
    fetch(force='--force' in sys.argv)
