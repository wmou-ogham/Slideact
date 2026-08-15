import {
  resolveLocale,
  supportedLocales,
  translate,
  type MessageKey,
  type SupportedLocale,
} from "@slide-helper/i18n";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import { PresenterApp } from "./PresenterApp";
import { DiagnosticsApp } from "./DiagnosticsApp";
import { AudienceApp, OverlayApp, ProjectionApp, RemoteApp } from "./LiveApps";
import { ResultsApp } from "./ResultsApp";

export function App() {
  const [locale, setLocale] = useState<SupportedLocale>(() =>
    resolveLocale(localStorage.getItem("slide-helper-locale") ?? navigator.language),
  );
  const t = useMemo(
    () => (key: MessageKey, params?: Readonly<Record<string, string | number>>) =>
      translate(locale, key, params),
    [locale],
  );

  useEffect(() => {
    document.documentElement.lang = locale;
    localStorage.setItem("slide-helper-locale", locale);
  }, [locale]);

  const path = window.location.pathname;
  if (path.startsWith("/overlay/")) return <OverlayApp t={t} />;
  if (path.startsWith("/projection/")) return <ProjectionApp t={t} />;
  if (path.startsWith("/results/")) return <ResultsApp t={t} />;
  if (path.startsWith("/remote/")) return <div className="app-frame"><RemoteApp t={t} /></div>;
  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">{t("a11y.skip")}</a>
      <Topbar locale={locale} setLocale={setLocale} t={t} />
      <div id="main-content" tabIndex={-1}>
        {path.startsWith("/diagnostics") ? (
          <DiagnosticsApp t={t} />
        ) : path.startsWith("/presenter") ? (
          <PresenterApp t={t} locale={locale} />
        ) : path.startsWith("/join") ? (
          <AudienceApp t={t} locale={locale} />
        ) : (
          <Landing t={t} />
        )}
      </div>
    </div>
  );
}

function Topbar({ locale, setLocale, t }: {
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  t: (key: MessageKey) => string;
}) {
  return (
    <nav className="topbar" aria-label={t("nav.label")}>
      <a className="brand" href="/"><span className="brand-mark">S</span><span>{t("app.name")}</span></a>
      <div className="topbar-actions">
        <a href="/presenter">{t("nav.presenter")}</a>
        <a href="/diagnostics">{t("nav.diagnostics")}</a>
        <label className="language-picker">
          <span>{t("language.label")}</span>
          <select value={locale} onChange={(event) => setLocale(event.target.value as SupportedLocale)}>
            {supportedLocales.map((option) => <option key={option} value={option}>{t(`locale.${option}`)}</option>)}
          </select>
        </label>
      </div>
    </nav>
  );
}

function Landing({ t }: { t: (key: MessageKey) => string }) {
  const [code, setCode] = useState("");
  function join(event: FormEvent) {
    event.preventDefault();
    const normalized = code.replace(/\D/g, "");
    if (normalized) window.location.assign(`/join/${normalized}`);
  }
  return (
    <main className="landing-shell">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">{t("landing.eyebrow")}</p>
          <h1>{t("landing.heading")}</h1>
          <p className="lede">{t("landing.description")}</p>
          <div className="hero-actions">
            <a className="primary-button" href="/presenter">{t("landing.presenterCta")}</a>
            <form className="join-form" onSubmit={join}>
              <input inputMode="text" autoCapitalize="characters" pattern="[A-Za-z0-9]*" value={code} onChange={(event) => setCode(event.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 6))} maxLength={6} placeholder="123456" aria-label={t("landing.codePlaceholder")} />
              <button>{t("landing.join")}</button>
            </form>
          </div>
        </div>
        <div className="signal-card" aria-hidden="true">
          <span className="signal-kicker">LIVE · 81</span>
          <div className="question">{t("landing.demoQuestion")}</div>
          <div className="signal-option signal-green"><span>68%</span></div>
          <div className="signal-option signal-yellow"><span>23%</span></div>
          <div className="signal-option signal-red"><span>9%</span></div>
          <div className="response-count">{t("landing.responses")}</div>
        </div>
      </section>
      <section className="feature-strip">
        <article><span>01</span><h2>{t("landing.featureFollow")}</h2><p>{t("landing.featureFollowCopy")}</p></article>
        <article><span>02</span><h2>{t("landing.featureSignals")}</h2><p>{t("landing.featureSignalsCopy")}</p></article>
        <article><span>03</span><h2>{t("landing.featureOverlay")}</h2><p>{t("landing.featureOverlayCopy")}</p></article>
      </section>
    </main>
  );
}
