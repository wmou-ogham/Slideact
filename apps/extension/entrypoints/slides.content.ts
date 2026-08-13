import { browser } from "wxt/browser";

import { GoogleSlidesDetector } from "../src/google-slides/detector";
import { navigatePresentation } from "../src/google-slides/navigation";
import { MESSAGE_TYPES, type ExtensionMessage, type NavigationCommand } from "../src/messages";

export default defineContentScript({
  matches: ["https://docs.google.com/presentation/*"],
  runAt: "document_idle",
  main() {
    let overlay: HTMLIFrameElement | null = null;
    const renderOverlay = (status: { overlayUrl?: string | null }) => {
      if (!status.overlayUrl) {
        overlay?.remove();
        overlay = null;
        return;
      }
      if (!overlay) {
        overlay = document.createElement("iframe");
        overlay.id = "slideact-live-overlay";
        overlay.title = "Slideact live audience overlay";
        Object.assign(overlay.style, {
          position: "fixed", inset: "0", width: "100vw", height: "100vh",
          border: "0", zIndex: "2147483647", pointerEvents: "none", background: "transparent",
        });
        document.documentElement.append(overlay);
      }
      if (overlay.src !== status.overlayUrl) overlay.src = status.overlayUrl;
    };
    void browser.runtime.sendMessage({ type: MESSAGE_TYPES.getStatus }).then(renderOverlay);
    browser.runtime.onMessage.addListener((message: unknown) => {
      if (typeof message === "object" && message !== null && "type" in message && message.type === MESSAGE_TYPES.statusUpdated && "payload" in message) {
        renderOverlay(message.payload as { overlayUrl?: string | null });
      }
    });
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
    let navigationPollBusy = false;
    const pollNavigation = async () => {
      if (navigationPollBusy) return;
      navigationPollBusy = true;
      try {
        const command = await browser.runtime.sendMessage({
          type: MESSAGE_TYPES.pollNavigation,
        }) as NavigationCommand | null;
        if (command) navigatePresentation(command.direction);
      } catch {
        // Polling resumes when the extension background context is available again.
      } finally {
        navigationPollBusy = false;
      }
    };
    const navigationTimer = window.setInterval(() => void pollNavigation(), 1000);
    void pollNavigation();
    window.addEventListener("pagehide", () => {
      detector.stop();
      window.clearInterval(navigationTimer);
    }, { once: true });
  },
});
