#!/usr/bin/env python
# -*- coding: utf-8 -*-
r"""run.py — 3D 頁回歸測試的自動執行器（零外部依賴：Python 標準函式庫 + 本機 Edge）。

流程：
  1. 在 127.0.0.1 隨機埠起靜態伺服器（根目錄 = repo），另收兩個 POST：
       /__test/result      測試頁跑完回傳的結果 JSON
       /__test/shot?name=  固定視角截圖（PNG data URL）
  2. 用 headless Edge 開 test/index.html?auto=1
       · 暫時的獨立設定檔：不碰你的 Edge 帳號、登入、書籤
       · 關閉背景網路、同步、元件更新；只會連 127.0.0.1
       · WebGL 走 SwiftShader（軟體算繪），每台機器結果一致
  3. 收到結果就關掉 Edge、刪暫存設定檔，印出結果；任一 FAIL → exit 1

用法：
    python lab/game-world-3d/test/run.py                 # 全部棋盤
    python lab/game-world-3d/test/run.py --board tpe-daan-3m
    python lab/game-world-3d/test/run.py --headed        # 開視窗看（除錯用）

輸出：lab/game-world-3d/test/out/result.json 與 *.png（不進版控）
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
OUT = HERE / 'out'
TEST_PATH = '/lab/game-world-3d/test/index.html'

BROWSERS = [
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

done = threading.Event()
result = {}


class Handler(SimpleHTTPRequestHandler):
    # 不靠作業系統登錄檔猜 MIME：.js 被判成 text/plain 的話，瀏覽器會拒載 ES module
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript', '.mjs': 'text/javascript',
        '.json': 'application/json', '.html': 'text/html; charset=utf-8',
        '.png': 'image/png', '.md': 'text/plain; charset=utf-8',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_POST(self):
        url = urlparse(self.path)
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        if url.path == '/__test/result':
            result.update(json.loads(body.decode('utf-8')))
            done.set()
        elif url.path == '/__test/shot':
            name = parse_qs(url.query).get('name', ['shot'])[0]
            name = ''.join(c for c in name if c.isalnum() or c in '-_') or 'shot'
            b64 = body.decode('ascii').split(',', 1)[-1]
            OUT.mkdir(parents=True, exist_ok=True)
            (OUT / f'{name}.png').write_bytes(base64.b64decode(b64))
        else:
            self.send_error(404)
            return
        self.send_response(204)
        self.end_headers()

    def log_message(self, fmt, *args):
        if args and str(args[1]).startswith(('4', '5')):   # 只印 4xx／5xx
            sys.stderr.write('  [server] ' + (fmt % args) + '\n')


class Server(ThreadingHTTPServer):
    # 測試頁收掉 iframe 時瀏覽器會中斷還在傳的請求，屬正常現象，不要印 traceback
    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


def find_browser():
    for p in BROWSERS:
        if os.path.exists(p):
            return p
    raise SystemExit('找不到 Edge 或 Chrome。')


def kill_tree(proc):
    if proc.poll() is not None:
        return
    if sys.platform == 'win32':
        subprocess.run(['taskkill', '/PID', str(proc.pid), '/T', '/F'],
                       capture_output=True)
    else:
        proc.kill()


def main():
    args = sys.argv[1:]
    headed = '--headed' in args
    board = None
    if '--board' in args:
        board = args[args.index('--board') + 1]
    timeout = 900
    if '--timeout' in args:
        timeout = int(args[args.index('--timeout') + 1])

    if OUT.exists():
        for f in OUT.glob('*'):
            f.unlink()
    server = Server(('127.0.0.1', 0), partial(Handler, directory=str(REPO_ROOT)))
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    url = f'http://127.0.0.1:{port}{TEST_PATH}?auto=1' + (f'&board={board}' if board else '')
    exe = find_browser()
    profile = tempfile.mkdtemp(prefix='gw3d-test-')
    flags = [
        f'--user-data-dir={profile}',
        '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--disable-component-update',
        '--disable-sync', '--disable-default-apps', '--disable-extensions',
        '--no-pings', '--disable-domain-reliability',
        '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
        '--window-size=1400,1000',
    ]
    if not headed:
        flags.insert(0, '--headless=new')
    print(f'伺服器 127.0.0.1:{port}｜瀏覽器 {Path(exe).stem}{"（視窗）" if headed else "（headless）"}')
    print(f'測試頁 {url}')
    t0 = time.time()
    proc = subprocess.Popen([exe, *flags, url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        finished = done.wait(timeout)
    finally:
        kill_tree(proc)
        server.shutdown()
        time.sleep(0.5)
        shutil.rmtree(profile, ignore_errors=True)

    if not finished:
        print(f'\n✗ 逾時 {timeout} 秒：測試頁沒有回傳結果')
        sys.exit(2)

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'耗時 {time.time() - t0:.0f} 秒｜{result.get("userAgent", "")}\n')
    for r in result['results']:
        print(f"  {'✓' if r['ok'] else '✗'} {r['test']:<6} {r['board']:<22} {r['detail']}")
    shots = sorted(p.name for p in OUT.glob('*.png'))
    if shots:
        print(f'\n截圖 {len(shots)} 張 → {OUT}')
    print()
    if result.get('fail'):
        print(f"✗ FAIL {result['fail']} 項（PASS {result['pass']}）")
        sys.exit(1)
    print(f"✓ 全部通過（{result['pass']} 項）")


if __name__ == '__main__':
    main()
