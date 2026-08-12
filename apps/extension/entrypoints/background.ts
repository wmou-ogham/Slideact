import { browser } from "wxt/browser";

import {
  isExtensionMessage,
  MESSAGE_TYPES,
  type ExtensionStatus,
  type SyncMode,
} from "../src/messages";

const STATUS_KEY = "slideHelper.extensionStatus";
const EMPTY_STATUS: ExtensionStatus = {
  mode: "auto",
  position: null,
  updatedAt: null,
};

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    void readStatus().then((status) => writeStatus(status));
  });

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
      return next;
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
  return (stored[STATUS_KEY] as ExtensionStatus | undefined) ?? EMPTY_STATUS;
}

async function writeStatus(status: ExtensionStatus): Promise<void> {
  await browser.storage.local.set({ [STATUS_KEY]: status });
}
