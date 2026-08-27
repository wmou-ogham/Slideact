import { resolveLocale, translate, type MessageKey } from "@slide-helper/i18n";
import { browser } from "wxt/browser";

import { DEFAULT_SERVER_URL, MESSAGE_TYPES, type ExtensionStatus, type SyncMode } from "../../src/messages";
import "./style.css";

const locale = resolveLocale(navigator.language);
const t = (key: MessageKey) => translate(locale, key);

const subtitle = requiredElement("subtitle");
const modeLabel = requiredElement("mode-label");
const positionLabel = requiredElement("position-label");
const modeButton = requiredElement<HTMLButtonElement>("mode-button");
const hint = requiredElement("hint");
const pairForm = requiredElement<HTMLFormElement>("pair-form");
const serverInput = requiredElement<HTMLInputElement>("server-url");
const codeInput = requiredElement<HTMLInputElement>("pair-code");
const pairButton = requiredElement<HTMLButtonElement>("pair-button");
requiredElement("server-label").textContent = t("extension.server");
requiredElement("pair-label").textContent = t("extension.pairCode");
pairButton.textContent = t("extension.pair");
let status: ExtensionStatus = { mode: "auto", position: null, updatedAt: null, serverUrl: DEFAULT_SERVER_URL, sessionId: null, token: null, overlayUrl: null, lastError: null };

subtitle.textContent = t("extension.title");
hint.textContent = t("extension.openSlides");

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
  modeLabel.textContent = status.mode === "auto" ? t("extension.auto") : t("extension.manual");
  modeButton.textContent = status.mode === "auto" ? t("extension.switchManual") : t("extension.switchAuto");
  positionLabel.textContent = status.position
    ? `${t("extension.slide")} ${status.position.slideIndex === null ? status.position.slideId ?? "—" : status.position.slideIndex + 1}`
    : t("extension.noSlide");
  hint.textContent = status.lastError
    ? describeError(status.lastError)
    : status.sessionId
      ? `${t("extension.paired")} ${status.sessionId.slice(0, 8)}`
      : t("extension.openSlides");
  document.documentElement.lang = locale;
}

function describeError(error: string) {
  if (error === "pairing_404" || error === "pairing_400") return t("extension.pairingExpired");
  if (error.startsWith("pairing_")) return t("extension.pairingFailed");
  return error;
}

function requiredElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing popup element: ${id}`);
  }
  return element as T;
}
