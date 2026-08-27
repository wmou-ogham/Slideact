# Slide Helper Development Progress

最後更新：2026-08-27

## Cursor 提示音

- [x] 遠端 Machine 設定關閉無障礙提示音（`editor.accessibilitySupport`、`accessibility.signalOptions.volume`）

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
- [x] 注入 Google OAuth 憑證（HTTPS callback + AUTH_COOKIE_SECURE=true）
- [ ] 使用已登入 Google 的 Chrome 與真實 Slides deck 完成 Extension E2E
- [ ] 由 5～10 位真人講者完成封閉 Beta 腳本
- [ ] 使用 GitHub 管理權限設定 About description 並確認雲端 Actions run

## 現場控制回饋修正（二）

- [x] 現場 Cue 下拉保留目前選擇，立即開啟 Cue 會直接進入可作答狀態
- [x] 桌面與手機移除暫停／關閉作答操作，只保留公布結果與保留回覆的重新開放
- [x] 手機投影片導覽改用短期 FIFO 佇列，並支援手動 Cue 模式與 Slides 編輯模式
- [x] 觀眾問答預設即時公開，且觀眾頁與投影頁皆顯示問題清單

## 活動生命週期與紀錄修正

- [x] 新活動參加碼改為六位純數字，加入欄位限制為數字鍵盤與六位長度
- [x] 建立活動後隱藏重複建立操作，直接顯示等待開始流程
- [x] 隱藏遺留草稿並把活動選擇器整理為進行中與歷史活動
- [x] 提供每場活動的永久結果紀錄與視覺化回看入口
- [x] 驗證活動結束後六位碼可回收而歷史結果仍保留

## 直播控制列修正

- [x] 直播中隱藏其他歷史 event 選單，避免下拉選單遮蔽控制列
- [x] 直播控制列與手機遙控器提供觀眾加入 QR Code 入口
- [x] 已結束活動隱藏公布結果，建立活動置中並保留歷史、重新開放與 CSV 操作

## 簡報專案管理修正

- [x] 將製作副本與封存操作移至分隔線下，明確作用於選取的簡報實例
- [x] 新增輸入專案名稱確認的刪除流程與雙語提示
- [x] 含現場活動歷史的專案禁止硬刪除，改以封存保留結果
- [x] API、前端型別檢查、smoke test 與 100 人 benchmark 通過

## QRCode 首頁控制

- [x] 講者投影片下拉清單第一項加入「QRCode 首頁」
- [x] 手機 Cue 清單第一項加入「QRCode 首頁」
- [x] 新增即時 `show_join_qr` 狀態命令，同步切換投影與 OBS 畫面
- [x] QRCode 首頁只切換 `presentation_view`，不清空目前 Cue、回答、統計或問題
- [x] 切回同一投影片沿用原 Cue run，僅切換其他投影片時建立新一輪
- [x] 上一頁／下一頁切換其他投影片時沿用該頁既有 Cue run，不清空已作答內容
- [x] 訪客 Vault 可下載金鑰檔，並在其他電腦開啟同一個工作區

## Git 工作區檢查

- [x] 盤點尚未 staged 的修改與未追蹤檔
- [x] Extension 建置產物 `apps/extension/slideact-extension/` 與 `.zip` 加入 `.gitignore`
- [x] 獨立結果頁、配對碼重用、systemd 開機啟動一併提交；不 ignore 功能／部署程式

## 文字雲動態效果

- [x] 新詞交錯進場、既有詞輕微漂浮
- [x] 詞頻上升時短暫放大，高頻詞加上柔光
- [x] 旋轉與顏色依詞彙本身決定，避免即時更新時整片重排跳色
- [x] `prefers-reduced-motion` 既有規則會關掉這些動畫
- [x] 字級依詞數縮放：單一答案約占畫面高度 1/3，詞變多後再縮小並保留詞頻對比
- [x] 文字雲同一觀眾可送出最多 3 則，不再覆寫第一則
- [x] 講者可點選文字雲詞彙釘住：位置固定、加上金框，其他人送答案時其餘詞仍可動
- [x] 投影頁標題縮小，文字雲畫布約占畫面高度 2/3
- [x] 投影頁狀態（即時結果／收集中）改放 LIVE 右側，不再單獨佔一列

## 邏輯與 UX 整理重構（dev/wmou/logic-ux-cleanup）

### 階段 0：基線

- [x] 建立測試綠色基線（2026-08-27）。主機無 node/pnpm，`scripts/ci.sh` 容器化 CI 過重，改在 `node:22-bookworm` 容器內跑：
  - `docker run --rm -v "$PWD":/workspace -w /workspace node:22-bookworm sh -c "corepack enable; pnpm install --frozen-lockfile"`（原 `node_modules` 過舊，缺 `qrcode-generator`，重裝後解決）
  - `pnpm --filter @slide-helper/web test`：4 檔 10 tests 全過
  - `pnpm --filter @slide-helper/web check`（tsc --noEmit）：過
  - `pnpm --filter @slide-helper/web build`（vite build）：過
  - 全 workspace `pnpm check && pnpm test`（含 extension 2 檔 10 tests）：全過
- [x] 未跑 `cargo test`（後端由另一位平行處理，避免 target/ 競爭）

### 階段 1：實際走查（五角色流程）

- [x] Compose stack 已於本機 18666 埠運行（`/api/version` 健康），沿用現有容器
- [x] 走查方式：本機無瀏覽器可操作 GUI，改以腳本走完整 API 流程（`node:22` 容器 + `--network host`），並比對前端程式碼行為；腳本內容見 commit 訊息（暫存於 /tmp，不入版控）
- [x] 流程全數通過：guest 登入 → 建專案/cue/四種互動 → 開場次（open_lobby → start → prepare_cue，immediate cue 直接進 open）→ 觀眾加入作答（理解度/單選/文字雲/Q&A）→ controller token 走 Remote（snapshot、live、翻頁、釘問題、釘文字雲）→ presenter/overlay token 取 live view → reveal → QR 首頁切換（cue run 保留）→ end → results + CSV 匯出
- [x] 結果可見性驗證：單選（after_reveal）在 reveal 前 audience/overlay 的 live view 都看不到統計，reveal 後看得到；文字雲/理解度（live）即時可見

#### 走查發現的 UX 問題清單（僅記錄；視覺相關不動手）

- [ ] （行為、後端）觀眾送出 after_reveal 單選答案時，POST 回應本身就附上完整統計 aggregate（含各選項票數），揭曉前就能從 network 面板看到；live view 有正確隱藏，但作答回應洩漏。屬後端行為，本次不動
- [ ] （行為）Remote 翻頁在 Extension 未配對時仍回 accepted=true，指令進佇列後沒人消費，使用者按「下一頁」毫無回饋也不知道沒效果
- [ ] （行為）觀眾文字雲輸入框 maxLength=200，但後端對重複字元等內容會回 response_text_rejected，觀眾只看到 generic 錯誤碼訊息，不知道為什麼被拒
- [ ] （行為）Landing 首頁參加碼輸入框接受英數字（pattern A-Za-z0-9），但送出時 `join()` 會把非數字全部剝掉（\D）：輸入「AB12」會導去 /join/12；現行參加碼已是六位純數字，兩處輸入規則不一致
- [ ] （行為）LiveControl 的「配對 Extension」「手機遙控」「開投影」等按鈕的 API 失敗沒有接 report()，按了沒反應也沒錯誤訊息（unhandled rejection）
- [ ] （計畫已列）手動 sync 直接 window.location.reload()，丟掉所有 UI 狀態 → 階段 4 修
- [ ] （計畫已列）InteractionEditForm useEffect 依賴整個 item object，refreshProject 後物件 identity 變了會把使用者正在編輯的內容洗掉 → 階段 4 修
- [ ] （計畫已列）Remote 錯誤處理用 "auth"/"token"/"load" 魔術字串，其餘錯誤直接把 API error code 丟給使用者 → 階段 4 修
- [ ] （計畫已列）Extension popup 與 Presenter 模板/cue 名稱硬編碼中英文，未走 packages/i18n → 階段 4 修

### 階段 2：低風險清理

- [x] 刪除 presenterLive dead 輪詢（state、cueLiveCache ref、effect、rememberPresenterLive；每 2.5 秒白打一次 token + live API）
- [x] 刪除無人引用的 AudienceJoinQrPanel（i18n key 與 CSS 先保留，維持純 dead code 移除）
- [x] Translate 型別集中到 `apps/web/src/i18n.ts`，key 改用 `MessageKey`（原本六個檔案各自宣告 `key: any`，繞過 i18n 型別檢查；tsc 證明所有動態 key 都存在於 catalog）
- [x] 合併重複邏輯到 `apps/web/src/lib/`：`typeName`（原兩份）、`parseOptions`（原兩份）、QR SVG 產生（原兩份，保留各自 cellSize 維持視覺不變）
- [x] 每步皆通過 vitest（10 tests）+ tsc --noEmit

## 投影畫面三種風格

- [x] 抽出 `data-projection-theme`，讓投影／結果頁可抽換風格
- [x] 經典：沿用現有深綠、金色、Georgia 高貴感
- [x] 活潑：淺色、圓角、高彩度長條，接近 Mentimeter
- [x] 終端機：黑底綠字、等寬字體、標題打字機效果
- [x] 講者控制列與投影頁皆可切換，並以 localStorage／BroadcastChannel 同步
- [x] 已重建 `slide-helper-web:dev` 並重啟 web 容器（2026-08-15 14:25）
- [x] 活潑主題高分詞改紫光、拿掉黃字；終端機理解度改 zsh 綠／黃／紅
- [x] 投影頁切換風格／點文字雲時不再留下瀏覽器 focus 藍框
- [x] 活潑主題高分詞取消光暈陰影
