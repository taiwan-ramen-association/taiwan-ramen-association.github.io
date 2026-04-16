# 台灣拉麵協會網站 — 操作手冊

> 本檔案僅供本機使用，不納入版控。

---

## 目錄結構

```
/
├── index.html              首頁
├── about.html              關於協會
├── news.html               最新消息
├── charter.html            協會章程
├── meetings.html           會議紀錄
├── membership.html         加入會員
├── partners.html           合作夥伴
├── finder.html             拉麵搜尋器
├── cards.html              店家名片
├── members-zone.html       會務專區
├── other.html              其他
│
├── assets/
│   ├── css/
│   │   └── style.css       共用樣式
│   ├── icons/              Logo、圖示（原 icon/）
│   └── images/             IG 貼文圖片（原 image/）
│
├── data/
│   ├── data.json           店家主資料（由 Google Sheets 自動同步）
│   ├── news.json           最新消息
│   ├── about.json          關於協會內容
│   ├── charter.json        協會章程內容
│   ├── meetings.json       會議紀錄清單
│   ├── membership.json     會員方案內容
│   ├── partners.json       合作夥伴清單
│   └── instagram.json      IG 貼文清單
│
├── tools/                  本機 Python 工具（不上版控的除外）
│   ├── setup_data.py           一鍵：更新行政區 + 補縣市 + 補座標
│   ├── geocode.py              單獨補齊店家座標（含模式2批次重跑）
│   ├── excel_to_json.py        xlsx → data/data.json
│   ├── json_to_excel.py        data/data.json → xlsx（方便用 Excel 編輯）
│   ├── compare_hours.py        比對 Google Places 營業時間（含 API Key，不上版控）
│   ├── districts.json          內政部行政區劃資料（自動維護）
│   └── data.xlsx               Excel 工作檔（不納入版控，每次重新產生）
│
├── .github/workflows/
│   └── sync-sheets.yml     自動同步排程（Google Sheets ↔ data/data.json）
│
├── ads.txt                 Google AdSense 驗證（必須在根目錄）
├── sitemap.xml             SEO 網站地圖（必須在根目錄）
└── google5be78957398a1c67.html  Google Search Console 驗證（必須在根目錄）
```

---

## 常見操作

### 新增最新消息

編輯 `data/news.json`，在陣列開頭新增：

```json
{
  "date": "2026-04-01",
  "title": "標題",
  "body": "內容文字",
  "tag": "公告"
}
```

```bash
git add data/news.json
git commit -m "新增消息：標題"
git push
```

---

### 新增會議紀錄

編輯 `data/meetings.json`，新增一筆：

```json
{
  "date": "2026-04-01",
  "title": "第X次理事會議",
  "summary": "會議摘要",
  "file": ""
}
```

---

### 新增合作夥伴

1. 將 Logo 圖片放入 `assets/icons/` 資料夾
2. 編輯 `data/partners.json`，新增一筆：

```json
{
  "name": "店家名稱",
  "category": "member",
  "logo": "assets/icons/檔名.png",
  "url": null,
  "featured": true
}
```

`category` 可填：`member`（協會會員）、`ramen`（合作拉麵店）、`partner`（合作商家）

---

### 新增 IG 貼文

1. 將圖片放入 `assets/images/` 資料夾
2. 編輯 `data/instagram.json`，在陣列開頭新增：

```json
{
  "image": "assets/images/檔名.jpeg",
  "url": "https://www.instagram.com/p/XXXXXX/"
}
```

---

### 新增／修改店家資料

**方式一：透過 Google Sheets（推薦）**
直接在 Google Sheets「總表csv」工作表編輯，系統每 12 小時自動同步至網站。

**方式二：本機 Excel**
```bash
# 1. 產生可編輯的 Excel
python tools/json_to_excel.py

# 2. 用 Excel 開啟 tools/data.xlsx 編輯後存檔

# 3. 轉回 JSON（會自動正規化營業時段格式）
python tools/excel_to_json.py

# 4. Push
git add data/data.json
git commit -m "更新店家資料"
git push
```

> `json_to_excel.py` 和 `excel_to_json.py` 都會自動正規化營業時段格式：
> 統一破折號為全形（`–`）、多時段中間以頓號分隔（`12:00–14:00、17:00–21:00`）

---

### 補齊店家資料（一鍵）

新增店家後，若縣市／鄉鎮市區或座標欄位為空，執行：

```bash
python tools/setup_data.py
```

依序執行：
1. 從內政部 API 更新行政區劃清單
2. 自動從地址填入縣市／鄉鎮市區（僅補空白欄位）
3. 自動補齊 lat/lng 座標

> 所有步驟均使用免費 API，無需 API Key。

---

### 比對 Google Places 營業時間

```bash
python tools/compare_hours.py
```

逐一比對「營業中」店家的本地時段與 Google Maps 資料：

| 狀態 | 說明 |
|------|------|
| 吻合 | 無需處理 |
| 本地缺資料 | 自動從 Google 補填週一～週日 |
| 有差異 | 自動以 Google 為準更新 |
| Google 無資料 | 疑似歇業或暫停，**需人工確認** |
| 找不到店家 | Place ID 搜尋失敗，需人工確認 |

執行完畢輸出（均存在 `tools/` 下）：
- `tools/diff_report.csv`：所有店家比對結果總表
- `tools/compare_hours_log.txt`：詳細差異紀錄

> 需要 Google Places API Key（明碼寫在腳本中，僅供本機使用，請勿 push）

---

## 自動化排程（GitHub Actions）

| 排程 | 工作 |
|------|------|
| 每 12 小時 | Google Sheets → data/data.json 同步、補齊座標 |
| 每月 1 日 02:00 | 更新行政區劃清單 |
| 推送 data/data.json 時 | data.json → 回寫 Google Sheets |

手動觸發：GitHub → Actions → Sync Google Sheets → Run workflow

---

## 環境架設（換電腦）

### 需求
- Git
- Python 3.9 以上
- 網路連線

### 步驟

```bash
# 1. Clone 專案
git clone https://github.com/taiwan-ramen-association/taiwan-ramen-association.github.io.git
cd taiwan-ramen-association.github.io

# 2. 安裝 Python 套件
pip install openpyxl requests gspread google-auth
```

### 注意事項
- `tools/data.xlsx` 不納入版控，每次需在本機重新產生（執行 `json_to_excel.py`）
- `tools/compare_hours.py` 含 API Key，不納入版控，換電腦時需自行保管
- GitHub Actions 的自動同步不需要本機設定，在 GitHub 雲端執行
- Google Service Account 金鑰只需設定在 GitHub Secrets，本機工具不需要

---

## 網站部署

靜態網站，直接 push 至 `main` branch 即自動部署至 GitHub Pages，無需額外設定。
