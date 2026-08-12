const en = {
  "app.name": "Slide Helper",
  "app.tagline": "Live audience interaction that follows your presentation.",
  "language.label": "Language",
  "locale.en": "English",
  "locale.zh-TW": "繁體中文",
  "status.api": "Rust API",
  "status.checking": "Checking",
  "status.ready": "Ready",
  "status.unavailable": "Unavailable",
  "status.websocket": "Realtime channel",
  "status.websocketConnected": "Connected",
  "status.websocketDisconnected": "Disconnected",
  "m0.eyebrow": "M0 development environment",
  "m0.heading": "The interaction layer is coming online.",
  "m0.description":
    "The containerized Rust backend, bilingual web surface, and realtime protocol are now connected.",
  "m0.autoFollow": "Google Slides auto-follow",
  "m0.manualCue": "Manual cue control",
  "m0.audience": "Audience web experience",
  "m0.planned": "Planned",
  "m0.inProgress": "In progress",
  "m0.foundationReady": "Foundation ready",
} as const;

export type MessageKey = keyof typeof en;
type Catalog = Record<MessageKey, string>;

const zhTW: Catalog = {
  "app.name": "Slide Helper",
  "app.tagline": "跟著簡報前進的即時觀眾互動層。",
  "language.label": "語言",
  "locale.en": "English",
  "locale.zh-TW": "繁體中文",
  "status.api": "Rust API",
  "status.checking": "檢查中",
  "status.ready": "已就緒",
  "status.unavailable": "無法連線",
  "status.websocket": "即時頻道",
  "status.websocketConnected": "已連線",
  "status.websocketDisconnected": "未連線",
  "m0.eyebrow": "M0 開發環境",
  "m0.heading": "互動層正在上線。",
  "m0.description": "容器化 Rust 後端、雙語網頁與即時協議已經完成串接。",
  "m0.autoFollow": "Google Slides 自動跟隨",
  "m0.manualCue": "手動 Cue 控制",
  "m0.audience": "觀眾互動網頁",
  "m0.planned": "已規劃",
  "m0.inProgress": "進行中",
  "m0.foundationReady": "基礎已就緒",
};

export const catalogs: Readonly<Record<"zh-TW" | "en", Catalog>> = {
  "zh-TW": zhTW,
  en,
};
