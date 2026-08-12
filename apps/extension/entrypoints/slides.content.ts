import { browser } from "wxt/browser";

import { GoogleSlidesDetector } from "../src/google-slides/detector";
import { MESSAGE_TYPES, type ExtensionMessage } from "../src/messages";

export default defineContentScript({
  matches: ["https://docs.google.com/presentation/*"],
  runAt: "document_idle",
  main() {
    const detector = new GoogleSlidesDetector((position) => {
      const message: ExtensionMessage = {
        type: MESSAGE_TYPES.position,
        payload: position,
      };

      void browser.runtime.sendMessage(message).catch(() => {
        // The background context can be briefly unavailable during extension updates.
      });
    });

    detector.start();
    window.addEventListener("pagehide", () => detector.stop(), { once: true });
  },
});
