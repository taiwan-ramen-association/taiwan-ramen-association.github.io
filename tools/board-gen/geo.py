#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""geo.py — 座標投影與多邊形／線段的格子化（純標準函式庫，零外部依賴）。

為什麼不用 shapely / pyproj：
    棋盤生成是一支離線工具，會在不同人的機器上跑（Windows + PyCharm）。
    多一個需要編譯的套件就多一次「跑不起來」的機會。這裡用到的幾何運算只有
    「多邊形填色」和「線段畫線」兩種，掃描線 + Bresenham 就夠，且比逐格
    point-in-polygon 快兩個數量級（O(列數 x 邊數) vs O(格數 x 邊數)）。

投影：
    以行政區中心為原點的等距圓柱近似。台灣一個鄉鎮市區跨度不超過數十公里，
    在這個尺度下誤差遠小於 25 公尺的格子，不需要 TWD97。
"""

import math

# ── 投影 ─────────────────────────────────────────────────────────────────────


def meters_per_degree(lat_deg):
    """回傳該緯度上「一度緯度」與「一度經度」各是幾公尺。

    用 WGS84 的級數展開，比固定值 111320 準（在台灣約差 0.2%）。
    """
    phi = math.radians(lat_deg)
    m_lat = 111132.92 - 559.82 * math.cos(2 * phi) + 1.175 * math.cos(4 * phi)
    m_lng = 111412.84 * math.cos(phi) - 93.5 * math.cos(3 * phi)
    return m_lat, m_lng


class Projection:
    """經緯度 <-> 公尺平面 <-> 格子座標。

    格子座標 (cx, cy)：cx 向東遞增、cy 向南遞增，原點在棋盤左上（西北）角。
    向南遞增是為了對齊 Tiled 的 render order（right-down），省掉輸出時翻轉。
    """

    def __init__(self, lat0, lng0, cell_size, origin_lat, origin_lng):
        self.lat0 = lat0                      # 投影參考緯度（區中心）
        self.lng0 = lng0
        self.m_lat, self.m_lng = meters_per_degree(lat0)
        self.cell = float(cell_size)
        self.origin_lat = origin_lat          # 棋盤西北角
        self.origin_lng = origin_lng

    def to_xy(self, lat, lng):
        """經緯度 → 以棋盤西北角為原點的公尺座標（x 東、y 南）。"""
        x = (lng - self.origin_lng) * self.m_lng
        y = (self.origin_lat - lat) * self.m_lat
        return x, y

    def to_cell(self, lat, lng):
        """經緯度 → 格子索引（整數）。"""
        x, y = self.to_xy(lat, lng)
        return int(math.floor(x / self.cell)), int(math.floor(y / self.cell))

    def cell_center_latlng(self, cx, cy):
        """格子索引 → 該格中心的經緯度（寫回 Tiled 屬性用）。"""
        x = (cx + 0.5) * self.cell
        y = (cy + 0.5) * self.cell
        lng = self.origin_lng + x / self.m_lng
        lat = self.origin_lat - y / self.m_lat
        return lat, lng


# ── GeoJSON 幾何走訪 ─────────────────────────────────────────────────────────


def iter_rings(geometry):
    """走訪 Polygon / MultiPolygon 的所有 ring，逐一 yield 座標串。

    外環與內環（洞）一視同仁地 yield —— 掃描線用 even-odd 規則填色，
    洞會自然被扣掉，不需要分辨誰是誰。
    """
    gtype = geometry.get('type')
    coords = geometry.get('coordinates') or []
    if gtype == 'Polygon':
        for ring in coords:
            yield ring
    elif gtype == 'MultiPolygon':
        for poly in coords:
            for ring in poly:
                yield ring
    elif gtype == 'GeometryCollection':
        for g in geometry.get('geometries', []):
            for ring in iter_rings(g):
                yield ring


def iter_lines(geometry):
    """走訪 LineString / MultiLineString，逐一 yield 座標串（橋樑用）。"""
    gtype = geometry.get('type')
    coords = geometry.get('coordinates') or []
    if gtype == 'LineString':
        yield coords
    elif gtype == 'MultiLineString':
        for line in coords:
            yield line
    elif gtype == 'GeometryCollection':
        for g in geometry.get('geometries', []):
            for line in iter_lines(g):
                yield line


def geometry_bounds(geometry):
    """回傳 (min_lat, min_lng, max_lat, max_lng)。"""
    lats, lngs = [], []

    def walk(node):
        if isinstance(node, (list, tuple)):
            if len(node) >= 2 and all(isinstance(v, (int, float)) for v in node[:2]):
                lngs.append(node[0])
                lats.append(node[1])
            else:
                for child in node:
                    walk(child)

    walk(geometry.get('coordinates', []))
    if not lats:
        raise ValueError('geometry 沒有任何座標')
    return min(lats), min(lngs), max(lats), max(lngs)


# ── 掃描線多邊形填色 ─────────────────────────────────────────────────────────


def rasterize_rings(rings, proj, width, height, out, value):
    """把一組 ring 用 even-odd 掃描線填進 out（bytearray，長度 width*height）。

    以每一列格子的「中心 y」去和所有邊求交點，交點排序後成對填色。
    這是標準的 scanline fill；用格子中心而非格線，可避免邊界上的格子忽有忽無。
    """
    edges = []          # (y0, y1, x_at_y0, slope_dx_dy)
    for ring in rings:
        pts = [proj.to_xy(pt[1], pt[0]) for pt in ring]
        n = len(pts)
        for i in range(n):
            x0, y0 = pts[i]
            x1, y1 = pts[(i + 1) % n]
            if y0 == y1:
                continue                      # 水平邊對掃描線沒有貢獻
            if y0 > y1:
                x0, y0, x1, y1 = x1, y1, x0, y0
            edges.append((y0, y1, x0, (x1 - x0) / (y1 - y0)))

    if not edges:
        return

    cell = proj.cell
    for row in range(height):
        yc = (row + 0.5) * cell
        xs = []
        for y0, y1, x0, slope in edges:
            # 半開區間 [y0, y1)：避免頂點被算兩次而讓填色反轉
            if y0 <= yc < y1:
                xs.append(x0 + (yc - y0) * slope)
        if not xs:
            continue
        xs.sort()
        base = row * width
        for i in range(0, len(xs) - 1, 2):
            c0 = int(math.floor(xs[i] / cell))
            c1 = int(math.floor(xs[i + 1] / cell))
            if c1 < 0 or c0 >= width:
                continue
            c0 = max(c0, 0)
            c1 = min(c1, width - 1)
            for col in range(c0, c1 + 1):
                out[base + col] = value


def rasterize_line(line, proj, width, height, out, value, radius=1):
    """把一條折線畫進 out（橋樑用）。radius 是筆刷半徑（格）。

    橋在 OSM 是 way（線）不是面，光靠水域填色會把橋一起淹掉，
    所以橋要在水域之後疊上來，且要有寬度——寬度 0 的橋在格子上會被
    對角線切斷，A* 走不過去。
    """
    pts = [proj.to_cell(pt[1], pt[0]) for pt in line]
    for i in range(len(pts) - 1):
        _draw_segment(pts[i], pts[i + 1], width, height, out, value, radius)


def _draw_segment(p0, p1, width, height, out, value, radius):
    x0, y0 = p0
    x1, y1 = p1
    dx = abs(x1 - x0)
    dy = -abs(y1 - y0)
    sx = 1 if x0 < x1 else -1
    sy = 1 if y0 < y1 else -1
    err = dx + dy
    while True:
        for ox in range(-radius, radius + 1):
            for oy in range(-radius, radius + 1):
                cx, cy = x0 + ox, y0 + oy
                if 0 <= cx < width and 0 <= cy < height:
                    out[cy * width + cx] = value
        if x0 == x1 and y0 == y1:
            break
        e2 = 2 * err
        if e2 >= dy:
            err += dy
            x0 += sx
        if e2 <= dx:
            err += dx
            y0 += sy


# ── 連通性 ───────────────────────────────────────────────────────────────────


def flood_fill_reachable(passable, width, height, start):
    """從 start 出發，回傳所有走得到的格子索引集合（4 向連通）。

    用途是驗證：生成完的棋盤如果有店家落在走不到的孤島（例如水域把它圍住、
    或橋沒被正確標記），必須在生成階段就發現，不能等玩家卡住才知道。
    """
    sx, sy = start
    if not (0 <= sx < width and 0 <= sy < height):
        return set()
    start_idx = sy * width + sx
    if not passable[start_idx]:
        return set()

    seen = {start_idx}
    stack = [start_idx]
    while stack:
        idx = stack.pop()
        cy, cx = divmod(idx, width)
        if cx > 0:
            n = idx - 1
            if passable[n] and n not in seen:
                seen.add(n)
                stack.append(n)
        if cx < width - 1:
            n = idx + 1
            if passable[n] and n not in seen:
                seen.add(n)
                stack.append(n)
        if cy > 0:
            n = idx - width
            if passable[n] and n not in seen:
                seen.add(n)
                stack.append(n)
        if cy < height - 1:
            n = idx + width
            if passable[n] and n not in seen:
                seen.add(n)
                stack.append(n)
    return seen


def nearest_free_cell(taken, passable, width, height, start):
    """從 start 開始向外找第一個「可通行且尚未被占用」的格子。

    店家座標密集時兩間店會落在同一格（中山區 25m 下有 1 例），
    往鄰近空格擠開；同時也處理店家座標剛好落在水裡的情形。
    """
    sx, sy = start
    seen = set()
    queue = [(sx, sy)]
    seen.add((sx, sy))
    head = 0
    while head < len(queue):
        cx, cy = queue[head]
        head += 1
        if 0 <= cx < width and 0 <= cy < height:
            idx = cy * width + cx
            if passable[idx] and idx not in taken:
                return cx, cy
        for ox, oy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nxt = (cx + ox, cy + oy)
            if nxt in seen:
                continue
            # 只在合理範圍內擴散，避免座標錯誤的店家把搜尋拖垮
            if abs(nxt[0] - sx) > 200 or abs(nxt[1] - sy) > 200:
                continue
            seen.add(nxt)
            queue.append(nxt)
    return None
