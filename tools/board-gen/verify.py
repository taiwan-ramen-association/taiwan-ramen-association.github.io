#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""verify.py — 驗證生成好的棋盤在遊戲意義上是對的。

只看預覽圖「看起來像」不夠。這支實際跑 A\*，回答三個問題：

  1. **拆掉所有橋之後，棋盤會裂成幾塊？** 河如果沒真的切開兩岸，
     地理感就是假的——大直的店會變成走幾步就到。
  2. **繞路後的距離比直線遠多少？** 「大直很遠」必須是算出來的。
  3. **最遠的兩間店要走多久？** 直接換算成遊戲內時間，用來校準
     speedMultiplier（熱參數，預設 3）。

這支同時是網頁端 A\* 的參考實作：兩邊必須走出同樣的路徑，
不然玩家看到的距離和伺服器算的抵達時間會對不上。

用法：
    python verify.py tpe-zhongshan
"""

import heapq
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import fetch_boundary   # noqa: E402
import geo              # noqa: E402
import tiled            # noqa: E402

REPO_ROOT = HERE.parent.parent

# 4 向移動。刻意不開對角線：對角線在格子地圖上會讓「貼著水岸斜切」變成捷徑，
# 玩家會看到角色斜穿過河堤。要改成 8 向的話，網頁端 A* 必須同步改。
NEIGHBOURS = ((1, 0), (-1, 0), (0, 1), (0, -1))


def load_board(board_id):
    cfg = fetch_boundary.load_config()
    board = next((b for b in cfg['boards'] if b['id'] == board_id), None)
    if board is None:
        raise SystemExit(f'config.json 裡找不到 {board_id}')
    with open(REPO_ROOT / board['out'], encoding='utf-8') as fh:
        return json.load(fh)


def board_arrays(tmap, drop_bridges=False):
    """回傳 (passable bytearray, width, height)。

    drop_bridges=True 時把橋當成水，用來檢驗「沒有橋的話會不會斷」。
    """
    width, height = tmap['width'], tmap['height']
    terrain = next(l for l in tmap['layers'] if l['name'] == 'terrain')['data']
    bridge_idx = tiled.TERRAIN_INDEX['bridge']
    passable = bytearray(width * height)
    for i, gid in enumerate(terrain):
        idx = gid - 1
        if drop_bridges and idx == bridge_idx:
            passable[i] = 0
        else:
            passable[i] = 1 if tiled.TERRAIN[idx][3] else 0
    return passable, width, height


def astar(passable, width, height, start, goal):
    """回傳步數（格），走不到回 None。曼哈頓距離當 heuristic，4 向下是 admissible。"""
    sx, sy = start
    gx, gy = goal
    start_i = sy * width + sx
    goal_i = gy * width + gx
    if not passable[start_i] or not passable[goal_i]:
        return None

    dist = {start_i: 0}
    heap = [(abs(sx - gx) + abs(sy - gy), start_i)]
    while heap:
        _, cur = heapq.heappop(heap)
        if cur == goal_i:
            return dist[cur]
        cy, cx = divmod(cur, width)
        base = dist[cur] + 1
        for ox, oy in NEIGHBOURS:
            nx, ny = cx + ox, cy + oy
            if not (0 <= nx < width and 0 <= ny < height):
                continue
            nxt = ny * width + nx
            if not passable[nxt] or dist.get(nxt, 1 << 30) <= base:
                continue
            dist[nxt] = base
            heapq.heappush(heap, (base + abs(nx - gx) + abs(ny - gy), nxt))
    return None


def bfs_field(passable, width, height, start):
    """從 start 做 BFS，回傳 {格子索引: 步數}。

    要算 N 間店兩兩的距離時，跑 N 次 BFS（每次掃全圖一遍）遠比跑 N²/2 次 A* 便宜。
    """
    sx, sy = start
    start_i = sy * width + sx
    if not passable[start_i]:
        return {}
    dist = {start_i: 0}
    queue = [start_i]
    head = 0
    while head < len(queue):
        cur = queue[head]
        head += 1
        base = dist[cur] + 1
        cy, cx = divmod(cur, width)
        for ox, oy in NEIGHBOURS:
            nx, ny = cx + ox, cy + oy
            if not (0 <= nx < width and 0 <= ny < height):
                continue
            nxt = ny * width + nx
            if passable[nxt] and nxt not in dist:
                dist[nxt] = base
                queue.append(nxt)
    return dist


def components(passable, width, height, seeds):
    """把 seeds 依連通性分組，回傳 list of list（大的在前）。"""
    groups = []
    unassigned = list(seeds)
    while unassigned:
        head = unassigned[0]
        reach = geo.flood_fill_reachable(passable, width, height, (head['cx'], head['cy']))
        group = [s for s in unassigned if (s['cy'] * width + s['cx']) in reach]
        unassigned = [s for s in unassigned if s not in group]
        groups.append(group)
    groups.sort(key=len, reverse=True)
    return groups


def main(board_id):
    tmap = load_board(board_id)
    props = {p['name']: p['value'] for p in tmap['properties']}
    cell = props['cellSize']
    m_lat, m_lng = props['metersPerDegLat'], props['metersPerDegLng']

    shops = []
    for obj in next(l for l in tmap['layers'] if l['name'] == 'shops')['objects']:
        p = {x['name']: x['value'] for x in obj['properties']}
        shops.append({'name': obj['name'], 'shop_id': p['shopId'],
                      'cx': p['cx'], 'cy': p['cy'], 'lat': p['lat'], 'lng': p['lng']})

    print(f"=== {props['county']}{props['town']}｜{len(shops)} 間店｜{cell} m/格 ===\n")

    passable, width, height = board_arrays(tmap)
    no_bridge, _, _ = board_arrays(tmap, drop_bridges=True)

    # ① 拆橋測試 ────────────────────────────────────────────────────────────
    with_bridge = components(passable, width, height, shops)
    without = components(no_bridge, width, height, shops)
    print(f'① 有橋：{len(with_bridge)} 個連通群'
          f'（{"、".join(str(len(g)) for g in with_bridge)} 間）')
    print(f'   拆橋：{len(without)} 個連通群'
          f'（{"、".join(str(len(g)) for g in without)} 間）')
    if len(without) > len(with_bridge):
        print('   ✓ 河確實切開了棋盤，橋是唯一通路')
        for group in without[1:]:
            names = '、'.join(s['name'] for s in group)
            print(f'     └ 只能經橋抵達：{names}')
    else:
        print('   ⚠ 拆掉橋之後連通性沒變 —— 河沒有真的切開兩岸，地理感是假的')

    # ② 繞路倍率 ────────────────────────────────────────────────────────────
    print('\n② 繞路倍率（A* 步數 vs 直線）')
    if len(without) > 1:
        far_group = without[1]
        near_group = without[0]
        pairs = [(min(near_group, key=lambda s: s['cy']), far_group[0])]
    else:
        pairs = [(shops[0], shops[-1])]

    for a, b in pairs:
        steps = astar(passable, width, height, (a['cx'], a['cy']), (b['cx'], b['cy']))
        straight = math.hypot((a['lat'] - b['lat']) * m_lat, (a['lng'] - b['lng']) * m_lng)
        if steps is None:
            print(f"   ✗ {a['name']} → {b['name']}：走不到")
            continue
        walked = steps * cell
        print(f"   {a['name']} → {b['name']}")
        print(f"     直線 {straight:,.0f} m｜實走 {walked:,.0f} m｜繞路 {walked / straight:.2f} 倍")

    # ③ 店間距離分布與遊戲內時間 ────────────────────────────────────────────
    # 用「最遠的一對」調倍率會失真——那是極端值，玩家大部分時間走的是中位數那段路。
    # 這裡做每間店的 BFS 拿到完整距離矩陣，再看分布。
    print('\n③ 店間實走距離分布（校準 speedMultiplier 用）')
    main_group = with_bridge[0]
    dists = []
    worst = (None, None, -1)
    for i, a in enumerate(main_group):
        field = bfs_field(passable, width, height, (a['cx'], a['cy']))
        for b in main_group[i + 1:]:
            steps = field.get(b['cy'] * width + b['cx'])
            if steps is None:
                continue
            dists.append(steps * cell)
            if steps * cell > worst[2]:
                worst = (a, b, steps * cell)
    dists.sort()

    def pct(p):
        return dists[min(int(len(dists) * p), len(dists) - 1)]

    print(f'   {len(dists)} 組配對：'
          f'p25 {pct(.25):,.0f} m｜中位 {pct(.5):,.0f} m｜p75 {pct(.75):,.0f} m｜'
          f'p90 {pct(.9):,.0f} m｜最遠 {worst[2]:,.0f} m')
    print(f"   最遠：{worst[0]['name']} → {worst[1]['name']}")
    print('\n   走路 5 km/h，遊戲內耗時：')
    print('     倍率    中位     p90     最遠')
    for mult in (1, 2, 3, 5, 10):
        row = [d / 5000 * 60 / mult for d in (pct(.5), pct(.9), worst[2])]
        print(f'     x{mult:<3} {row[0]:6.1f}分 {row[1]:6.1f}分 {row[2]:6.1f}分')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'tpe-zhongshan')
