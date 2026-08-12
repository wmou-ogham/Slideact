# Google OAuth 設定

Slide Helper 使用 Google OpenID Connect Authorization Code Flow、PKCE、state 與 nonce 登入。應用程式只保存 Google `sub` 對應、基本個人資料與 Slide Helper 自己的雜湊 session token，不保存 Google access token 或 refresh token。

## Google Cloud 設定

1. 在 Google Cloud Console 建立或選擇專案。
2. 設定 OAuth consent screen；測試階段將開發者帳號加入 Test users。
3. 建立 **Web application** 類型的 OAuth 2.0 Client。
4. 加入完全相符的 Authorized redirect URI：
   - 本機：`http://localhost:8080/api/auth/google/callback`
   - 正式環境：`https://<your-domain>/api/auth/google/callback`
5. 將 Client ID、Client secret 與相同的 redirect URI 寫入環境設定。

## 環境變數

```dotenv
GOOGLE_OAUTH_CLIENT_ID=<client-id>.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=<client-secret>
GOOGLE_OAUTH_REDIRECT_URL=http://localhost:8080/api/auth/google/callback

# 本機 HTTP 才能使用 false；正式 HTTPS 必須設為 true。
AUTH_COOKIE_SECURE=false
AUTH_FLOW_TTL_SECONDS=600
AUTH_SESSION_TTL_SECONDS=604800
```

三個 `GOOGLE_OAUTH_*` 值必須一起設定；全部留空時，其他 API 可以正常啟動，但 Google 登入端點會回覆 `503 auth_not_configured`。部分設定會讓 API 拒絕啟動，以免部署出現不完整的驗證流程。

Google 的 client secret 不得提交到 Git。正式環境應從 secret manager 或部署平台的加密變數注入。

## 驗證

```sh
docker compose up --detach --build --wait
./scripts/ci.sh
```

設定憑證後，瀏覽 `http://localhost:8080/api/auth/google/start`，完成 Google 同意流程後會回到 Web 首頁。可用下列端點確認或撤銷目前的應用程式 session：

- `GET /api/auth/me`
- `POST /api/auth/logout`

若正式服務位於 proxy 或 load balancer 後方，對外 redirect URI 仍必須使用使用者實際看到的 HTTPS origin，且與 Google Cloud Console 設定完全一致。
