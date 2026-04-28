# 台灣拉麵協會網站 — 操作手冊

> 本檔案為本機維護用參考文件。

---

## 目錄

1. [網站架構](#網站架構)
2. [店家資料管理](#店家資料管理)
3. [Firebase 與會員系統](#firebase-與會員系統)
4. [後台管理（admin.html）](#後台管理)
5. [自動化排程](#自動化排程)
6. [內容頁面維護](#內容頁面維護)
7. [環境架設](#環境架設)
8. [部署](#部署)

---

## 網站架構

### 頁面一覽

| 檔案 | 說明 | 備註 |
|---|---|---|
| `index.html` | 首頁 | |
| `finder.html` | 拉麵搜尋器（**正式版**） | PWA 入口 |
| `finder-beta.html` | 拉麵搜尋器（**測試版**） | 新功能驗證後才同步至 finder.html |
| `domination.html` | 制霸地圖 | 全台 368 鄉鎮踩點視覺化 |
| `admin.html` | 後台管理 | 需 admin 身份 |
| `news.html` | 最新消息 | |
| `about.html` | 關於協會 | |
| `charter.html` | 協會章程 | |
| `meetings.html` | 會議紀錄 | |
| `membership.html` | 加入會員 | |
| `partners.html` | 合作夥伴 | |
| `cards.html` | 店家名片 | |
| `members-zone.html` | 會務專區 | |

### 技術架構

```
純靜態網站（GitHub Pages）
├── 店家資料：Google Sheets ←→ data/data.json（每 12 小時自動同步）
├── 地圖：Leaflet.js + OpenStreetMap / CARTO
├── 會員系統：Firebase Authentication（Google 登入）
├── 使用者資料：Firebase Firestore
└── PWA：manifest.json + sw.js（可安裝為 App，支援離線快取）
```

### 目錄結構

```
/
├── index.html
├── finder.html             拉麵搜尋器（正式版）
├── finder-beta.html        拉麵搜尋器（測試版）
├── domination.html         制霸地圖
├── admin.html              後台管理
├── manifest.json           PWA 設定
├── sw.js                   Service Worker（快取策略）
├── ads.txt                 Google AdSense 驗證（必須在根目錄）
├── sitemap.xml             SEO 網站地圖（必須在根目錄）
├── google5be78957398a1c67.html  Search Console 驗證（必須在根目錄）
│
├── assets/
│   ├── css/style.css       共用樣式
│   ├── icons/              Logo、圖示
│   └── images/             IG 貼文圖片
│
├── data/
│   ├── data.json           店家主資料（由 Google Sheets 自動同步）
│   ├── districts.json      行政區劃資料（自動維護）
│   ├── id_counters.json    各縣市 ID 歷史最大值（防止 ID 重用）
│   ├── news.json           最新消息
│   ├── about.json          關於協會
│   ├── charter.json        協會章程
│   ├── meetings.json       會議紀錄
│   ├── membership.json     會員方案
│   ├── partners.json       合作夥伴
│   └── instagram.json      IG 貼文清單
│
├── tools/                  本機 Python 工具
│   ├── setup_data.py       資料編輯主工具
│   ├── compare_hours.py    比對 Google Places 營業時間（含 API Key，不上版控）
│   ├── item_detail.csv     Excel 下拉選單驗證清單
│   └── data.xlsx           Excel 工作檔（不納入版控）
│
└── .github/workflows/
    └── sync-sheets.yml     自動同步排程
```

---

## 店家資料管理

### 資料概況（截至 2026-04）

- 收錄店家：**780 筆**（營業中 633、已歇業 125、已搬遷 6、暫時關閉 10、暫停營業 4）
- 縣市分布：台北 280、台中 133、新北 111、高雄 82、桃園 64

### 方式一：Google Sheets（推薦）

直接在 Google Sheets「總表csv」工作表編輯，系統每 12 小時自動同步至網站。

### 方式二：本機 Excel

```bash
python tools/setup_data.py
```

| 選項 | 說明 |
|---|---|
| **A【拉取最新】** | `git pull`，取得最新 data.json |
| **B【開始編輯】** | JSON → Excel，自動開啟 Excel 編輯 |
| **C【完成編輯】** | Excel → JSON → 正規化（ID、縣市、時段、星期、日期）→ 寫回 Excel |
| **D【推上遠端】** | `git add` → 確認 diff → 輸入 commit 訊息 → `git push` |
| **0【進階單步】** | 單獨執行任一步驟 |

**標準流程：A → B → （Excel 編輯）→ C → D**

#### 各步驟說明

| 步驟 | 功能 |
|---|---|
| 1 Excel → JSON | 讀取 data.xlsx，轉成 data.json |
| 2 補 ID | 依縣市自動分配流水號（參考 id_counters.json 防止重用） |
| 3 補縣市 | 依行政區劃自動填入縣市欄位 |
| 4 正規化時段 | 統一格式為 `HH:MM～HH:MM` |
| 5 正規化星期 | 排序、去重、統一格式 |
| 6 正規化日期 | 開幕日、歇業日統一格式為 `YYYY-MM-DD`（含時間者自動截斷） |
| 7 JSON → Excel | 寫回 Excel 供下次編輯用 |

### 比對 Google Places 營業時間

```bash
python tools/compare_hours.py
```

逐一比對「營業中」店家的本地時段與 Google Maps 資料。

| 狀態 | 說明 |
|---|---|
| 吻合 | 無需處理 |
| 本地缺資料 | 自動從 Google 補填 |
| 有差異 | 自動以 Google 為準更新 |
| Google 無資料 | 疑似歇業，**需人工確認** |
| 找不到店家 | 需人工確認 |

輸出檔案：`tools/diff_report.csv`、`tools/compare_hours_log.txt`

> 需要 Google Places API Key，明碼寫在腳本中，請勿 push

---

## Firebase 與會員系統

### 登入

使用 Google 帳號登入，首次登入自動建立 Firestore 用戶文件。

### 用戶角色（role）

| 角色 | 說明 | 層級 |
|---|---|---|
| `viewer` | 一般訪客（首次登入預設） | 0 |
| `member_individual` | 個人會員 | 1 |
| `member_group` | 團體會員 | 1 |
| `member_sponsor` | 贊助會員 | 1 |
| `member_honorary` | 榮譽會員 | 1 |
| `director` | 理事 | 2 |
| `admin` | 管理員 | 9 |
| `warned` | 警告用戶（限制功能） | — |

### Firestore 資料結構

```
users/{uid}
  displayName, email, photoURL   — Google 帳號資訊
  role, level                    — 身份與等級
  memberNo                       — 會員流水號（admin 手動補填）
  postCount, likeCount           — 活動統計
  createdAt, lastLogin           — 時間戳記
  favorites: [shopId, ...]       — 收藏清單
  nickname, avatarUrl            — 自訂資料

userVisits/{uid}
  visits: { shopId: score }      — 踩點記錄（0=未踩, 1=已踩點, ...）
  reviews: { shopId: {...} }     — 評論

meta/featureFlags                — 功能開關（admin 在後台管理）
meta/counters                    — memberNo 自動遞增計數器
queues/{shopId}                  — 排隊候位狀態
rankings/{monthKey}              — 月排行榜
reportLogs/{logId}               — 檢舉紀錄
```

### 首次登入流程

1. `userRef.set({ displayName, email, photoURL, lastLogin }, { merge: true })` — 更新基本資料
2. 若文件尚無 `role`，自動執行：
   - 寫入 `role: 'viewer'`、`level: 0`、`postCount: 0`、`likeCount: 0`、`createdAt`
   - 讀取 `meta/counters`，自動分配 `memberNo`
3. `memberNo` 設定後不可自行修改，只有 admin 可更改

### Firestore 安全規則重點

- 用戶只能讀寫**自己**的文件（`request.auth.uid == uid`）
- `role` 和 `level` 受 `noPrivilegeEscalation()` 保護，不能自行提升
- `memberNo` 一旦設定即不可自行修改
- `meta/counters` 只有尚未分配 memberNo 的用戶可讀取與遞增（一次性）
- `meta/featureFlags` 所有人可讀，只有 admin 可寫

### finder.html vs finder-beta.html

- **finder-beta.html**：新功能實驗版，需特定身份才能瀏覽（由 `meta/featureFlags.betaAccess.perm` 控制）
- 功能在 beta 版驗證無誤後，再手動同步至 finder.html

---

## 後台管理

開啟 `admin.html`，需以 `admin` 身份登入。

### 功能

| 功能 | 說明 |
|---|---|
| **用戶管理** | 查看所有用戶、修改角色、補填 memberNo、標記警告 |
| **功能權限設定（featureFlags）** | 控制各功能的可見門檻與使用門檻 |

### featureFlags 說明

每個功能有兩個欄位：

| 欄位 | 說明 |
|---|---|
| `vis`（可見門檻） | 低於此角色的用戶**看不到**此功能的 UI 元件 |
| `perm`（使用門檻） | 低於此角色的用戶**無法使用**此功能（顯示鎖定狀態） |

| 功能 | Firestore key |
|---|---|
| 收藏 | `favorites` |
| 踩點 | `stamps` |
| 評論 | `reviews` |
| 排隊 | `queue` |
| 排行榜 | `rankings` |
| Beta 測試版存取 | `betaAccess` |

---

## 自動化排程

| 排程 | 工作 |
|---|---|
| 每 12 小時 | Google Sheets → data/data.json 同步、補座標 |
| 每月 1 日 02:00 | 更新行政區劃清單（districts.json） |
| 推送 data/data.json 時 | data.json → 回寫 Google Sheets |

手動觸發：GitHub → Actions → Sync Google Sheets → Run workflow

sync-sheets.yml 同時維護 `data/id_counters.json`（雲端同步時同步更新計數器）。

---

## 內容頁面維護

### 最新消息

編輯 `data/news.json`，在陣列開頭新增：

```json
{
  "date": "2026-04-01",
  "title": "標題",
  "body": "內容文字",
  "tag": "公告"
}
```

`tag` 可填：`公告`、`活動`、`媒體`

### 會議紀錄

編輯 `data/meetings.json`：

```json
{
  "date": "2026-04-01",
  "title": "第X次理事會議",
  "summary": "會議摘要",
  "file": ""
}
```

### 合作夥伴

1. 將 Logo 放入 `assets/icons/`
2. 編輯 `data/partners.json`：

```json
{
  "name": "店家名稱",
  "category": "member",
  "logo": "assets/icons/檔名.png",
  "url": null,
  "featured": true
}
```

`category`：`member`（協會會員）、`ramen`（合作拉麵店）、`partner`（合作商家）

### IG 貼文

1. 將圖片放入 `assets/images/`
2. 編輯 `data/instagram.json`，在陣列開頭新增：

```json
{
  "image": "assets/images/檔名.jpeg",
  "url": "https://www.instagram.com/p/XXXXXX/"
}
```

---

## 環境架設

### 需求

- Git
- Python 3.9 以上

### 步驟

```bash
# 1. Clone 專案
git clone https://github.com/taiwan-ramen-association/taiwan-ramen-association.github.io.git
cd taiwan-ramen-association.github.io

# 2. 安裝 Python 套件（setup_data.py 第一次執行時也會自動安裝）
pip install openpyxl requests gspread google-auth
```

### 注意事項

- `tools/data.xlsx` 不納入版控，每次在本機執行 setup_data.py 選 **B** 重新產生
- `tools/compare_hours.py` 含 API Key，不納入版控，換電腦時需自行保管
- GitHub Actions 的自動同步在 GitHub 雲端執行，本機不需額外設定
- Google Service Account 金鑰設定於 GitHub Secrets，本機工具不需要

---

## 部署

靜態網站，push 至 `main` branch 即自動部署至 GitHub Pages。

```bash
git add .
git commit -m "更新說明"
git push
```

> `data/data.json` 和 `data/id_counters.json` 是版本控制的一部分，需一起 push。
