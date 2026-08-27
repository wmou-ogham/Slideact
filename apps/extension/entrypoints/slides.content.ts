import { browser } from "wxt/browser";

import {
  GoogleSlidesDetector,
  isGoogleSlidesSlideshow,
  LOCATION_CHANGE_EVENT,
} from "../src/google-slides/detector";
import { navigatePresentation } from "../src/google-slides/navigation";
import { MESSAGE_TYPES, type ExtensionMessage, type NavigationCommand } from "../src/messages";

export default defineContentScript({
  matches: ["https://docs.google.com/presentation/*"],
  runAt: "document_idle",
  main() {
    let overlay: HTMLIFrameElement | null = null;
    let lastStatus: { overlayUrl?: string | null; token?: string | null } = {};
    let pairedToken: string | null = null;
    const detector = new GoogleSlidesDetector((position) => {
      const message: ExtensionMessage = {
        type: MESSAGE_TYPES.position,
        payload: position,
      };

      void browser.runtime.sendMessage(message).catch(() => {
        // The background context can be briefly unavailable during extension updates.
      });
    });
    const renderOverlay = (status: { overlayUrl?: string | null; token?: string | null } = lastStatus) => {
      lastStatus = status;
      if (status.token && status.token !== pairedToken) {
        pairedToken = status.token;
        detector.refresh();
      }
      const overlayUrl = status.overlayUrl && isGoogleSlidesSlideshow(location.href)
        ? status.overlayUrl
        : null;
      if (!overlayUrl) {
        overlay?.remove();
        overlay = null;
        return;
      }
      if (!overlay) {
        overlay = document.createElement("iframe");
        overlay.id = "slideact-live-overlay";
        overlay.title = "Slideact live audience overlay";
        overlay.setAttribute("allowtransparency", "true");
        Object.assign(overlay.style, {
          position: "fixed", inset: "0", width: "100vw", height: "100vh",
          border: "0", zIndex: "2147483647", pointerEvents: "none",
          background: "transparent", colorScheme: "none",
        });
        document.documentElement.append(overlay);
      }
      if (overlay.src !== overlayUrl) overlay.src = overlayUrl;
    };
    detector.start();
    void browser.runtime.sendMessage({ type: MESSAGE_TYPES.getStatus }).then(renderOverlay);
    window.addEventListener("hashchange", () => renderOverlay());
    window.addEventListener("popstate", () => renderOverlay());
    window.addEventListener(LOCATION_CHANGE_EVENT, () => renderOverlay());
    browser.runtime.onMessage.addListener((message: unknown) => {
      if (typeof message === "object" && message !== null && "type" in message && message.type === MESSAGE_TYPES.statusUpdated && "payload" in message) {
        renderOverlay(message.payload as { overlayUrl?: string | null; token?: string | null });
      }
    });
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
    const navigationTimer = window.setInterval(() => void pollNavigation(), 350);
    void pollNavigation();
    window.addEventListener("pagehide", () => {
      detector.stop();
      window.clearInterval(navigationTimer);
    }, { once: true });
  },
});
