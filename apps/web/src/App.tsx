import {
  resolveLocale,
  supportedLocales,
  translate,
  type MessageKey,
  type SupportedLocale,
} from "@slide-helper/i18n";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import { PresenterApp } from "./PresenterApp";

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
  return (
    <div className="app-frame">
      <Topbar locale={locale} setLocale={setLocale} t={t} />
      {path.startsWith("/presenter") ? (
        <PresenterApp t={t} locale={locale} />
      ) : (
        <Landing t={t} />
      )}
    </div>
  );
}

function Topbar({ locale, setLocale, t }: {
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  t: (key: MessageKey) => string;
}) {
  return (
    <nav className="topbar" aria-label={t("language.label")}>
      <a className="brand" href="/"><span className="brand-mark">S</span><span>{t("app.name")}</span></a>
      <div className="topbar-actions">
        <a href="/presenter">{t("nav.presenter")}</a>
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
    const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
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
              <input value={code} onChange={(event) => setCode(event.target.value)} maxLength={8} placeholder={t("landing.codePlaceholder")} aria-label={t("landing.codePlaceholder")} />
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
