import { browser } from "wxt/browser";

import { MESSAGE_TYPES, type ExtensionStatus, type SyncMode } from "../../src/messages";
import "./style.css";

const copy = navigator.language.toLowerCase().startsWith("zh")
  ? {
      auto: "自動跟隨",
      manual: "手動模式",
      noSlide: "尚未偵測到 Google Slides",
      openSlides: "開啟 Google Slides 後，外掛會自動偵測目前頁面。",
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
let status: ExtensionStatus = { mode: "auto", position: null, updatedAt: null };

subtitle.textContent = copy.title;
hint.textContent = copy.openSlides;

void browser.runtime
  .sendMessage({ type: MESSAGE_TYPES.getStatus })
  .then((nextStatus: ExtensionStatus) => {
    status = nextStatus;
    render();
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
  document.documentElement.lang = navigator.language.toLowerCase().startsWith("zh") ? "zh-TW" : "en";
}

function requiredElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing popup element: ${id}`);
  }
  return element as T;
}
