# Google OAuth 驗收（slideact.mou.tw）

## 設定

1. 複製 `.env.example` 為 `.env`。
2. 填入三個 `GOOGLE_OAUTH_*`（見 `.env`，勿提交 Git）。
3. `GOOGLE_OAUTH_REDIRECT_URL` 必須與 Google Cloud Console 的 Authorized redirect URI 完全一致（正式：`https://slideact.mou.tw/api/auth/google/callback`）。
4. Traefik 終止 TLS 時使用 `AUTH_COOKIE_SECURE=true`。

## 啟動

```sh
docker compose up --detach --build --wait
```

## 本機檢查

```sh
curl -fsS http://127.0.0.1:18666/api/version
# 預期：google_oauth_configured: true

curl -sS -D - -o /dev/null "http://127.0.0.1:18666/api/auth/google/start?return_to=/presenter" | head
# 預期：HTTP 302，Location 指向 accounts.google.com，redirect_uri=slideact.mou.tw
```

## 完整登入

瀏覽器開啟（需 `slideact.mou.tw` 指到此 Compose 主機）：

```
http://slideact.mou.tw/api/auth/google/start?return_to=/presenter
```

完成 Google 同意後應回到 `/presenter` 並建立 session。

```sh
curl -fsS http://slideact.mou.tw/api/auth/me -b cookies.txt -c cookies.txt
```
