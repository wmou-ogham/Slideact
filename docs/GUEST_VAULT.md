# Guest Vault

訪客模式讓講者不必先完成 Google OAuth 就能開始使用 Slideact。第一次按下「以訪客模式繼續」時，API 會在同一個 transaction 中建立：

- 一個沒有 email 的 guest profile
- 一個與該 profile 一對一的 `guest_vaults` 記錄
- 一個長效 session

Guest Vault 沒有服務使用期限。資料會依照一般 project、cue、session 授權規則隔離，訪客只能透過自己的 session 存取自己的 Vault。

## 瀏覽器與跨裝置行為

訪客 session 以 HttpOnly cookie 保存，cookie Max-Age 為十年，資料庫 session 使用 PostgreSQL `infinity` expiration，因此不會因為產品內建的短期 session TTL 而失效。登出或清除瀏覽器 cookie 後，同一瀏覽器無法自動還原。

講者可以把 Vault 帶走：工作室右上角的「帶走 Vault」會下載一份 `slideact-vault-….json`。檔案含一次性顯示的 recovery key；伺服器只保存 SHA-256 hash。在另一台電腦的登入頁選擇「開啟 Vault 檔」或貼上金鑰，即可對同一個 Guest Vault 發行新的 session cookie。再次下載會輪替金鑰，舊檔無法再登入；既有瀏覽器 cookie 不受影響。

訪客也可以改用 Google 登入來跨裝置延續。後續可以再加入「將 Guest Vault 綁定到 Google 帳號」的升級流程；目前不會自動合併兩種帳號，以避免未經確認的資料轉移。

## 資料生命週期

目前不會自動刪除 Guest Vault，也沒有時間限制。`guest_vaults.last_seen_at` 用於未來提供明確的資料保留政策、使用者自助刪除或管理員清理工具；在政策確定前不應以它作為自動刪除條件。

## API

```http
POST /api/auth/guest
Content-Type: application/json

{"locale":"zh-TW"}
```

第一次呼叫回傳 `201`，後續帶著同一個 cookie 呼叫會回傳 `200` 並重用同一個 `vault_id`。`GET /api/auth/me` 會回傳 `account_type: "guest"` 與 `vault_id`，前端可用此資訊顯示 Guest Vault 狀態。

```http
POST /api/auth/guest/export
Cookie: slide_helper_session=...
```

僅訪客帳號可呼叫。回傳可下載的 Vault 檔內容，並輪替 recovery key：

```json
{
  "kind": "slideact.guest_vault",
  "version": 1,
  "vault_id": "…",
  "recovery_key": "svlt1.…"
}
```

```http
POST /api/auth/guest/restore
Content-Type: application/json

{"recovery_key":"svlt1.…"}
```

驗證 hash 後發行新的長效訪客 session。金鑰無效時回傳 `401` 與 `guest_vault_recovery_invalid`。
