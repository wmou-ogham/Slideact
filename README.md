# Slide Helper

跨 Google Slides、PowerPoint、Keynote 與 OBS 的即時觀眾互動層。

目前專案已完成 Pre-MVP／M0 技術驗證，正在進行 M1 核心平台開發。架構採 Rust Backend、Google OAuth、`zh-TW`／`en` i18n，以及 Docker Compose 全容器開發／部署環境。完整產品範圍、系統架構、資料模型、測試策略、風險與 10～12 週開發里程碑請見：

- [完整開發計畫](docs/DEVELOPMENT_PLAN.md)
- [Google OAuth 設定](docs/GOOGLE_OAUTH_SETUP.md)
- [Session Token 與即時權限](docs/AUTHORIZATION.md)
- [Realtime Events 與 Transactional Outbox](docs/REALTIME_EVENTS.md)
- [Google Slides Extension 安裝與相容性](docs/GOOGLE_SLIDES_EXTENSION.md)
- [100 人效能基準](docs/PERFORMANCE.md)
- [隱私與資料刪除](docs/PRIVACY.md)
- [系統診斷與錯誤追蹤](docs/DIAGNOSTICS.md)
- [無障礙與中英文驗收](docs/ACCESSIBILITY_I18N.md)

## 啟動開發堆疊

```sh
docker compose up --detach --build --wait
```

啟動後可在 `http://localhost:8080` 查看 Web UI。API、WebSocket、PostgreSQL、Redis、migration、worker、Web 與反向代理都由 Compose 管理。

## 執行完整驗證

```sh
./scripts/ci.sh
```

CI 僅要求 Docker；Rust 格式、Clippy、Rust 測試、前端型別檢查、前端測試、Web／Extension 正式建置，以及 API／WebSocket smoke test 都在容器內執行。

## 更新共用 Protocol 型別

Rust `crates/protocol` 是 wire contract 的單一來源。修改共用 HTTP／WebSocket payload 後執行：

```sh
./scripts/generate-protocol-types.sh
```

產物會寫入 `packages/protocol/src/generated.ts`。完整 CI 會以 `--check` 模式比對產物，避免 Rust 與 TypeScript contract 漂移。

Google Slides Extension 位於 `apps/extension`，輸出為可載入 Chrome 的 Manifest V3 extension，提供安全配對、自動跟隨、Overlay 注入、heartbeat 診斷與手動接手。
