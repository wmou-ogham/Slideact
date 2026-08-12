# Slide Helper

跨 Google Slides、PowerPoint、Keynote 與 OBS 的即時觀眾互動層。

目前專案處於 Pre-MVP 規劃階段。規劃採 Rust Backend、Google OAuth、`zh-TW`／`en` i18n，以及 Docker Compose 全容器開發／部署環境。完整產品範圍、系統架構、資料模型、測試策略、風險與 10～12 週開發里程碑請見：

- [完整開發計畫](docs/DEVELOPMENT_PLAN.md)

第一個工程任務是 Google Slides Chrome Extension 技術 Spike；在確認實際 `slideId` 偵測可行性後，再進入完整產品骨架開發。
