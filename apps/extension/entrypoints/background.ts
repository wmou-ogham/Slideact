import { browser } from "wxt/browser";

import {
  isExtensionMessage,
  MESSAGE_TYPES,
  type ExtensionStatus,
  type NavigationCommand,
  type SyncMode,
} from "../src/messages";

const STATUS_KEY = "slideHelper.extensionStatus";
const EMPTY_STATUS: ExtensionStatus = {
  mode: "auto",
  position: null,
  updatedAt: null,
  serverUrl: "http://10.121.180.185:18666",
  sessionId: null,
  token: null,
  overlayUrl: null,
  lastError: null,
};

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    void readStatus().then((status) => writeStatus(status));
    void browser.alarms.create("slideact-heartbeat", { periodInMinutes: 0.5 });
  });

  browser.runtime.onStartup.addListener(() => {
    void sendHeartbeat();
    void browser.alarms.create("slideact-heartbeat", { periodInMinutes: 0.5 });
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "slideact-heartbeat") void sendHeartbeat();
  });
  void browser.alarms.create("slideact-heartbeat", { periodInMinutes: 0.5 });

  browser.runtime.onMessage.addListener(async (message: unknown) => {
    if (!isExtensionMessage(message)) {
      return undefined;
    }

    if (message.type === MESSAGE_TYPES.getStatus) {
      return readStatus();
    }

    if (message.type === MESSAGE_TYPES.position) {
      const current = await readStatus();
      const next: ExtensionStatus = {
        ...current,
        position: message.payload,
        updatedAt: Date.now(),
      };
      await writeStatus(next);
      if (next.mode === "auto" && next.token) {
        return reportPosition(next, message.payload);
      }
      return next;
    }

    if (message.type === MESSAGE_TYPES.pair) {
      return pairExtension(message.payload.code, message.payload.serverUrl);
    }

    if (message.type === MESSAGE_TYPES.pollNavigation) {
      return pollNavigation();
    }

    const nextMode: SyncMode = message.payload.mode;
    const current = await readStatus();
    const next: ExtensionStatus = { ...current, mode: nextMode, updatedAt: Date.now() };
    await writeStatus(next);
    return next;
  });
});

async function readStatus(): Promise<ExtensionStatus> {
  const stored = await browser.storage.local.get(STATUS_KEY);
  return { ...EMPTY_STATUS, ...((stored[STATUS_KEY] as ExtensionStatus | undefined) ?? {}) };
}

async function writeStatus(status: ExtensionStatus): Promise<void> {
  await browser.storage.local.set({ [STATUS_KEY]: status });
  const tabs = await browser.tabs.query({ url: "https://docs.google.com/presentation/*" });
  await Promise.all(tabs.map((tab) => tab.id === undefined ? Promise.resolve() : browser.tabs.sendMessage(tab.id, { type: MESSAGE_TYPES.statusUpdated, payload: status }).catch(() => undefined)));
}

async function pairExtension(code: string, serverUrl: string): Promise<ExtensionStatus> {
  const current = await readStatus();
  const normalizedServer = serverUrl.trim().replace(/\/$/, "");
  let deviceId = (await browser.storage.local.get("slideHelper.deviceId"))["slideHelper.deviceId"] as string | undefined;
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    await browser.storage.local.set({ "slideHelper.deviceId": deviceId });
  }
  try {
    const response = await fetch(`${normalizedServer}/api/extension/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code.trim().toUpperCase(), device_id: deviceId }),
    });
    if (!response.ok) throw new Error(`pairing_${response.status}`);
    const paired = await response.json() as { session_id: string; token: string; overlay_token: string };
    const next: ExtensionStatus = {
      ...current,
      mode: "auto",
      serverUrl: normalizedServer,
      sessionId: paired.session_id,
      token: paired.token,
      overlayUrl: `${normalizedServer}/overlay/${paired.session_id}#token=${encodeURIComponent(paired.overlay_token)}`,
      updatedAt: Date.now(),
      lastError: null,
    };
    await writeStatus(next);
    return next;
  } catch (error) {
    const next = { ...current, serverUrl: normalizedServer, lastError: error instanceof Error ? error.message : "pairing_failed", updatedAt: Date.now() };
    await writeStatus(next);
    return next;
  }
}

async function reportPosition(status: ExtensionStatus, position: NonNullable<ExtensionStatus["position"]>): Promise<ExtensionStatus> {
  try {
    const response = await fetch(`${status.serverUrl}/api/extension/position`, {
      method: "POST",
      headers: { authorization: `Bearer ${status.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        device_id: await deviceId(),
        deck_id: position.deckId,
        slide_id: position.slideId,
        slide_index: position.slideIndex,
        detected_at: position.detectedAt,
      }),
    });
    if (!response.ok) throw new Error(`position_${response.status}`);
    const next = { ...status, lastError: null, updatedAt: Date.now() };
    await writeStatus(next);
    return next;
  } catch (error) {
    const next = { ...status, lastError: error instanceof Error ? error.message : "position_failed", updatedAt: Date.now() };
    await writeStatus(next);
    return next;
  }
}

async function sendHeartbeat(): Promise<void> {
  const status = await readStatus();
  if (!status.token || !status.sessionId) return;
  try {
    const response = await fetch(`${status.serverUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { authorization: `Bearer ${status.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        device_id: await deviceId(),
        deck_id: status.position?.deckId ?? null,
        slide_id: status.position?.slideId ?? null,
        slide_index: status.position?.slideIndex ?? null,
        last_error: status.lastError,
      }),
    });
    if (!response.ok) throw new Error(`heartbeat_${response.status}`);
  } catch (error) {
    await writeStatus({ ...status, lastError: error instanceof Error ? error.message : "heartbeat_failed", updatedAt: Date.now() });
  }
}

async function pollNavigation(): Promise<NavigationCommand | null> {
  const status = await readStatus();
  // Explicit phone navigation remains available while automatic cue following is
  // paused or the presenter is using manual cue control.
  if (!status.token || !status.sessionId) return null;
  try {
    const response = await fetch(`${status.serverUrl}/api/extension/navigation`, {
      headers: { authorization: `Bearer ${status.token}` },
    });
    if (!response.ok) throw new Error(`navigation_${response.status}`);
    const result = await response.json() as { command: NavigationCommand | null };
    return result.command;
  } catch (error) {
    await writeStatus({
      ...status,
      lastError: error instanceof Error ? error.message : "navigation_failed",
      updatedAt: Date.now(),
    });
    return null;
  }
}

async function deviceId(): Promise<string> {
  let value = (await browser.storage.local.get("slideHelper.deviceId"))["slideHelper.deviceId"] as string | undefined;
  if (!value) {
    value = crypto.randomUUID();
    await browser.storage.local.set({ "slideHelper.deviceId": value });
  }
  return value;
}
