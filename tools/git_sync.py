"""
git_sync.py — Git 同步工具
A  全部 Pull（Public + Private）
B  全部 Push（Public + Private）
1  Public Pull   （主 repo）
2  Public Push   （主 repo）
3  Private Pull  （ramen-finder-notes）
4  Private Push  （ramen-finder-notes）
s  查看兩個 repo 狀態（先 fetch 再比對，避免漏報落後）
"""
import os
import shlex
import subprocess
import sys

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stdin.reconfigure(encoding='utf-8')

tools_dir  = os.path.dirname(os.path.abspath(__file__))
root_dir   = os.path.dirname(tools_dir)
memory_dir = os.path.join(root_dir, 'ramen-finder-notes')

PUBLIC_LABEL  = 'Public  (taiwan-ramen-association.github.io)'
PRIVATE_LABEL = 'Private (ramen-finder-notes)'


def _detect_gh_cred():
    """gh 已安裝且登入 → 用它當 git 憑證（繞過失效的 osxkeychain）。"""
    try:
        r = subprocess.run(['gh', 'auth', 'status'],
                           capture_output=True, text=True, encoding='utf-8')
        return r.returncode == 0
    except (FileNotFoundError, OSError):
        return False


GH_CRED = _detect_gh_cred()


def _git_cmd(network):
    """network=True 且有 gh → 用 gh 憑證 helper（不動使用者全域設定）。"""
    cmd = ['git']
    if network and GH_CRED:
        cmd += ['-c', 'credential.helper=!gh auth git-credential']
    return cmd


def classify_git_error(text):
    """把 git 失敗訊息分類，供對應提示 / 自動修復。"""
    t = (text or '').lower()
    if any(k in t for k in ('could not read username', 'authentication failed',
                            'error: 401', 'error: 403', 'invalid username or password',
                            'terminal prompts disabled', 'no anonymous write access')):
        return 'auth'
    if any(k in t for k in ('rejected', 'non-fast-forward', 'fetch first',
                            'tip of your current branch is behind')):
        return 'rejected'
    if any(k in t for k in ('could not resolve host', 'timed out', 'timeout',
                            'connection refused', 'network is unreachable',
                            'failed to connect')):
        return 'network'
    return 'other'


def section(title):
    print()
    print('─' * 54)
    print(f'  {title}')
    print('─' * 54)


def run_git(args, cwd, network=False):
    """執行 git（network=True 走 gh 憑證），印出輸出，回傳成功與否。"""
    result = subprocess.run(
        _git_cmd(network) + args,
        cwd=cwd, capture_output=True, text=True, encoding='utf-8'
    )
    out = (result.stdout + result.stderr).strip()
    if out:
        print(out)
    return result.returncode == 0


def git_capture(args, cwd, network=False):
    """執行 git 但不印，回傳 (returncode, stdout, stderr)，供檢查用。"""
    result = subprocess.run(
        _git_cmd(network) + args,
        cwd=cwd, capture_output=True, text=True, encoding='utf-8'
    )
    return result.returncode, (result.stdout or ''), (result.stderr or '')


def _hint_git_failure(kind, op, text=''):
    """依錯誤類型給一句對應的下一步提示。"""
    tl = (text or '').lower()
    if 'conflict' in tl:
        print('  ⚠  rebase 有衝突：解決後 `git rebase --continue`，或 `git rebase --abort` 放棄。')
        return
    if kind == 'auth':
        print('  🔑 憑證問題。可跑一次 `gh auth setup-git`（讓 git 用 gh 的有效 token）。')
    elif kind == 'rejected':
        print('  ↯ 遠端有新 commit（分岔）。先 Pull（本工具已改 --rebase）再重試。')
    elif kind == 'network':
        print('  🌐 網路問題，請檢查連線後重試。')


def git_pull(cwd, label):
    section(f'Pull — {label}')
    rc, out, err = git_capture(['pull', '--rebase', '--autostash'], cwd=cwd, network=True)
    combined = (out + err).strip()
    if combined:
        print(combined)
    if rc == 0:
        print('\n  ✅ 完成')
        return True
    _hint_git_failure(classify_git_error(out + err), 'pull', out + err)
    print('\n  ❌ 失敗')
    return False


def _safe_push(cwd):
    """push 前先同步遠端（避免被拒）；仍被拒則 rebase 後重推一次。走 gh 憑證。"""
    # 1. 先抓遠端，落後就先 rebase（--autostash 保住 WIP）
    frc, fo, fe = git_capture(['fetch'], cwd=cwd, network=True)
    if frc != 0:
        print((fo + fe).strip())
        _hint_git_failure(classify_git_error(fo + fe), 'fetch', fo + fe)
        return False
    brc, bo, _ = git_capture(['rev-list', '--count', 'HEAD..@{u}'], cwd=cwd)
    behind = bo.strip() if brc == 0 else '0'
    if behind.isdigit() and int(behind) > 0:
        print(f'  ↯ 遠端領先 {behind} 個 commit，先 rebase…')
        rrc, ro, re_ = git_capture(['pull', '--rebase', '--autostash'], cwd=cwd, network=True)
        print((ro + re_).strip())
        if rrc != 0:
            _hint_git_failure(classify_git_error(ro + re_), 'pull', ro + re_)
            return False
    # 2. push
    prc, po, pe = git_capture(['push'], cwd=cwd, network=True)
    if (po + pe).strip():
        print((po + pe).strip())
    if prc == 0:
        return True
    # 3. 被拒（競態，遠端又更新）→ rebase 後重推一次
    if classify_git_error(po + pe) == 'rejected':
        print('  ↯ push 被拒（遠端又更新），rebase 後重推一次…')
        rrc, ro, re_ = git_capture(['pull', '--rebase', '--autostash'], cwd=cwd, network=True)
        print((ro + re_).strip())
        if rrc == 0:
            prc2, po2, pe2 = git_capture(['push'], cwd=cwd, network=True)
            if (po2 + pe2).strip():
                print((po2 + pe2).strip())
            if prc2 == 0:
                return True
            _hint_git_failure(classify_git_error(po2 + pe2), 'push', po2 + pe2)
            return False
        _hint_git_failure(classify_git_error(ro + re_), 'pull', ro + re_)
        return False
    _hint_git_failure(classify_git_error(po + pe), 'push', po + pe)
    return False


def git_push(cwd, label):
    section(f'Push — {label}')

    # 顯示目前狀態
    result = subprocess.run(
        ['git', 'status', '--short'],
        cwd=cwd, capture_output=True, text=True, encoding='utf-8'
    )
    status = result.stdout.strip()

    if not status:
        print('  ℹ  無變更，略過')
        return True

    print('\n  未提交的變更：')
    print(status)
    print()

    # 讓使用者選擇要 add 哪些檔案
    print('  選擇要 stage 的範圍：')
    print('    A  git add -A（全部）')
    print('    M  僅已追蹤的修改（git add -u）')
    print('    F  手動輸入檔案路徑')
    print('    N  取消')
    add_choice = input('\n  請選擇 (A/M/F/N)：').strip().upper()

    if add_choice == 'N' or add_choice == '':
        print('  ↩ 取消')
        return False
    elif add_choice == 'A':
        run_git(['add', '-A'], cwd=cwd)
    elif add_choice == 'M':
        run_git(['add', '-u'], cwd=cwd)
    elif add_choice == 'F':
        files = input('  輸入檔案路徑（空格分隔，含空白用引號）：').strip()
        if not files:
            print('  ↩ 取消')
            return False
        try:
            paths = shlex.split(files)
        except ValueError:
            paths = files.split()
        run_git(['add', '--'] + paths, cwd=cwd)
    else:
        print(f'  ⚠  無效選項')
        return False

    # 顯示 staged diff
    result = subprocess.run(
        ['git', 'diff', '--cached', '--stat'],
        cwd=cwd, capture_output=True, text=True, encoding='utf-8'
    )
    cached = result.stdout.strip()
    if not cached:
        print('  ℹ  沒有已 staged 的變更，不需要 commit')
        return True
    print(f'\n{cached}\n')

    # commit 訊息
    msg = input('  commit 訊息（Enter = 使用 "update"）：').strip()
    if not msg:
        msg = 'update'

    if not run_git(['commit', '-m', msg], cwd=cwd):
        print('  ❌ commit 失敗')
        return False

    print('\n  🚀 推送中...')
    ok = _safe_push(cwd)
    if ok:
        _, sha, _ = git_capture(['rev-parse', '--short', 'HEAD'], cwd=cwd)
        print(f'\n  ✅ Push 完成！（{sha.strip()}）')
    else:
        print('\n  ❌ Push 失敗')
    return ok


def status_one(cwd, label):
    """顯示單一 repo 狀態：先 fetch（只讀）再比對，並逐條列出落後／領先的 commit。

    重點：git status 只拿「上次 fetch 下來的 origin ref」比對，本身不連遠端；
    若不先 fetch，遠端已領先時會漏報成「無差異」。故這裡先 fetch 再顯示。
    """
    section(f'Status — {label}')

    # 1. 先 fetch（只讀，更新 origin ref）；離線／失敗則標註本機狀態可能過期
    frc, fo, fe = git_capture(['fetch'], cwd=cwd, network=True)
    if frc != 0:
        kind = classify_git_error(fo + fe)
        if kind == 'network':
            print('  🌐 無法連線遠端，以下為本機（可能過期）的狀態：')
        elif kind == 'auth':
            print('  🔑 憑證問題無法 fetch，以下為本機（可能過期）的狀態。')
            print('     可跑一次 `gh auth setup-git`（讓 git 用 gh 的有效 token）。')
        else:
            print('  ⚠  fetch 失敗，以下為本機（可能過期）的狀態。')

    # 2. 工作區 + 分支追蹤狀態
    run_git(['status', '--short', '--branch'], cwd=cwd)

    # 3. 沒有 upstream 就沒得比（避免 @{u} 報錯後靜默誤判成「同步」）
    urc, _, _ = git_capture(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd=cwd)
    if urc != 0:
        print('\n  ⚠  此分支未設定 upstream，無法比對遠端。')
        return

    # 4. 明確列出落後／領先遠端的 commit（fetch 後才準）
    _, behind, _ = git_capture(['log', '--oneline', 'HEAD..@{u}'], cwd=cwd)
    _, ahead, _  = git_capture(['log', '--oneline', '@{u}..HEAD'], cwd=cwd)
    behind, ahead = behind.strip(), ahead.strip()

    if behind:
        print('\n  ⬇ 落後遠端（需 Pull）：')
        for line in behind.splitlines():
            print(f'    {line}')
    if ahead:
        print('\n  ⬆ 領先遠端（需 Push）：')
        for line in ahead.splitlines():
            print(f'    {line}')
    if not behind and not ahead:
        print('\n  ✅ 與遠端同步')


def git_status():
    status_one(root_dir, PUBLIC_LABEL)

    if not os.path.isdir(memory_dir):
        section(f'Status — {PRIVATE_LABEL}')
        print('  ⚠  ramen-finder-notes/ 不存在，請先 clone private repo')
        print('  git clone https://github.com/taiwan-ramen-association/ramen-finder-notes ramen-finder-notes')
        return
    status_one(memory_dir, PRIVATE_LABEL)


def check_memory():
    if not os.path.isdir(memory_dir):
        print('\n  ⚠  ramen-finder-notes/ 不存在，略過 Private')
        print('  提示：git clone https://github.com/taiwan-ramen-association/ramen-finder-notes ramen-finder-notes')
        return False
    return True


def show_menu():
    print()
    print('╔' + '═' * 52 + '╗')
    print('║{:^52}║'.format('Git 同步工具　Git Sync'))
    print('╠' + '═' * 52 + '╣')
    print('║  A  【全部 Pull】 Public + Private{:<17}║'.format(''))
    print('║  B  【全部 Push】 Public + Private{:<17}║'.format(''))
    print('║  ' + '─' * 49 + '║')
    print('║  1  【Public  Pull】 主 repo{:<23}║'.format(''))
    print('║  2  【Public  Push】 主 repo{:<23}║'.format(''))
    print('║  3  【Private Pull】 ramen-finder-notes{:<12}║'.format(''))
    print('║  4  【Private Push】 ramen-finder-notes{:<12}║'.format(''))
    print('║  ' + '─' * 49 + '║')
    print('║  s  查看兩個 repo 狀態{:<29}║'.format(''))
    print('║  q  離開{:<43}║'.format(''))
    print('╚' + '═' * 52 + '╝')


# ════════════════════════════════════════════════════════════════════════════════
# 主迴圈
# ════════════════════════════════════════════════════════════════════════════════
def main():
    while True:
        show_menu()
        choice = input('\n請輸入選項：').strip().lower()

        if choice == 'q':
            print('\n掰掰')
            break

        elif choice == 'a':
            git_pull(root_dir, PUBLIC_LABEL)
            if check_memory():
                git_pull(memory_dir, PRIVATE_LABEL)
            input('\n按 Enter 繼續...')

        elif choice == 'b':
            git_push(root_dir, PUBLIC_LABEL)
            if check_memory():
                git_push(memory_dir, PRIVATE_LABEL)
            input('\n按 Enter 繼續...')

        elif choice == '1':
            git_pull(root_dir, PUBLIC_LABEL)
            input('\n按 Enter 繼續...')

        elif choice == '2':
            git_push(root_dir, PUBLIC_LABEL)
            input('\n按 Enter 繼續...')

        elif choice == '3':
            if check_memory():
                git_pull(memory_dir, PRIVATE_LABEL)
            input('\n按 Enter 繼續...')

        elif choice == '4':
            if check_memory():
                git_push(memory_dir, PRIVATE_LABEL)
            input('\n按 Enter 繼續...')

        elif choice == 's':
            git_status()
            input('\n按 Enter 繼續...')

        else:
            print(f'\n  ⚠  「{choice}」不是有效的選項')
            input('\n按 Enter 繼續...')


if __name__ == '__main__':
    main()
