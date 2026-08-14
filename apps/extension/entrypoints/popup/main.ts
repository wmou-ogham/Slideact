import { browser } from "wxt/browser";

import { DEFAULT_SERVER_URL, MESSAGE_TYPES, type ExtensionStatus, type SyncMode } from "../../src/messages";
import "./style.css";

const copy = navigator.language.toLowerCase().startsWith("zh")
  ? {
      auto: "自動跟隨",
      manual: "手動模式",
      noSlide: "尚未偵測到 Google Slides",
      openSlides: "開啟 Google Slides 後，外掛會自動偵測目前頁面。",
      pair: "配對場次",
      pairCode: "配對碼",
      paired: "已連線至場次",
      server: "Slideact 伺服器",
      slide: "投影片",
      switchAuto: "切換為自動跟隨",
      switchManual: "切換為手動模式",
      title: "簡報同步狀態",
    }
  : {
      auto: "Auto-follow",
      manual: "Manual mode",
      noSlide: "No Google Slides deck detected",
      openSlides: "Open Google Slides and the extension will detect the current slide.",
      pair: "Pair session",
      pairCode: "Pairing code",
      paired: "Connected to session",
      server: "Slideact server",
      slide: "Slide",
      switchAuto: "Switch to auto-follow",
      switchManual: "Switch to manual mode",
      title: "Presentation sync status",
    };

const subtitle = requiredElement("subtitle");
const modeLabel = requiredElement("mode-label");
const positionLabel = requiredElement("position-label");
const modeButton = requiredElement<HTMLButtonElement>("mode-button");
const hint = requiredElement("hint");
const pairForm = requiredElement<HTMLFormElement>("pair-form");
const serverInput = requiredElement<HTMLInputElement>("server-url");
const codeInput = requiredElement<HTMLInputElement>("pair-code");
const pairButton = requiredElement<HTMLButtonElement>("pair-button");
requiredElement("server-label").textContent = copy.server;
requiredElement("pair-label").textContent = copy.pairCode;
pairButton.textContent = copy.pair;
let status: ExtensionStatus = { mode: "auto", position: null, updatedAt: null, serverUrl: DEFAULT_SERVER_URL, sessionId: null, token: null, overlayUrl: null, lastError: null };

subtitle.textContent = copy.title;
hint.textContent = copy.openSlides;

void browser.runtime
  .sendMessage({ type: MESSAGE_TYPES.getStatus })
  .then((nextStatus: ExtensionStatus) => {
    status = nextStatus;
    serverInput.value = status.serverUrl;
    render();
  });

pairForm.addEventListener("submit", (event) => {
  event.preventDefault();
  pairButton.disabled = true;
  void browser.runtime.sendMessage({ type: MESSAGE_TYPES.pair, payload: { code: codeInput.value, serverUrl: serverInput.value } }).then((nextStatus: ExtensionStatus) => {
    status = nextStatus;
    pairButton.disabled = false;
    render();
  });
});

modeButton.addEventListener("click", () => {
  const mode: SyncMode = status.mode === "auto" ? "manual" : "auto";
  void browser.runtime
    .sendMessage({ type: MESSAGE_TYPES.setMode, payload: { mode } })
    .then((nextStatus: ExtensionStatus) => {
      status = nextStatus;
      render();
    });
});

render();

function render(): void {
  modeLabel.textContent = status.mode === "auto" ? copy.auto : copy.manual;
  modeButton.textContent = status.mode === "auto" ? copy.switchManual : copy.switchAuto;
  positionLabel.textContent = status.position
    ? `${copy.slide} ${status.position.slideIndex === null ? status.position.slideId ?? "—" : status.position.slideIndex + 1}`
    : copy.noSlide;
  hint.textContent = status.lastError ? status.lastError : status.sessionId ? `${copy.paired} ${status.sessionId.slice(0, 8)}` : copy.openSlides;
  document.documentElement.lang = navigator.language.toLowerCase().startsWith("zh") ? "zh-TW" : "en";
}

function requiredElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing popup element: ${id}`);
  }
  return element as T;
}
