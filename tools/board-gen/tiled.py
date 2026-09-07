#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""tiled.py — 輸出 Tiled 地圖檔與佔位用的 tileset PNG（純標準函式庫）。

為什麼輸出 Tiled 格式而不是自訂 JSON：
    生成腳本算出來的通行性一定會有錯（水域圖資不完整、橋沒標到、巷子被切斷）。
    用 Tiled 當格式，這些錯可以在 Tiled 裡用滑鼠改掉，不必回頭改程式；
    要在某條巷子埋彩蛋、放寶箱，也只是在 Tiled 上點一點。
    「程式生成」與「人工潤飾」因此不必二選一。

通行性放在 tileset 的 tile property（不是另開一層）：
    這樣在 Tiled 裡把一格從「水」改成「橋」，通行性就跟著變，
    不會出現「畫面看起來是橋、資料還是水」的兩份真相。
"""

import json
import struct
import zlib

# ── 地形種類（index 即 tileset 內的 tile id，gid = id + firstgid）─────────────

# 只有「道路」可以走。陸地、水域、橋樑都是風景——看得到、走不上去。
# 這是刻意的：玩家在店與店之間有明確的幾條路可選，而不是在一整片平原上亂走。
# 店家格本身也不可通行，玩家停在相鄰的道路格上，那就是「店門口」。
TERRAIN = [
    # (key,          名稱,        RGBA 佔位色,           可通行)
    ('outside',     '區外',       (32, 34, 38, 255),    False),
    ('land',        '陸地',       (222, 216, 200, 255), False),
    ('water',       '水域',       (74, 144, 196, 255),  False),
    ('bridge',      '橋樑',       (150, 105, 62, 255),  False),
    ('road',        '道路',       (120, 110, 96, 255),  True),
    ('road_bridge', '過河道路',   (162, 116, 70, 255),  True),
    ('shop',        '店家',       (214, 69, 65, 255),   False),
    ('shop_coop',   '合作店家',   (232, 176, 58, 255),  False),
]

# 可通行的地形（給生成腳本與驗證共用，避免各自寫死索引）
ROAD_KEYS = ('road', 'road_bridge')
SHOP_KEYS = ('shop', 'shop_coop')

TERRAIN_INDEX = {key: i for i, (key, _, _, _) in enumerate(TERRAIN)}
TILE_PX = 32


# ── 最小 PNG 寫出器 ──────────────────────────────────────────────────────────


def _png_chunk(tag, data):
    return (struct.pack('>I', len(data)) + tag + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path, width, height, pixel_rows):
    """寫出 8-bit RGBA PNG。pixel_rows 是每列的 bytes（長度 width*4）。

    自己寫是為了不引入 Pillow —— 佔位圖只有純色方塊，不值得為它多一個依賴。
    """
    raw = b''.join(b'\x00' + row for row in pixel_rows)   # filter type 0
    png = (b'\x89PNG\r\n\x1a\n'
           + _png_chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
           + _png_chunk(b'IDAT', zlib.compress(raw, 9))
           + _png_chunk(b'IEND', b''))
    with open(path, 'wb') as fh:
        fh.write(png)


def write_placeholder_tileset(path):
    """產生一張橫向排列的佔位 tileset（每種地形一格純色，右下角加深當格線）。

    M1 刻意用色塊驗證機制，所以這張圖是「正式素材進來之前的暫時品」。
    換成 OpenGameArt 的 tileset 時，只要圖的格數與順序一致，
    地圖檔完全不用重生。
    """
    cols = len(TERRAIN)
    width = cols * TILE_PX
    rows = []
    for y in range(TILE_PX):
        row = bytearray()
        for i, (_, _, rgba, _) in enumerate(TERRAIN):
            r, g, b, a = rgba
            for x in range(TILE_PX):
                edge = (x == TILE_PX - 1) or (y == TILE_PX - 1)
                if edge:
                    row += bytes((max(r - 30, 0), max(g - 30, 0), max(b - 30, 0), a))
                else:
                    row += bytes((r, g, b, a))
        rows.append(bytes(row))
    write_png(path, width, TILE_PX, rows)
    return width, TILE_PX


# ── Tiled 地圖 ───────────────────────────────────────────────────────────────


def _tileset(image_name, image_w, image_h):
    tiles = []
    for i, (key, name, _, passable) in enumerate(TERRAIN):
        tiles.append({
            'id': i,
            'properties': [
                {'name': 'terrain', 'type': 'string', 'value': key},
                {'name': 'label', 'type': 'string', 'value': name},
                {'name': 'passable', 'type': 'bool', 'value': passable},
            ],
        })
    return {
        'firstgid': 1,
        'name': 'ramen-placeholder',
        'image': image_name,
        'imagewidth': image_w,
        'imageheight': image_h,
        'tilewidth': TILE_PX,
        'tileheight': TILE_PX,
        'tilecount': len(TERRAIN),
        'columns': len(TERRAIN),
        'margin': 0,
        'spacing': 0,
        'tiles': tiles,
    }


def build_map(terrain, width, height, shops, meta, image_name, image_size):
    """組出 Tiled JSON（orthogonal / right-down / finite）。

    terrain : bytearray，每格存 TERRAIN 的 index
    shops   : list of dict，見 gen_board.py
    meta    : 寫進 map properties 的欄位（cellSize、原點經緯度、生成時間…）
    """
    data = [t + 1 for t in terrain]           # gid = index + firstgid

    objects = []
    for i, shop in enumerate(shops, start=1):
        objects.append({
            'id': i,
            'name': shop['name'],
            'type': 'shop',
            'x': shop['cx'] * TILE_PX,
            'y': shop['cy'] * TILE_PX,
            'width': TILE_PX,
            'height': TILE_PX,
            'visible': True,
            'rotation': 0,
            'properties': [
                {'name': 'shopId', 'type': 'string', 'value': shop['shop_id']},
                {'name': 'cx', 'type': 'int', 'value': shop['cx']},
                {'name': 'cy', 'type': 'int', 'value': shop['cy']},
                {'name': 'lat', 'type': 'float', 'value': shop['lat']},
                {'name': 'lng', 'type': 'float', 'value': shop['lng']},
                {'name': 'moved', 'type': 'bool', 'value': shop['moved']},
                {'name': 'status', 'type': 'string', 'value': shop['status']},
                # 門口格：與店家相鄰且是道路的格子。玩家站在這裡才叫「在店門口」。
                # 寫進檔案是為了讓 Tiled 上看得到，遊戲端仍會自己從地形推算，
                # 這樣你在 Tiled 裡改了路，門口會跟著變，不會有兩份真相。
                {'name': 'doors', 'type': 'string',
                 'value': ';'.join(f'{d[0]},{d[1]}' for d in shop.get('doors', []))},
            ],
        })

    return {
        'type': 'map',
        'version': '1.10',
        'tiledversion': '1.10.2',
        'orientation': 'orthogonal',
        'renderorder': 'right-down',
        'infinite': False,
        'width': width,
        'height': height,
        'tilewidth': TILE_PX,
        'tileheight': TILE_PX,
        'nextlayerid': 3,
        'nextobjectid': len(objects) + 1,
        'properties': [
            {'name': k,
             'type': ('int' if isinstance(v, int) and not isinstance(v, bool)
                      else 'float' if isinstance(v, float)
                      else 'bool' if isinstance(v, bool)
                      else 'string'),
             'value': v}
            for k, v in meta.items()
        ],
        'tilesets': [_tileset(image_name, image_size[0], image_size[1])],
        'layers': [
            {
                'id': 1,
                'type': 'tilelayer',
                'name': 'terrain',
                'width': width,
                'height': height,
                'x': 0,
                'y': 0,
                'opacity': 1,
                'visible': True,
                'data': data,
            },
            {
                'id': 2,
                'type': 'objectgroup',
                'name': 'shops',
                'draworder': 'topdown',
                'x': 0,
                'y': 0,
                'opacity': 1,
                'visible': True,
                'objects': objects,
            },
        ],
    }


def save_map(path, tiled_map):
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(tiled_map, fh, ensure_ascii=False, separators=(',', ':'))
