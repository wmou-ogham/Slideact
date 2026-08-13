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
- [x] 實作 role-scoped token 與 application authorization
- [x] 建立 transaction outbox 與 WebSocket event protocol

## M2：手動播放核心

- [x] 建立 Project、Cue、Interaction 與 Live Session HTTP API
- [x] 建立講者 authoritative command 與 Snapshot API
- [x] 建立 Presenter Console
- [x] 建立 Presenter Mobile Remote
- [x] 建立 Audience Join 與匿名 participant token
- [x] 建立透明 OBS Overlay
- [x] 實作理解度互動
- [x] 實作單選題互動
- [x] 建立訪客模式與長效 Guest Vault session
- [x] 完成 100 人基準壓測

## M3：完整 MVP 題型與編輯器

- [x] 建立三欄式互動編輯器
- [x] 實作文字雲
- [x] 實作 Q&A、按讚與置頂
- [x] 建立教學、Lightning Talk、產品 Demo 模板
- [x] 建立投影、手機、講者三種預覽
- [x] 建立 CSV 匯出

## M4：Google Slides 自動跟隨

- [x] 實作 Extension pairing
- [x] 實作 Deck／Slide mapping
- [x] 實作自動 position command
- [x] 注入 Overlay iframe
- [x] 實作 Extension heartbeat、暫停與診斷
- [x] 完成自動跟隨相容性矩陣

## M5：切換、斷線與韌性

- [x] 實作五種 Sync State
- [x] 實作 Auto → Manual 無損接手
- [x] 實作 Extension 恢復後 Resync 確認
- [x] 實作 Snapshot／event gap recovery
- [x] 完成 Command 競態測試

## M6：封閉 Beta

- [x] 完成效能與壓力測試
- [x] 完成 `zh-TW`／`en` 驗收
- [x] 完成無障礙檢查
- [x] 建立錯誤追蹤與 Dashboard
- [x] 完成隱私與資料刪除流程
- [ ] 完成 5～10 位講者封閉測試

## 完成度稽核補強

- [x] 加入目的導向互動建立與題型／文案推薦
- [x] 加入後端驗證的手動 Cue 排序
- [x] 加入觀眾離線狀態、穩定冪等鍵與失敗重試 UX
- [x] 理解度改為綠／黃／紅三段訊號
- [x] 講者即時查看人數、回覆數、回覆率與理解警示
- [x] 結果可見性由 API 與 WebSocket 同步強制執行
- [x] 公布前禁止 Audience／Overlay 取得受保護的統計 payload
- [x] 加入專案複製與封存操作
- [x] 顯示觀眾加入 QR Code
- [x] 加入觀眾寫入 rate limit 與基本垃圾內容防護
- [ ] 完成真實 Google Slides 測試 Deck 與 Extension E2E 驗收

## 講者工作室回饋修正

- [x] 專案側邊欄可收合與還原
- [x] Cue 改用投影片序號、頁碼或 Google Slides ID／網址映射
- [x] Cue 預設立即開啟，並支援展開編輯與刪除
- [x] 已建立互動可展開編輯與刪除，新增表單移至清單底部
- [x] 結果可見性只保留即時公開與講者公布後顯示
- [x] 加入獨立講者投影結果頁與入口
- [x] 使用正式文字雲排版套件並改善對比
- [x] 手機遙控器加入活動限定 controller token 與 QR Code（不暴露 Vault 憑證）
- [x] 手機遙控器加入上一頁、下一頁與狀態感知作答控制

## Beta 交付稽核

- [x] 建立可重現的 Beta 交付狀態與測試證據文件
- [x] 確認六個部署服務健康、Extension 產物 checksum 與 commit 簽章
- [x] 確認 GitHub Actions workflow 已納入程式庫並保存完整 CI log artifact
- [ ] 注入正式 Google OAuth 憑證並以 HTTPS callback 驗收
- [ ] 使用已登入 Google 的 Chrome 與真實 Slides deck 完成 Extension E2E
- [ ] 由 5～10 位真人講者完成封閉 Beta 腳本
- [ ] 使用 GitHub 管理權限設定 About description 並確認雲端 Actions run
