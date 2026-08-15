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

## 開機自動啟動

Compose 已在跑時，可讓重開機後自動拉起（單位檔會把路徑換成目前工作目錄）：

```sh
# 使用者單位（不必 sudo；若要未登入也啟動：sudo loginctl enable-linger "$USER"）
./scripts/install-autostart.sh --user

# 系統單位（需要 sudo）
sudo ./scripts/install-autostart.sh --system
```

## 文字雲動態效果

前端是包進 nginx 映像，改 `apps/web` 後要重建 web 服務才看得到：

```sh
docker compose up --detach --build --wait web proxy
```

然後開一場有文字雲的活動，看投影／觀眾結果頁：新詞會交錯進場，詞會慢慢漂浮，同一詞被重複送出時會短暫放大。
