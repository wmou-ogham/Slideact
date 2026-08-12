import {
  resolveLocale,
  supportedLocales,
  translate,
  type SupportedLocale,
} from "@slide-helper/i18n";
import { useEffect, useMemo, useState } from "react";

type ApiState = "checking" | "ready" | "unavailable";
type SocketState = "connected" | "disconnected";

export function App() {
  const [locale, setLocale] = useState<SupportedLocale>(() =>
    resolveLocale(localStorage.getItem("slide-helper-locale") ?? navigator.language),
  );
  const [apiState, setApiState] = useState<ApiState>("checking");
  const [socketState, setSocketState] = useState<SocketState>("disconnected");
  const t = useMemo(
    () => (key: Parameters<typeof translate>[1]) => translate(locale, key),
    [locale],
  );

  useEffect(() => {
    document.documentElement.lang = locale;
    localStorage.setItem("slide-helper-locale", locale);
  }, [locale]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/health/ready", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("API is not ready");
        setApiState("ready");
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setApiState("unavailable");
        }
      });

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
    socket.addEventListener("open", () => setSocketState("connected"));
    socket.addEventListener("close", () => setSocketState("disconnected"));
    socket.addEventListener("error", () => setSocketState("disconnected"));

    return () => {
      controller.abort();
      socket.close();
    };
  }, []);

  return (
    <main className="shell">
      <nav className="topbar" aria-label={t("language.label")}>
        <a className="brand" href="/">
          <span className="brand-mark">S</span>
          <span>{t("app.name")}</span>
        </a>
        <label className="language-picker">
          <span>{t("language.label")}</span>
          <select
            value={locale}
            onChange={(event) => setLocale(event.target.value as SupportedLocale)}
          >
            {supportedLocales.map((option) => (
              <option key={option} value={option}>
                {t(`locale.${option}`)}
              </option>
            ))}
          </select>
        </label>
      </nav>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">{t("m0.eyebrow")}</p>
          <h1>{t("m0.heading")}</h1>
          <p className="lede">{t("m0.description")}</p>

          <div className="status-row" aria-live="polite">
            <StatusPill
              label={t("status.api")}
              value={t(`status.${apiState}`)}
              active={apiState === "ready"}
            />
            <StatusPill
              label={t("status.websocket")}
              value={t(
                socketState === "connected"
                  ? "status.websocketConnected"
                  : "status.websocketDisconnected",
              )}
              active={socketState === "connected"}
            />
          </div>
        </div>

        <div className="signal-card" aria-hidden="true">
          <div className="question">Does everyone follow?</div>
          <div className="signal-option signal-green"><span>68%</span></div>
          <div className="signal-option signal-yellow"><span>23%</span></div>
          <div className="signal-option signal-red"><span>9%</span></div>
          <div className="response-count">81 responses</div>
        </div>
      </section>

      <section className="roadmap" aria-label="M0 roadmap">
        <RoadmapItem title={t("m0.autoFollow")} status={t("m0.inProgress")} index="01" />
        <RoadmapItem title={t("m0.manualCue")} status={t("m0.planned")} index="02" />
        <RoadmapItem title={t("m0.audience")} status={t("m0.foundationReady")} index="03" />
      </section>

      <footer>{t("app.tagline")}</footer>
    </main>
  );
}

function StatusPill({
  label,
  value,
  active,
}: {
  label: string;
  value: string;
  active: boolean;
}) {
  return (
    <span className="status-pill">
      <span className={active ? "status-dot active" : "status-dot"} />
      <strong>{label}</strong>
      <span>{value}</span>
    </span>
  );
}

function RoadmapItem({
  title,
  status,
  index,
}: {
  title: string;
  status: string;
  index: string;
}) {
  return (
    <article className="roadmap-item">
      <span className="roadmap-index">{index}</span>
      <h2>{title}</h2>
      <p>{status}</p>
    </article>
  );
}
