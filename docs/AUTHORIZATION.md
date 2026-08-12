# Session Token 與即時權限

Slide Helper 將 Google 登入 session 與直播場次 token 分開：

- Google 登入後的 `user_sessions` cookie 用來管理專案與發行場次 token。
- Presenter、Remote、Audience、Overlay 與 Extension 使用短效、單一 session 範圍的 opaque token。
- 資料庫只保存 SHA-256 token hash；原始 token 只在發行時回傳一次。
- token 可由 Owner 撤銷，WebSocket 最多在 5 秒內重新驗證並中止既有連線。

## 角色與 Topic

| Token role | 可訂閱 topic | 預設效期 |
|---|---|---:|
| `owner` | `session:{id}:presenter` | 8 小時 |
| `presenter` | `session:{id}:presenter` | 8 小時 |
| `controller` | `session:{id}:presenter` | 8 小時 |
| `extension` | `session:{id}:presenter` | 24 小時 |
| `audience` | `session:{id}:audience` | 12 小時 |
| `overlay` | `session:{id}:overlay` | 1 小時 |

資料庫中的 `resource_scope.topics` 會和上述角色矩陣同時檢查，因此 scope 只能縮小角色權限，不能把 Audience 或 Overlay 提升成 Presenter。

## Owner Token API

已登入且擁有該 Project 的 Owner 可以建立及撤銷 token：

```http
POST /api/sessions/{session_id}/tokens
Content-Type: application/json
Cookie: slide_helper_session=...

{"role":"presenter"}
```

```http
DELETE /api/sessions/{session_id}/tokens/{token_id}
Cookie: slide_helper_session=...
```

Audience Join 與 Extension Pairing 會在後續里程碑透過受限流程發行各自角色的 token，不會要求匿名觀眾持有 Owner cookie。

## WebSocket

連線時提供短效 token，成功後再訂閱伺服器允許的唯一 topic：

```text
GET /api/ws?token=<opaque-token>
```

```json
{"type":"subscribe","topic":"session:<id>:presenter"}
```

Rust HTTP trace 只記錄 URL path，不記錄 query string，避免 token 進入應用程式 log。Client 不能直接廣播事件；所有狀態 mutation 必須經過後續的授權 command handler、資料庫交易與 outbox。
