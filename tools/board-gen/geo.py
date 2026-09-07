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


def rasterize_line(line, proj, width, height, out, value, radius=1, only_over=None):
    """把一條折線畫進 out（橋樑用）。radius 是筆刷半徑（格）。

    橋在 OSM 是 way（線）不是面，光靠水域填色會把橋一起淹掉，
    所以橋要在水域之後疊上來，且要有寬度——寬度 0 的橋在格子上會被
    對角線切斷，A* 走不過去。

    only_over：限定「原本是這些地形」的格子才會被覆蓋。
        畫橋時傳水域，因為 OSM 的 bridge=yes 涵蓋所有高架道路
        （中山區 bbox 內就有 882 條，建國高架、市民大道、捷運高架全算），
        而蓋在陸地上方的高架橋對通行性毫無意義——底下本來就能走。
        只讓橋在穿過水面時存在，語意才對，畫面也才不會被高架網糊掉。
    """
    pts = [proj.to_cell(pt[1], pt[0]) for pt in line]
    for i in range(len(pts) - 1):
        _draw_segment(pts[i], pts[i + 1], width, height, out, value, radius, only_over)


def _draw_segment(p0, p1, width, height, out, value, radius, only_over=None):
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
                    idx = cy * width + cx
                    if only_over is None or out[idx] in only_over:
                        out[idx] = value
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


# ── 路網 ─────────────────────────────────────────────────────────────────────


def delaunay_edges(points):
    """Bowyer-Watson 三角化，回傳去重後的邊 [(i, j), ...]。

    為什麼用 Delaunay 而不是「每間店連最近的 k 間」：
        kNN 會產生交叉的連線，畫成走廊之後看起來像亂麻。Delaunay 是平面圖，
        連出來的網天生不交叉，長得像一張「合理的路網」而不是蜘蛛網。

    純標準函式庫（40 個點的規模，O(n²) 完全夠用）。
    """
    n = len(points)
    if n < 2:
        return []
    if n == 2:
        return [(0, 1)]

    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    span = max(max(xs) - min(xs), max(ys) - min(ys)) or 1.0

    # 超級三角形：大到把所有點包住，最後再把碰到它的三角形丟掉
    big = span * 20
    pts = list(points) + [(cx - big, cy - big), (cx + big, cy - big), (cx, cy + big)]
    tris = [(n, n + 1, n + 2)]

    def circumcircle(a, b, c):
        ax, ay = pts[a]; bx, by = pts[b]; cx_, cy_ = pts[c]
        d = 2 * (ax * (by - cy_) + bx * (cy_ - ay) + cx_ * (ay - by))
        if abs(d) < 1e-12:
            return None
        ux = ((ax*ax + ay*ay) * (by - cy_) + (bx*bx + by*by) * (cy_ - ay)
              + (cx_*cx_ + cy_*cy_) * (ay - by)) / d
        uy = ((ax*ax + ay*ay) * (cx_ - bx) + (bx*bx + by*by) * (ax - cx_)
              + (cx_*cx_ + cy_*cy_) * (bx - ax)) / d
        return ux, uy, (ux - ax) ** 2 + (uy - ay) ** 2

    for i in range(n):
        px, py = pts[i]
        bad = []
        for t in tris:
            cc = circumcircle(*t)
            if cc and (px - cc[0]) ** 2 + (py - cc[1]) ** 2 < cc[2] - 1e-9:
                bad.append(t)
        # 壞三角形的邊界（只出現一次的邊）就是要重新連到新點的洞
        counts = {}
        for t in bad:
            for e in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
                key = (min(e), max(e))
                counts[key] = counts.get(key, 0) + 1
        for t in bad:
            tris.remove(t)
        for (a, b), cnt in counts.items():
            if cnt == 1:
                tris.append((a, b, i))

    edges = set()
    for t in tris:
        if any(v >= n for v in t):       # 碰到超級三角形的丟掉
            continue
        for a, b in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
            edges.add((min(a, b), max(a, b)))
    return sorted(edges)


def astar_path(passable, width, height, start, goal):
    """4 向 A*，回傳格子索引串（含頭尾），走不到回 None。

    走廊就是靠這支連出來的：它走的是「建置期通行圖」（陸地+橋可走），
    所以連線會自動避開水面、自動繞到橋上——不需要任何「過橋」特例。
    """
    import heapq
    sx, sy = start
    gx, gy = goal
    s = sy * width + sx
    g = gy * width + gx
    if not passable[s] or not passable[g]:
        return None
    if s == g:
        return [s]

    dist = {s: 0}
    prev = {s: -1}
    heap = [(abs(sx - gx) + abs(sy - gy), s)]
    while heap:
        _, cur = heapq.heappop(heap)
        if cur == g:
            break
        cy, cx = divmod(cur, width)
        base = dist[cur] + 1
        for ox, oy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = cx + ox, cy + oy
            if not (0 <= nx < width and 0 <= ny < height):
                continue
            nxt = ny * width + nx
            if not passable[nxt] or dist.get(nxt, 1 << 30) <= base:
                continue
            dist[nxt] = base
            prev[nxt] = cur
            heapq.heappush(heap, (base + abs(nx - gx) + abs(ny - gy), nxt))

    if g not in prev:
        return None
    path = []
    node = g
    while node != -1:
        path.append(node)
        node = prev[node]
    return path[::-1]


def mst_and_extras(nodes, edges, extra):
    """Kruskal 最小生成樹 + 額外邊。

    MST 保證「任兩店之間恰好一條路」；再把剩下最短的 `extra` 條邊加回去，
    就會長出環路，出現兩三條替代路線。extra=0 就是純樹狀，沒有任何替代道路。
    edges 是 [(w, i, j), ...]。
    """
    parent = list(range(nodes))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    chosen, rest = [], []
    for w, i, j in sorted(edges):
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[ri] = rj
            chosen.append((w, i, j))
        else:
            rest.append((w, i, j))
    return chosen + rest[:max(0, extra)]
