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
import { AudienceApp } from "./AudienceApp";
import { OverlayApp } from "./OverlayApp";
import { ProjectionApp } from "./ProjectionApp";
import { ProjectionThemePicker } from "./ProjectionThemePicker";
import { RemoteApp } from "./RemoteApp";
import { ResultsApp } from "./ResultsApp";
import { DEFAULT_PROJECTION_THEME, type ProjectionTheme } from "./projectionTheme";
import { useProjectionTheme } from "./useProjectionTheme";

type Translate = (
  key: MessageKey,
  params?: Readonly<Record<string, string | number>>,
) => string;

export function App() {
  const path = window.location.pathname;
  const isAudience = path.startsWith("/join");
  const [locale, setLocale] = useState<SupportedLocale>(() =>
    resolveLocale(isAudience
      ? preferredBrowserLocale()
      : (localStorage.getItem("slide-helper-locale") ?? preferredBrowserLocale())),
  );
  const t = useMemo(
    () => (key: MessageKey, params?: Readonly<Record<string, string | number>>) =>
      translate(locale, key, params),
    [locale],
  );

  useEffect(() => {
    document.documentElement.lang = locale;
    if (!isAudience) localStorage.setItem("slide-helper-locale", locale);
  }, [isAudience, locale]);

  if (path.startsWith("/overlay/")) return <OverlayApp t={t} />;
  if (path.startsWith("/projection/")) return <ProjectionApp t={t} />;
  if (path.startsWith("/results/")) return <ResultsApp t={t} />;

  return <ThemedApp path={path} locale={locale} setLocale={setLocale} t={t} />;
}

function ThemedApp({ path, locale, setLocale, t }: {
  path: string;
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  t: Translate;
}) {
  const [theme, setTheme] = useProjectionTheme();
  const [audienceTheme, setAudienceTheme] = useState<ProjectionTheme>(DEFAULT_PROJECTION_THEME);
  const isPresenter = path.startsWith("/presenter");
  const isRemote = path.startsWith("/remote/");
  const isAudience = path.startsWith("/join");
  const interfaceTheme = isAudience ? audienceTheme : theme;

  useEffect(() => {
    const root = document.documentElement;
    const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const originalThemeColor = themeColor?.content;
    const colors: Record<ProjectionTheme, string> = {
      classic: "#f8f5ed",
      lively: "#f7f0d2",
      terminal: "#071116",
    };

    root.dataset.interfaceTheme = interfaceTheme;
    root.style.colorScheme = interfaceTheme === "terminal" ? "dark" : "light";
    if (themeColor) themeColor.content = colors[interfaceTheme];

    return () => {
      delete root.dataset.interfaceTheme;
      root.style.removeProperty("color-scheme");
      if (themeColor && originalThemeColor) themeColor.content = originalThemeColor;
    };
  }, [interfaceTheme]);

  return (
    <div
      className={isPresenter
        ? "app-frame presenter-app-frame"
        : isRemote
          ? "app-frame remote-app-frame"
          : isAudience
            ? "app-frame audience-app-frame"
            : "app-frame"}
      data-interface-theme={interfaceTheme}
    >
      <a className="skip-link" href="#main-content">{t("a11y.skip")}</a>
      {!isPresenter && !isRemote && !isAudience && (
        <Topbar
          locale={locale}
          setLocale={setLocale}
          setTheme={setTheme}
          t={t}
          theme={theme}
        />
      )}
      <div id="main-content" tabIndex={-1}>
        {isAudience && (
          <a className="audience-brand" href="/" aria-label={t("app.name")}>
            <span className="brand-mark" aria-hidden="true">S</span>
          </a>
        )}
        {isRemote ? (
          <RemoteApp t={t} />
        ) : path.startsWith("/diagnostics") ? (
          <DiagnosticsApp t={t} />
        ) : path.startsWith("/presenter") ? (
          <PresenterApp t={t} locale={locale} theme={theme} setTheme={setTheme} />
        ) : path.startsWith("/join") ? (
          <AudienceApp t={t} locale={locale} onThemeChange={setAudienceTheme} />
        ) : (
          <Landing t={t} />
        )}
      </div>
    </div>
  );
}

function preferredBrowserLocale() {
  return navigator.languages?.[0] ?? navigator.language;
}

function Topbar({ locale, setLocale, setTheme, t, theme }: {
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  setTheme: (theme: ProjectionTheme) => void;
  t: Translate;
  theme: ProjectionTheme;
}) {
  return (
    <nav className="topbar" aria-label={t("nav.label")}>
      <a className="brand" href="/"><span className="brand-mark">S</span><span>{t("app.name")}</span></a>
      <div className="topbar-actions">
        <a href="/presenter">{t("nav.presenter")}</a>
        <a href="/diagnostics">{t("nav.diagnostics")}</a>
        <label className="interface-theme-picker">
          <span>{t("theme.label")}</span>
          <ProjectionThemePicker t={t} theme={theme} setTheme={setTheme} variant="select" />
        </label>
        <label className="language-picker">
          <select
            aria-label={t("language.label")}
            value={locale}
            onChange={(event) => setLocale(event.target.value as SupportedLocale)}
          >
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
              <input name="join-code" inputMode="text" autoComplete="off" autoCapitalize="characters" spellCheck={false} pattern="[A-Za-z0-9]*" value={code} onChange={(event) => setCode(event.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 6))} maxLength={6} placeholder="123456" aria-label={t("landing.codePlaceholder")} />
              <button type="submit">{t("landing.join")}</button>
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
