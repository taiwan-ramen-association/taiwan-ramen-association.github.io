# 台灣拉麵協會 — 開發上下文

## 專案
台灣拉麵協會網站，部署於 GitHub Pages。
**完整說明見 `ramen-finder-notes/MANUAL.md`**（private repo，含架構、流程、Firestore 結構、部署方式）。

## 技術棧
Firebase（Firestore、Auth、Storage、FCM）、Leaflet.js、Vanilla JS

## 關鍵檔案
- 前台正式版：`finder.html`
- 前台測試版：`finder-beta.html`
- 後台（一般）：`admin.html`（bundle 從 Firebase Storage 載入）
- 後台（備援）：`console.html`（bundle 從 GitHub private repo 載入）
- Firebase Rules：`ramen-finder-notes/firestore.rules`

## 協作規則
- **任何程式碼修改前，先說明計畫，等確認後才動工**
- 不自行開 PR 或 git push
- 不要跑 PR

## 暫緩功能（勿動）
- 排行榜
- 排隊回報

## 開發中
- 挑戰任務系統（2026-05 完成 v1，目前 admin-only 測試中，詳見 MANUAL「八・五」）
