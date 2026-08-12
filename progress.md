# Slide Helper Development Progress

最後更新：2026-08-13

## 作業規範

- [x] 開發位置固定為遠端 `/home/moriss/slide-helper`
- [x] 所有待辦以 Markdown checkbox 追蹤
- [x] 每個小階段使用 `git commit -s -S` 提交
- [x] 所有 `sudo` 指令與目的必須記錄於 `sudo.log`

## M0：技術去風險與專案骨架

- [x] 檢查遠端 Docker、Git 與 SSH commit signing 設定
- [x] 初始化遠端 Git repository 並匯入開發計畫
- [x] 建立 Cargo／pnpm monorepo 目錄與基礎設定
- [x] 建立完整 Docker Compose development stack
- [x] 建立 Rust Axum API health endpoints
- [x] 建立 Rust WebSocket room prototype
- [x] 建立 PostgreSQL、Redis 與 migration container
- [x] 建立前端應用骨架與 `zh-TW`／`en` i18n catalog
- [x] 建立 Manifest V3 Chrome Extension 骨架
- [x] 建立 Google Slides slide detector Spike
- [x] 建立 CI 基礎檢查
- [x] 完成容器建置、啟動與自動測試
- [x] 記錄 M0 技術驗證結果與下一階段風險

## M1：Domain、OAuth 與持久化

- [x] 實作 Rust Session、CueRun 與 SyncMode state machines
- [x] 實作 Google OpenID Connect Authorization Code + PKCE
- [x] 建立 Project、Cue、Live Session、Response schema
- [x] 由 Rust protocol schema 產生 TypeScript client
- [ ] 實作 role-scoped token 與 application authorization
- [ ] 建立 transaction outbox 與 WebSocket event protocol

## M2：手動播放核心

- [ ] 建立 Presenter Console
- [ ] 建立 Presenter Mobile Remote
- [ ] 建立 Audience Join 與匿名 participant token
- [ ] 建立透明 OBS Overlay
- [ ] 實作理解度互動
- [ ] 實作單選題互動
- [ ] 完成 100 人基準壓測

## M3：完整 MVP 題型與編輯器

- [ ] 建立三欄式互動編輯器
- [ ] 實作文字雲
- [ ] 實作 Q&A、按讚與置頂
- [ ] 建立教學、Lightning Talk、產品 Demo 模板
- [ ] 建立投影、手機、講者三種預覽
- [ ] 建立 CSV 匯出

## M4：Google Slides 自動跟隨

- [ ] 實作 Extension pairing
- [ ] 實作 Deck／Slide mapping
- [ ] 實作自動 position command
- [ ] 注入 Overlay iframe
- [ ] 實作 Extension heartbeat、暫停與診斷
- [ ] 完成自動跟隨相容性矩陣

## M5：切換、斷線與韌性

- [ ] 實作五種 Sync State
- [ ] 實作 Auto → Manual 無損接手
- [ ] 實作 Extension 恢復後 Resync 確認
- [ ] 實作 Snapshot／event gap recovery
- [ ] 完成 Command 競態測試

## M6：封閉 Beta

- [ ] 完成效能與壓力測試
- [ ] 完成 `zh-TW`／`en` 驗收
- [ ] 完成無障礙檢查
- [ ] 建立錯誤追蹤與 Dashboard
- [ ] 完成隱私與資料刪除流程
- [ ] 完成 5～10 位講者封閉測試
