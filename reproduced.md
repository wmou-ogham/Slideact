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

## 投影畫面風格

投影頁與結果頁可在三種風格間抽換：經典（現有深綠金框）、活潑（Mentimeter 風格）、終端機（黑底綠字打字機）。

- 講者工作室現場控制列有「投影畫面風格」下拉選單；開啟投影頁會帶上 `?theme=`。
- 投影頁將滑鼠移到畫面時，右下角會出現風格按鈕；已開啟的投影視窗會用 BroadcastChannel 同步。
- 偏好存在瀏覽器 `localStorage` 的 `slide-helper-projection-theme`。
- 終端機主題的打字效果會遵守 `prefers-reduced-motion`。

## 文字雲動態效果

前端是包進 nginx 映像，改 `apps/web` 後要重建 web 服務才看得到：

```sh
docker compose up --detach --build --wait web proxy
```

然後開一場有文字雲的活動，看投影／觀眾結果頁：新詞會交錯進場，詞會慢慢漂浮，同一詞被重複送出時會短暫放大。只有一個答案時，該詞大約占文字雲高度的三分之一；詞變多後字級會縮小，高頻詞仍明顯較大。觀眾同一題最多可送 3 則，送出後輸入框會清空以便再送。講者在投影頁或手機遙控點選詞可釘住，釘住的詞會加金框且不再隨新答案移動。投影頁標題會縮小，狀態字樣（即時結果／正在收集回覆）放在 LIVE 右側同一行，文字雲畫布約占畫面高度三分之二。

改 API 後要重建 Rust 映像：

```sh
docker compose up --detach --build --wait api worker web proxy
```
