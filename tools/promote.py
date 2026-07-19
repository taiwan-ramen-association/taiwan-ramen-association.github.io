"""
Beta → 正式版 推送腳本

用法：
  python tools/promote.py finder      # finder-beta.html → finder.html（含 js-beta → js 同步）
  python tools/promote.py domination  # domination-beta.html → domination.html
  python tools/promote.py all         # 兩個都做

finder 流程（2026-07 更新）：
  finder-beta.html 載入部分 js-beta/*.js（目前 auth、reviews、challenges）作為 beta 專屬版本；
  正式版 finder.html 則載入 js/*.js。本腳本自動：
    1. 掃描 finder-beta.html 內所有 js-beta/<name> script 引用
    2. 逐一把 js-beta/<name> 覆蓋到 js/<name>（同步 beta 程式碼到正式版）
    3. 複製 finder-beta.html → finder.html，並把 script src 的 js-beta/ 換回 js/
  gate 免手動處理：js/auth.js 靠 location.pathname 自動辨識頁面 —
    finder-beta.html → betaAccess（預設 director）、finder.html → siteAccess（預設 all）。
  ⚠ js/reviews.js 亦被 shop.html 共用；維護 js-beta/reviews.js 時務必保持與 shop.html 相容。
"""
import sys, re, shutil
from pathlib import Path

ROOT = Path(__file__).parent.parent


def promote_finder():
    src = ROOT / 'finder-beta.html'
    dst = ROOT / 'finder.html'
    text = src.read_text(encoding='utf-8')

    # 1. 同步 beta 專屬 JS，並把 HTML script src 的 js-beta/ 換回 js/
    #    依 finder-beta.html 實際載入的 js-beta/* 自動決定（未來增減 fork 檔也適用）
    beta_scripts = list(dict.fromkeys(re.findall(r'js-beta/([\w.-]+\.js)', text)))
    synced = []
    for name in beta_scripts:
        beta_file = ROOT / 'js-beta' / name
        prod_file = ROOT / 'js' / name
        if beta_file.exists():
            shutil.copyfile(beta_file, prod_file)
            synced.append(name)
        else:
            print(f'   ⚠️  找不到 js-beta/{name}，略過同步')
        text = text.replace(f'js-beta/{name}', f'js/{name}')

    # 1b. 移除任何提到 js-beta 的 HTML 註解（正式版已無意義且會誤導）
    text = re.sub(r'^[ \t]*<!--[^\n]*js-beta[^\n]*-->[ \t]*\n', '', text, flags=re.M)

    # 2. 移除 BETA 徽章 / title（向後相容；目前 beta 已無徽章，通常不觸發）
    text = text.replace('\n  <span class="beta-chip">BETA</span>', '')
    text = text.replace(
        ' <span style="font-size:11px;background:rgba(255,255,255,0.25);padding:2px 7px;border-radius:10px;font-weight:400;letter-spacing:0;">BETA</span>',
        ''
    )
    text = re.sub(r'(<title>[^<]*?)\s*BETA(\s*[─\-]\s*[^<]*</title>)', r'\1\2', text)
    text = re.sub(r'(<title>[^<]*?)\s*BETA(</title>)', r'\1\2', text)

    dst.write_text(text, encoding='utf-8')

    # 3. 安全檢查：HTML 不應再殘留任何 js-beta 字樣（含註解）
    leftover = sorted(set(re.findall(r'js-beta[\w./-]*', text)))

    print('✅ finder.html 已更新（gate 由 js/auth.js pathname 偵測自動套用 siteAccess）')
    print(f'   已同步 JS（js-beta → js）：{", ".join(synced) if synced else "（無）"}')
    if leftover:
        print(f'   ⚠️  HTML 仍殘留 js-beta 引用，請檢查：{leftover}')


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
