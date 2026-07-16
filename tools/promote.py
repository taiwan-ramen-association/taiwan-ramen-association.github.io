"""
Beta → 正式版 推送腳本

用法：
  python tools/promote.py finder      # finder-beta.html → finder.html
  python tools/promote.py domination  # domination-beta.html → domination.html
  python tools/promote.py all         # 兩個都做

設計說明：
  finder.html 與 finder-beta.html 共用同一份 js/auth.js（含其他 JS 模組）。
  auth.js 透過 location.pathname 自動辨識頁面，套用不同的 gate 設定：
    - finder-beta.html → betaAccess（預設 director）
    - finder.html      → siteAccess（預設 all）
  因此 promote.py 只需處理 HTML 上的視覺差異（BETA badge 等），不必動 JS。
"""
import sys, re
from pathlib import Path

ROOT = Path(__file__).parent.parent


def promote_finder():
    src = ROOT / 'finder-beta.html'
    dst = ROOT / 'finder.html'
    text = src.read_text(encoding='utf-8')

    # 1. 移除 header 的 BETA chip（2026-07 起 h1 已改為 sr-only、徽章移至獨立 chip）
    text = text.replace('\n  <span class="beta-chip">BETA</span>', '')
    # 1b. 舊版 h1 內嵌 badge（向後相容，通常已不存在）
    text = text.replace(
        ' <span style="font-size:11px;background:rgba(255,255,255,0.25);padding:2px 7px;border-radius:10px;font-weight:400;letter-spacing:0;">BETA</span>',
        ''
    )

    # 2. 移除 <title> 內的 BETA 字樣（若有）
    text = re.sub(r'(<title>[^<]*?)\s*BETA(\s*[─\-]\s*[^<]*</title>)', r'\1\2', text)
    text = re.sub(r'(<title>[^<]*?)\s*BETA(</title>)', r'\1\2', text)

    dst.write_text(text, encoding='utf-8')
    print('finder.html 已更新（auth gate 透過 js/auth.js 的頁面偵測自動套用 siteAccess）')


def promote_domination():
    src = ROOT / 'domination-beta.html'
    dst = ROOT / 'domination.html'
    if not src.exists():
        print(f'⚠️  {src} 不存在（已移入 private repo），略過 domination 推送')
        return
    text = src.read_text(encoding='utf-8')

    # 1. title 移除 BETA
    text = text.replace(
        '<title>制霸地圖 BETA ─ 台灣拉麵協會</title>',
        '<title>制霸地圖 ─ 台灣拉麵協會</title>'
    )

    # 2. GEO_CACHE_NAME 遞增版號（v1→v2, v2→v3, ...）
    def bump_version(m):
        n = int(m.group(1)) + 1
        return f"const GEO_CACHE_NAME = 'dom-geo-v{n}';"
    new_text, count = re.subn(
        r"const GEO_CACHE_NAME = 'dom-geo-v(\d+)';",
        bump_version, text
    )
    if count:
        text = new_text
        print('  GEO_CACHE_NAME 已遞增')

    dst.write_text(text, encoding='utf-8')
    print('domination.html 已更新')


if __name__ == '__main__':
    target = sys.argv[1] if len(sys.argv) > 1 else 'all'
    if target in ('finder', 'all'):
        promote_finder()
    if target in ('domination', 'all'):
        promote_domination()
