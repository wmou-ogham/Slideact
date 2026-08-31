import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { installFocusModalityTracking } from "./focusModality";
import "./styles.css";

installFocusModalityTracking();

function reportClientError(message: string) {
  void fetch("/api/diagnostics/client-errors", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      surface: "web",
      route: location.pathname.slice(0, 300) || "/",
      message: message.slice(0, 500) || "unknown_client_error",
      context: {},
    }),
  }).catch(() => undefined);
}

window.addEventListener("error", (event) => reportClientError(event.error instanceof Error ? `${event.error.name}: ${event.error.message}` : event.message));
window.addEventListener("unhandledrejection", (event) => reportClientError(event.reason instanceof Error ? `${event.reason.name}: ${event.reason.message}` : String(event.reason)));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
