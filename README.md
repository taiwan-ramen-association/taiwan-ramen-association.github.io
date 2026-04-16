# 台灣拉麵協會 官方網站

> 台灣拉麵協會（Taiwan Ramen Association）的官方網站與拉麵店家搜尋器。

**網站：** https://taiwan-ramen-association.github.io

---

## 功能

- **拉麵搜尋器** — 互動地圖，依縣市、類型、營業狀態篩選全台店家
- **最新消息** — 協會公告與活動資訊
- **合作夥伴** — 協會會員與合作店家一覽
- **關於協會** — 協會介紹、章程、會議紀錄
- **加入會員** — 會員方案說明

---

## 技術架構

純靜態網站，部署於 GitHub Pages。

```
assets/          CSS、圖示、圖片
data/            各頁面 JSON 資料（由 Google Sheets 自動同步）
tools/           本機維護用 Python 工具
.github/         自動同步 CI（Google Sheets ↔ data/data.json）
```

- 店家資料以 Google Sheets 為主要編輯介面，透過 GitHub Actions 每 12 小時自動同步
- 地圖使用 [Leaflet.js](https://leafletjs.com/) + OpenStreetMap / CARTO

---

## 店家資料更新

店家資料維護於 Google Sheets，系統自動同步，一般不需手動操作。
若需本機編輯，請參考 [MANUAL.md](MANUAL.md)。

---

## License

© Taiwan Ramen Association. All rights reserved.
