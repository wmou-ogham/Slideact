# M0 技術驗證報告

- 驗證日期：2026-08-13
- 遠端環境：`moriss@10.121.180.185`
- 專案位置：`/home/moriss/slide-helper`
- 結果：通過，可進入 M1

## 已驗證項目

- Rust 1.88 workspace 可在容器內完成 `rustfmt`、零警告 Clippy、單元測試與 release build。
- Axum API 提供 liveness、readiness、version 與 WebSocket endpoints。
- readiness 會實際檢查 PostgreSQL 與 Redis，而非只回傳固定狀態。
- migration container 可建立 bootstrap metadata 與 outbox tables。
- worker container 可連線 Redis，API、worker、database、cache、Web、proxy 都有 health check。
- 兩個 WebSocket client 可完成 connect、ping/pong 與 room broadcast smoke test。
- React Web UI 可透過 Caddy 反向代理取得 API 與 WebSocket，瀏覽器實測無 console error／warning。
- `zh-TW` 與 `en` catalog 具備編譯期完整性檢查，瀏覽器實測可即時切換語言。
- WXT 可產生 Chrome Manifest V3 extension；production build 總大小約 14.14 KB。
- Google Slides detector 可解析 deck／slide URL，並組合 hash、history、active DOM 與 visible DOM 訊號。
- Extension popup 支援雙語狀態顯示，以及 Auto／Manual 模式切換。
- GitHub Actions workflow 與本機 `scripts/ci.sh` 共用全容器化驗證流程。
- 隔離的 `slide-helper-ci` Compose project 可完成建置、啟動、health checks、smoke test 與清理。

## 自動化驗證結果

| 類別 | 結果 |
|---|---|
| Rust formatting | 通過 |
| Rust Clippy `-D warnings` | 通過 |
| Rust workspace tests | 2 passed |
| TypeScript workspace checks | 3 packages passed |
| i18n tests | 3 passed |
| Google Slides detector tests | 5 passed |
| Web production build | 通過 |
| Chrome MV3 production build | 通過 |
| Compose health checks | 6 runtime services healthy |
| API／WebSocket smoke test | 通過 |
| 瀏覽器 `zh-TW`／`en` 切換 | 通過 |

## M0 邊界與未解風險

1. Detector 是技術 Spike，不是完整相容性保證。仍需用已登入的 Chrome，在 Google Slides 編輯、present、presenter view 與不同動畫設定下建立 M4 相容性矩陣。
2. Content script 對 URL、hash 與 DOM 使用多訊號偵測；Google 若更動私有 DOM 結構，URL 訊號仍可運作，但無 slide token 的畫面可能退化為 deck-only 狀態。
3. 現階段 WebSocket broadcast 是單一 API process 的記憶體 channel。M1 必須改成 transaction outbox 加 Redis Pub/Sub，才能支援多實例與可靠重播。
4. Auto／Manual 目前只是 extension 本機狀態，尚未接上伺服器權威同步狀態；無損接手與 `RESYNC_REQUIRED` 屬於 M5。
5. Google OAuth／OpenID Connect 尚未實作；目前 API 沒有 application authorization，不能部署為公開服務。
6. Compose 中的資料庫密碼與 HTTP-only proxy 只供本機開發。正式環境必須使用 secret 管理、TLS、secure cookies 與受限制的網路拓樸。
7. GitHub Actions workflow 已建立但尚未在託管 GitHub repository 觸發；本報告的通過結果來自遠端主機執行同一個 `scripts/ci.sh`。
8. 本階段依照放寬後的效能要求，沒有做容量壓測；100 人與 p95 目標留到 M2 基準測試。

## M1 進入條件與優先順序

1. 先建立 `Session`、`CueRun`、`SyncMode` 的 Rust state machines 與 transition tests。
2. 建立 Project、Cue、Live Session、Response 與 OAuth identity schema。
3. 實作 Google OpenID Connect Authorization Code + PKCE，以及 role-scoped application session。
4. 建立版本化 realtime command／event protocol、transaction outbox 與 Redis fan-out。
5. 從 Rust protocol schema 產生 TypeScript client，讓 Web 與 Extension 共用同一份 wire contract。

## 作業紀錄

- 所有階段提交皆使用 `git commit -s -S`，並以 SSH signing key 驗證。
- M0 未執行任何 `sudo` 指令；`sudo.log` 維持「尚未使用」。
