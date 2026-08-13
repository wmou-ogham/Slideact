# Guest Vault

訪客模式讓講者不必先完成 Google OAuth 就能開始使用 Slide Helper。第一次按下「以訪客模式繼續」時，API 會在同一個 transaction 中建立：

- 一個沒有 email 的 guest profile
- 一個與該 profile 一對一的 `guest_vaults` 記錄
- 一個長效 session

Guest Vault 沒有服務使用期限。資料會依照一般 project、cue、session 授權規則隔離，訪客只能透過自己的 session 存取自己的 Vault。

## 瀏覽器與跨裝置行為

訪客 session 以 HttpOnly cookie 保存，cookie Max-Age 為十年，資料庫 session 使用 PostgreSQL `infinity` expiration，因此不會因為產品內建的短期 session TTL 而失效。登出、清除瀏覽器 cookie，或管理員撤銷 session 後，原本的訪客身份便無法從另一個裝置自動還原。

訪客若要跨裝置延續，應改用 Google 登入。後續可以再加入「將 Guest Vault 綁定到 Google 帳號」的升級流程；目前不會自動合併兩種帳號，以避免未經確認的資料轉移。

## 資料生命週期

目前不會自動刪除 Guest Vault，也沒有時間限制。`guest_vaults.last_seen_at` 用於未來提供明確的資料保留政策、使用者自助刪除或管理員清理工具；在政策確定前不應以它作為自動刪除條件。

## API

```http
POST /api/auth/guest
Content-Type: application/json

{"locale":"zh-TW"}
```

第一次呼叫回傳 `201`，後續帶著同一個 cookie 呼叫會回傳 `200` 並重用同一個 `vault_id`。`GET /api/auth/me` 會回傳 `account_type: "guest"` 與 `vault_id`，前端可用此資訊顯示 Guest Vault 狀態。
