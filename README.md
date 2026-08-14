# Slideact

A Slido alternative for live polls, quizzes, word clouds, Q&A, and real-time audience feedback that works with Google Slides and more.

Slideact is a live audience-interaction layer for existing decks. It does not replace Google Slides, PowerPoint, Keynote, PDF, or Canva. Presenters keep their slides; the room scans a QR code once; results can stay presenter-only or appear on a projection page and a transparent OBS overlay.

**Languages:** Traditional Chinese (`zh-TW`) and English (`en`) are first-class product surfaces, not a later translation pass.

**Status:** Closed-beta software is implemented and covered by containerized CI. Remaining release gates (production Google OAuth, real-deck Extension E2E, and a 5–10 presenter beta) are listed in [docs/RELEASE_STATUS.md](docs/RELEASE_STATUS.md).

---

## Table of contents

- [Why Slideact](#why-slideact)
- [Features](#features)
- [How a live session works](#how-a-live-session-works)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Web surfaces](#web-surfaces)
- [Google Slides extension](#google-slides-extension)
- [Protocol types](#protocol-types)
- [Testing and CI](#testing-and-ci)
- [Documentation](#documentation)
- [Privacy and security](#privacy-and-security)
- [License](#license)
- [中文](#slideact-1)

---

## Why Slideact

Presenters already have a deck. What they lack is a way to read the room without rewriting the slides or asking everyone to install an app.

- **Keep the deck.** Google Slides, PowerPoint, Keynote, and OBS stay in charge of visuals. Slideact owns cues, triggers, results, and presenter decisions.
- **Zero install for the audience.** One six-digit join code or QR scan. No account, no app store.
- **Auto-follow is an adapter, not the core.** A Chrome extension can follow Google Slides by real `slideId`. Manual cue control is a first-class path for every other tool, and can take over without clearing answers.
- **Presenter results and public results are separate.** Live reveal and presenter-reveal-later are enforced by the API and WebSocket payloads, not by hiding a button.

## Features

| Area | What you get |
| --- | --- |
| Interactions | Green / yellow / red understanding checks, multiple-choice polls, word clouds, Q&A with votes, pin, answer, and hide |
| Authoring | Three-column editor, slide-number or Google Slides ID mapping, teaching / Lightning Talk / product-demo templates, duplicate and archive |
| Live control | Presenter console, phone remote with previous / next, QR-code join screen, reveal results, reopen answers without wiping replies |
| Display | Full-screen presenter projection, transparent OBS overlay, in-Slides overlay injection |
| Follow modes | Auto (extension), paused, manual, disconnected, resync-required — handoff never closes the current cue run |
| Identity | Google OpenID Connect (PKCE) or a long-lived Guest Vault with downloadable recovery key |
| Locale | `zh-TW` and `en` across Web, Extension, Audience, Remote, Overlay, and API error codes |
| After the room | Permanent session history, CSV export, account deletion |

## How a live session works

1. The presenter creates a project, maps cues to slides, and starts a live session.
2. The audience joins with a six-digit code or QR code. Each participant gets an anonymous session token.
3. In **auto** mode, the Google Slides extension reports the visible slide and opens the mapped cue. In **manual** mode, the console or phone remote is authoritative.
4. Answers persist in PostgreSQL. Realtime fan-out is at-least-once via a transactional outbox, Redis Pub/Sub, and WebSocket topics.
5. After disconnects or an auto → manual takeover, clients recover from a server snapshot. Existing answers, statistics, and open questions are not reset.

Capacity target for the current baseline: **100 concurrent audience members** on a single Compose host, with join and response p95 well under the 5 s CI gate. See [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

## Architecture

```text
Presenter / Audience / Overlay / Extension
        │  HTTPS + WebSocket
        ▼
     Nginx proxy
     ├── Web (React)
     └── API (Rust / Axum)
              │
              ├── PostgreSQL   authoritative state, sessions, outbox
              ├── Redis        rate limits + Pub/Sub fan-out
              └── Worker       leases outbox rows and publishes events
```

- **PostgreSQL** is the source of truth. Redis is a low-latency fan-out and rate-limit layer, not a second database of record.
- Role-scoped opaque tokens (`owner`, `presenter`, `controller`, `audience`, `overlay`, `extension`) subscribe only to their allowed topics. Raw tokens are never stored; the database keeps SHA-256 hashes.
- Shared HTTP and WebSocket payloads live in `crates/protocol` and are generated into TypeScript.

## Repository layout

```text
apps/web              Presenter studio, audience, remote, overlay, projection
apps/extension        Chrome Manifest V3 Google Slides adapter
services/api          Axum HTTP + WebSocket API
services/worker       Transactional outbox publisher
crates/domain         Session, CueRun, and sync-mode state machines
crates/protocol       Wire-contract source of truth (Rust → TypeScript)
packages/i18n         zh-TW / en message catalogs
packages/protocol     Generated TypeScript client types
migrations/           PostgreSQL schema
infra/                Dockerfiles, Nginx, Caddy
docs/                 Product, security, and operations docs
scripts/ci.sh         Full containerized verification
```

## Quick start

Requirements: **Docker**. Local Rust, Node, and pnpm are optional; CI and the Compose stack run inside containers.

```sh
cp .env.example .env
docker compose up --detach --build --wait
```

The proxy publishes **http://localhost:18666** by default (`SLIDE_HELPER_PORT`). API, WebSocket, PostgreSQL, Redis, migrations, worker, Web, and the reverse proxy are all Compose-managed.

```sh
curl -fsS http://127.0.0.1:18666/api/version
```

Open the studio at `/presenter`. Audience join is `/join/<six-digit-code>`.

## Configuration

Copy [`.env.example`](.env.example). The three Google OAuth values must be set together or left empty as a group.

| Variable | Purpose |
| --- | --- |
| `SLIDE_HELPER_PORT` | Host port for the proxy (default `18666`) |
| `GOOGLE_OAUTH_CLIENT_ID` | Google OAuth Web client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth client secret — never commit this |
| `GOOGLE_OAUTH_REDIRECT_URL` | Exact callback, e.g. `http://localhost:18666/api/auth/google/callback` |
| `AUTH_COOKIE_SECURE` | `false` on local HTTP; `true` behind HTTPS |
| `DEV_AUTH_ENABLED` | Development-only auth bypass; keep `false` outside local experiments |

Partial OAuth configuration refuses to boot so a half-wired login flow cannot ship. With all three values empty, the API starts and Google login returns `503 auth_not_configured`. Guest Vault still works.

Setup steps: [docs/GOOGLE_OAUTH_SETUP.md](docs/GOOGLE_OAUTH_SETUP.md). Guest recovery: [docs/GUEST_VAULT.md](docs/GUEST_VAULT.md).

## Web surfaces

| Path | Role |
| --- | --- |
| `/` | Landing, join-code entry |
| `/presenter` | Studio, editor, live console |
| `/join/:code` | Audience |
| `/remote/:token` | Phone remote (controller token in the URL fragment) |
| `/projection/:session` | Opaque full-screen results |
| `/overlay/:session` | Transparent OBS Browser Source |
| `/diagnostics` | Readiness, OAuth status, recent client errors |

Phone remote QR codes carry an eight-hour, single-session controller token. They never include the Google cookie or Guest Vault credential.

## Google Slides extension

Build output is a loadable Chrome MV3 extension at `apps/extension/.output/chrome-mv3`.

1. `pnpm --filter @slide-helper/extension build` (also produced by `scripts/ci.sh`)
2. Chrome → `chrome://extensions` → Developer mode → Load unpacked
3. In a live session, choose **Pair Slides extension** and enter the eight-character code within ten minutes
4. Open the Google Slides editor or slideshow; the first detected deck binds to that session

Cues map to a one-based slide number or a stable Google Slides ID. **Use manual control** at any time; that switch does not end the live session or drop answers.

Install, compatibility matrix, heartbeat, and resync states: [docs/GOOGLE_SLIDES_EXTENSION.md](docs/GOOGLE_SLIDES_EXTENSION.md).

## Protocol types

`crates/protocol` is the single source of truth for HTTP and WebSocket payloads. After changing shared types:

```sh
./scripts/generate-protocol-types.sh
```

Output lands in `packages/protocol/src/generated.ts`. Full CI runs the generator in `--check` mode so Rust and TypeScript cannot drift.

## Testing and CI

```sh
./scripts/ci.sh
```

CI needs only Docker. Inside containers it runs Rustfmt, Clippy, Rust tests, protocol generation `--check`, frontend typecheck and tests, Web and Extension production builds, API / WebSocket smoke tests, and a 100-person join/response baseline.

GitHub Actions (`.github/workflows/ci.yml`) runs the same script on `main` and pull requests and retains the full log artifact for 14 days.

## Documentation

| Document | Topic |
| --- | --- |
| [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md) | Product scope, architecture, milestones |
| [docs/RELEASE_STATUS.md](docs/RELEASE_STATUS.md) | Closed-beta delivery status and external gates |
| [docs/GOOGLE_OAUTH_SETUP.md](docs/GOOGLE_OAUTH_SETUP.md) | Google OpenID Connect |
| [docs/GUEST_VAULT.md](docs/GUEST_VAULT.md) | Guest mode and vault recovery |
| [docs/AUTHORIZATION.md](docs/AUTHORIZATION.md) | Session tokens and topic scopes |
| [docs/REALTIME_EVENTS.md](docs/REALTIME_EVENTS.md) | Outbox, Redis, WebSocket recovery |
| [docs/GOOGLE_SLIDES_EXTENSION.md](docs/GOOGLE_SLIDES_EXTENSION.md) | Pairing, mapping, compatibility |
| [docs/PERFORMANCE.md](docs/PERFORMANCE.md) | 100-person baseline |
| [docs/PRIVACY.md](docs/PRIVACY.md) | Data categories and account deletion |
| [docs/SECURITY.md](docs/SECURITY.md) | Rate limits and abuse controls |
| [docs/DIAGNOSTICS.md](docs/DIAGNOSTICS.md) | Error tracking and readiness |
| [docs/ACCESSIBILITY_I18N.md](docs/ACCESSIBILITY_I18N.md) | a11y and bilingual acceptance |
| [docs/BETA_TEST.md](docs/BETA_TEST.md) | 5–10 presenter closed-beta script |

## Privacy and security

- Audience members are anonymous per session. Names and emails are not collected.
- Google login stores provider `sub`, optional verified email, display name, and locale. Google access and refresh tokens are not retained.
- Guest Vault recovery files contain a one-time key; the server stores only the SHA-256 hash. Downloading again rotates the key.
- Presenters can delete their account from the profile menu. Cascades remove owned projects, sessions, responses, pairings, and sessions. This cannot be undone.
- Audience writes are rate-limited and basic text-abuse checks reject repeated-character and link-spam payloads.

Details: [docs/PRIVACY.md](docs/PRIVACY.md), [docs/SECURITY.md](docs/SECURITY.md).

## License

MIT. See the workspace `license` field in [`Cargo.toml`](Cargo.toml).

---
---

# Slideact

Slido 的替代方案：即時投票、測驗、文字雲、Q&A 與觀眾回饋，可搭配 Google Slides 與其他簡報工具。

Slideact 是掛在既有簡報上的即時觀眾互動層。它不取代 Google Slides、PowerPoint、Keynote、PDF 或 Canva。講者沿用原本的投影片；觀眾掃一次 QR Code；結果可以只給講者看，也可以顯示在投影頁與透明 OBS Overlay 上。

**語系：** 繁體中文（`zh-TW`）與英文（`en`）同為 P0 產品能力，不是做完中文再翻譯。

**狀態：** 封閉 Beta 軟體範圍已實作，並由容器化 CI 覆蓋。尚未完成的發布閘門（正式 Google OAuth、真實 Deck 的 Extension E2E、5～10 位講者 Beta）見 [docs/RELEASE_STATUS.md](docs/RELEASE_STATUS.md)。

---

## 目錄

- [為什麼做 Slideact](#為什麼做-slideact)
- [功能](#功能)
- [一場活動怎麼跑](#一場活動怎麼跑)
- [系統架構](#系統架構)
- [目錄結構](#目錄結構)
- [快速開始](#快速開始)
- [設定](#設定)
- [Web 介面](#web-介面)
- [Google Slides 擴充功能](#google-slides-擴充功能)
- [Protocol 型別](#protocol-型別)
- [測試與 CI](#測試與-ci)
- [文件](#文件)
- [隱私與安全](#隱私與安全)
- [授權](#授權)

---

## 為什麼做 Slideact

講者已經有簡報。缺的是不必重做投影片、也不必請全場裝 App，就能讀懂現場的方式。

- **不重做簡報。** 視覺仍由 Google Slides、PowerPoint、Keynote、OBS 負責。Slideact 負責 Cue、觸發、結果與講者決策。
- **觀眾零安裝。** 六位數參加碼或 QR Code 掃一次即可。不必註冊，不必上應用程式商店。
- **自動跟隨是 Adapter，不是核心。** Chrome 擴充功能可依實際 `slideId` 跟隨 Google Slides。其他工具走第一級的手動 Cue，且可隨時接手，不清空已作答內容。
- **講者結果與公開結果分離。** 「即時公開」與「講者公布後顯示」由 API 與 WebSocket payload 強制執行，不是只靠藏按鈕。

## 功能

| 範圍 | 內容 |
| --- | --- |
| 互動題型 | 綠／黃／紅三段理解度、單選投票、文字雲、Q&A（按讚、置頂、回覆、隱藏） |
| 編輯 | 三欄式編輯器、頁碼或 Google Slides ID 映射、教學／Lightning Talk／產品 Demo 模板、複製與封存 |
| 現場控制 | 講者控制台、含上一頁／下一頁的手機遙控、QR Code 加入畫面、公布結果、保留回覆後重新開放作答 |
| 顯示 | 不透明全螢幕投影、透明 OBS Overlay、於 Slides 內注入 Overlay |
| 跟隨模式 | 自動、暫停、手動、斷線、待重新同步 — 接手時不關閉目前的 Cue run |
| 身分 | Google OpenID Connect（PKCE），或可下載復原金鑰的長效 Guest Vault |
| 語系 | Web、擴充功能、觀眾、遙控、Overlay 與 API 錯誤碼皆支援 `zh-TW`／`en` |
| 活動之後 | 永久結果紀錄、CSV 匯出、刪除帳號 |

## 一場活動怎麼跑

1. 講者建立專案、把 Cue 對應到投影片，並開始 Live Session。
2. 觀眾用六位數參加碼或 QR Code 加入，取得匿名場次 token。
3. **自動模式**由 Google Slides 擴充功能回報目前可見頁並開啟對應 Cue。**手動模式**以控制台或手機遙控為準。
4. 回答寫入 PostgreSQL。即時廣播採至少一次語意：transactional outbox → Redis Pub/Sub → WebSocket topic。
5. 斷線或自動改手動接手後，Client 以伺服器快照恢復。既有回答、統計與公開問題不會被重置。

目前基準容量：**單一 Compose 主機 100 位同時在線觀眾**，加入與作答 p95 遠低於 CI 的 5 秒門檻。見 [docs/PERFORMANCE.md](docs/PERFORMANCE.md)。

## 系統架構

```text
講者／觀眾／Overlay／擴充功能
        │  HTTPS + WebSocket
        ▼
     Nginx 反向代理
     ├── Web（React）
     └── API（Rust / Axum）
              │
              ├── PostgreSQL   權威狀態、session、outbox
              ├── Redis        速率限制 + Pub/Sub 扇出
              └── Worker       租約 outbox 列並發布事件
```

- **PostgreSQL** 是唯一權威來源。Redis 只做低延遲扇出與速率限制，不是第二套紀錄庫。
- 依角色發行不透明 token（`owner`、`presenter`、`controller`、`audience`、`overlay`、`extension`），只能訂閱允許的 topic。原始 token 不落盤，資料庫只存 SHA-256 hash。
- 共用 HTTP／WebSocket payload 以 `crates/protocol` 為單一來源，再產生 TypeScript。

## 目錄結構

```text
apps/web              講者工作室、觀眾、遙控、Overlay、投影
apps/extension        Chrome Manifest V3 Google Slides adapter
services/api          Axum HTTP + WebSocket API
services/worker       Transactional outbox 發布器
crates/domain         Session、CueRun、同步模式狀態機
crates/protocol       線上合約來源（Rust → TypeScript）
packages/i18n         zh-TW／en 文案 catalog
packages/protocol     產生的 TypeScript client 型別
migrations/           PostgreSQL schema
infra/                Dockerfile、Nginx、Caddy
docs/                 產品、安全與維運文件
scripts/ci.sh         完整容器化驗證
```

## 快速開始

需求：**Docker**。本機 Rust、Node、pnpm 可選；CI 與 Compose 堆疊都在容器內執行。

```sh
cp .env.example .env
docker compose up --detach --build --wait
```

反向代理預設對外為 **http://localhost:18666**（`SLIDE_HELPER_PORT`）。API、WebSocket、PostgreSQL、Redis、migration、worker、Web 與反向代理皆由 Compose 管理。

```sh
curl -fsS http://127.0.0.1:18666/api/version
```

工作室入口為 `/presenter`。觀眾加入為 `/join/<六位數參加碼>`。

## 設定

複製 [`.env.example`](.env.example)。三個 Google OAuth 值必須一起設定，或整組留空。

| 變數 | 用途 |
| --- | --- |
| `SLIDE_HELPER_PORT` | 反向代理主機埠（預設 `18666`） |
| `GOOGLE_OAUTH_CLIENT_ID` | Google OAuth Web client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth client secret — 不得提交到 Git |
| `GOOGLE_OAUTH_REDIRECT_URL` | 完全相符的 callback，例如 `http://localhost:18666/api/auth/google/callback` |
| `AUTH_COOKIE_SECURE` | 本機 HTTP 用 `false`；HTTPS 必須 `true` |
| `DEV_AUTH_ENABLED` | 僅供開發的 auth 繞過；非正式實驗請保持 `false` |

OAuth 只設一部分會拒絕啟動，避免半套登入流程上線。三個值皆空時 API 仍可啟動，Google 登入回 `503 auth_not_configured`。Guest Vault 仍可用。

設定步驟：[docs/GOOGLE_OAUTH_SETUP.md](docs/GOOGLE_OAUTH_SETUP.md)。訪客復原：[docs/GUEST_VAULT.md](docs/GUEST_VAULT.md)。

## Web 介面

| 路徑 | 角色 |
| --- | --- |
| `/` | 首頁、參加碼輸入 |
| `/presenter` | 工作室、編輯器、現場控制台 |
| `/join/:code` | 觀眾 |
| `/remote/:token` | 手機遙控（controller token 放在 URL fragment） |
| `/projection/:session` | 不透明全螢幕結果 |
| `/overlay/:session` | 透明 OBS Browser Source |
| `/diagnostics` | 就緒狀態、OAuth 設定、近期用戶端錯誤 |

手機遙控 QR Code 只帶八小時、單一活動範圍的 controller token，不含 Google cookie 或 Guest Vault 憑證。

## Google Slides 擴充功能

建置產物為可載入的 Chrome MV3 擴充功能，位於 `apps/extension/.output/chrome-mv3`。

1. `pnpm --filter @slide-helper/extension build`（`scripts/ci.sh` 也會建置）
2. Chrome → `chrome://extensions` → 開發人員模式 → 載入未封裝項目
3. 在 Live Session 選擇 **配對 Slides 擴充功能**，於十分鐘內輸入八字元配對碼
4. 開啟 Google Slides 編輯或投影網址；偵測到的第一份 deck 會綁定該場次

Cue 可對應一基底頁碼或穩定的 Google Slides ID。隨時可改用**手動控制**；不會結束活動，也不會丟掉回答。

安裝、相容性矩陣、heartbeat 與重新同步狀態：[docs/GOOGLE_SLIDES_EXTENSION.md](docs/GOOGLE_SLIDES_EXTENSION.md)。

## Protocol 型別

`crates/protocol` 是 HTTP／WebSocket payload 的單一來源。修改共用型別後執行：

```sh
./scripts/generate-protocol-types.sh
```

產物寫入 `packages/protocol/src/generated.ts`。完整 CI 以 `--check` 比對產物，避免 Rust 與 TypeScript 合約漂移。

## 測試與 CI

```sh
./scripts/ci.sh
```

CI 只需要 Docker。容器內會跑 Rustfmt、Clippy、Rust 測試、protocol `--check`、前端型別檢查與測試、Web／擴充功能正式建置、API／WebSocket smoke test，以及 100 人加入／作答基準。

GitHub Actions（`.github/workflows/ci.yml`）在 `main` 與 pull request 執行同一支腳本，完整 log artifact 保留 14 天。

## 文件

| 文件 | 主題 |
| --- | --- |
| [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md) | 產品範圍、架構、里程碑 |
| [docs/RELEASE_STATUS.md](docs/RELEASE_STATUS.md) | 封閉 Beta 交付狀態與外部閘門 |
| [docs/GOOGLE_OAUTH_SETUP.md](docs/GOOGLE_OAUTH_SETUP.md) | Google OpenID Connect |
| [docs/GUEST_VAULT.md](docs/GUEST_VAULT.md) | 訪客模式與 Vault 復原 |
| [docs/AUTHORIZATION.md](docs/AUTHORIZATION.md) | Session token 與 topic 範圍 |
| [docs/REALTIME_EVENTS.md](docs/REALTIME_EVENTS.md) | Outbox、Redis、WebSocket 恢復 |
| [docs/GOOGLE_SLIDES_EXTENSION.md](docs/GOOGLE_SLIDES_EXTENSION.md) | 配對、映射、相容性 |
| [docs/PERFORMANCE.md](docs/PERFORMANCE.md) | 100 人效能基準 |
| [docs/PRIVACY.md](docs/PRIVACY.md) | 資料類別與刪除帳號 |
| [docs/SECURITY.md](docs/SECURITY.md) | 速率限制與濫用防護 |
| [docs/DIAGNOSTICS.md](docs/DIAGNOSTICS.md) | 錯誤追蹤與就緒狀態 |
| [docs/ACCESSIBILITY_I18N.md](docs/ACCESSIBILITY_I18N.md) | 無障礙與中英文驗收 |
| [docs/BETA_TEST.md](docs/BETA_TEST.md) | 5～10 位講者封閉 Beta 腳本 |

## 隱私與安全

- 觀眾以場次匿名識別，不收集姓名與 email。
- Google 登入只保存 provider `sub`、可選的已驗證 email、顯示名稱與語系。不保存 Google access／refresh token。
- Guest Vault 復原檔含一次性金鑰；伺服器只存 SHA-256 hash。再次下載會輪替金鑰。
- 講者可從個人選單刪除帳號。級聯刪除其專案、場次、回答、配對與 session。此操作無法復原。
- 觀眾寫入有速率限制；基本文字防護會拒絕過度重複字元與連結洗版。

細節：[docs/PRIVACY.md](docs/PRIVACY.md)、[docs/SECURITY.md](docs/SECURITY.md)。

## 授權

MIT。見 [`Cargo.toml`](Cargo.toml) 的 workspace `license` 欄位。
