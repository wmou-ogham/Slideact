# Slideact Beta 交付狀態

最後稽核：2026-08-13  
稽核版本：`832de6e`

## 結論

Slideact 的封閉 Beta 軟體範圍已完成並部署。講者工作室、觀眾互動、投影結果、OBS、手機遙控器、Guest Vault、Google OAuth 流程、Google Slides Extension、自動／手動接手、雙語介面、容器化服務與 CI 均已有實作和自動化驗證。

尚未完成的項目都需要程式庫以外的憑證、瀏覽器安裝或真人參與，不能用自動測試代替。未完成項目列於「外部發布閘門」，在取得條件前不得宣稱正式上線驗收完成。

## 已完成證據

- 遠端部署位置：`/home/moriss/slide-helper`
- 對外測試入口：`http://10.121.180.185:8080/`
- Git 分支：`main`
- 最新提交已使用 SSH key 簽章並通過 `git verify-commit`。
- Git remote：`git@github.com:wmou-ogham/Slideact.git`
- API、Web、Worker、Proxy、PostgreSQL、Redis 六個容器在本次稽核時皆為 `healthy`。
- 完整容器化 CI：`logs/ci-20260813-reveal-reopen.log`
  - Rust 測試組：22、18、6 項全部通過。
  - Extension 測試：7 項全部通過。
  - Web 測試：4 項全部通過。
  - i18n／protocol 測試：4／3 項全部通過。
  - API 與 WebSocket smoke test 通過。
  - 100 位並行觀眾基準：join p95 685 ms、response p95 652 ms。
- 最新 Extension 產物：`artifacts/slideact-extension-832de6e.tar.gz`
- Extension SHA-256：`314b2f368c8c95e755a2db4c560c4fcb2fc281f99612ba784ddafaf6f9395861`
- Extension build log：`logs/build-extension-832de6e.log`
- GitHub Actions workflow：`.github/workflows/ci.yml`，在 `main` push 與 pull request 執行 `scripts/ci.sh`，保存完整 log artifact 並只在輸出中列出摘要。
- `sudo.log` 證實本專案至今沒有執行 sudo 指令。

## 本輪 UX 驗收

- 專案側邊欄可收合。
- Cue 以一基底投影片頁碼或穩定 Google Slides ID 映射，並接受完整 Slides URL。
- Cue 預設立即開啟，既有 Cue 與互動皆可展開編輯或刪除，新增表單置於清單底部。
- 結果可見性只提供「即時公開」與「講者公布後顯示」。
- 講者可直接開啟不透明的全螢幕投影結果；OBS 透明 Overlay 維持獨立入口。
- 文字雲使用 `@visx/wordcloud`，以權重控制字級、旋轉與配置，並改善前景／背景對比。
- 手機遙控 QR 使用八小時、單一活動範圍的 controller token，放在 URL fragment；不暴露 Guest Vault 或登入 cookie。
- 現場 Cue 下拉會保留目前選擇；立即開啟 Cue 會直接進入可作答狀態。
- 桌面與手機移除暫停／關閉作答操作，只保留「公布結果」及保留既有回覆的「重新開放作答」。
- 手機遙控可上一頁／下一頁；Extension 以短期 FIFO 佇列依序消費導覽命令，且在手動 Cue 模式仍可回控 Google Slides。
- Q&A 預設即時公開，觀眾頁及全螢幕投影頁都會顯示公開問題。
- 不支援 Extension 的簡報工具仍可使用手動 Cue 控制。

## 外部發布閘門

### 1. 正式 Google OAuth

目前 `GET /api/version` 回報 `google_oauth_configured: false`。需要提供：

- 可公開連線的 HTTPS 網域。
- Google Cloud OAuth Web client ID 與 client secret。
- 完全相符的 callback：`https://<domain>/api/auth/google/callback`。

憑證只能透過部署環境變數或 secret manager 注入，不得提交到 Git。設定與驗證步驟見 `docs/GOOGLE_OAUTH_SETUP.md`。

### 2. 真實 Google Slides Extension E2E

需要一個已登入 Google 的 Chrome 工作階段，於 `chrome://extensions` 載入上述解壓縮產物，並用真實 deck 逐項驗證：

1. 配對、首次 deck 綁定與三張以上 Cue 映射。
2. 編輯模式與投影模式的前進／後退自動跟隨。
3. 手機遙控上一頁／下一頁回控 Google Slides。
4. Auto → Manual 無損接手。
5. 斷線、service worker 休眠、重連與 resync 確認。
6. Overlay 注入與投影頁結果一致。

操作與相容性矩陣見 `docs/GOOGLE_SLIDES_EXTENSION.md`。Google Slides DOM 並非公開 API，因此這個人工驗收是發布必要條件。

### 3. 5～10 位講者封閉測試

需要真人講者涵蓋教學、Lightning Talk、產品 Demo 三種情境。腳本、通過門檻與問題清單見 `docs/BETA_TEST.md`。自動化 CI、100 人合成壓測與單人瀏覽器驗收不能替代此項。

### 4. GitHub repository 管理面設定

程式碼已推送至 `git@github.com:wmou-ogham/Slideact.git`，README 已包含指定描述：

> A Slido alternative for live polls, quizzes, word clouds, Q&A, and real-time audience feedback that works with Google Slides and more.

仍需具有 repository 管理權限的 GitHub 登入工作階段，才能確認 GitHub Actions 雲端 run 並把相同文字寫入 repository 的 About description。這不影響遠端部署或本地容器化 CI 結果。

## 交付前最短檢查

```sh
git verify-commit HEAD
docker compose ps
sha256sum artifacts/slideact-extension-832de6e.tar.gz
curl -fsS http://127.0.0.1:8080/api/version
grep -E "API and WebSocket smoke test passed|100-person|test result:|Tasks:" logs/ci-20260813-reveal-reopen.log
```

正式 Beta 放行條件：上述四個外部發布閘門完成，且沒有未解決的資料遺失、跨帳號存取、錯誤投影片跳轉或無法恢復的現場活動問題。
