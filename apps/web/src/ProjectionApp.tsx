import { useEffect, useMemo, useState } from "react";

import type { Translate } from "./i18n";
import {
  LIVE_POLL_INTERVAL_MS,
  aggregateFor,
  pinWordCloud,
  useLiveSession,
} from "./lib/liveSession";
import { projectionInteractionIsVisible, projectionInteractionShowsResults } from "./lib/interactions";
import { qrSvgTag } from "./lib/qr";
import { ProjectionThemePicker } from "./ProjectionThemePicker";
import { CueResultVisuals } from "./ResultVisuals";
import { ProjectionHeading } from "./TypewriterText";
import { ProjectionThemeContext, useProjectionTheme } from "./useProjectionTheme";

export function ProjectionApp({ t }: { t: Translate }) {
  const sessionId = location.pathname.split("/")[2] ?? "";
  const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
  const [error, setError] = useState("");
  const [theme, setTheme] = useProjectionTheme({ applyToBody: true, syncUrl: true });
  const { live, refresh } = useLiveSession({
    sessionId,
    token,
    topic: `session:${sessionId}:presenter`,
    pollMs: LIVE_POLL_INTERVAL_MS.projection,
    onInitialError: () => setError("projection_token_invalid"),
  });

  useProjectionChrome();

  if (error) return <main className="projection-error">{t("projection.invalid")}</main>;
  if (!live) return <main className="projection-root"><span className="waiting-orbit"><i /></span></main>;
  const cueRun = live.snapshot.current_cue_run;
  const interactions = cueRun?.interactions.filter(projectionInteractionIsVisible) ?? [];
  const multi = interactions.length > 1;
  const liveStatus = live.snapshot.presentation_view === "join_qr" || !cueRun
    ? null
    : cueRun.state === "ready"
      ? t("status.ready")
      : cueRun.state === "open"
        ? t("overlay.collecting")
        : cueRun.state === "revealed"
          ? t("audience.results")
          : t("audience.closed");
  const joinCode = live.snapshot.join_code ?? "";
  return (
    <ProjectionThemeContext.Provider value={theme}>
      <main className="projection-root projection-live" data-projection-theme={theme}>
        <header>
          <span>
            {theme === "terminal" ? "live" : "SLIDEACT · LIVE"}
            {liveStatus ? <span className="projection-live-status">{liveStatus}</span> : null}
          </span>
          <strong>{joinCode}</strong>
        </header>
        {live.snapshot.presentation_view === "join_qr" || !cueRun ? (
          <section className="projection-waiting">
            <p>{t("projection.join")}</p>
            <strong><ProjectionHeading theme={theme} text={joinCode} /></strong>
            <ProjectionJoinQr code={joinCode} label={t("live.joinQr")} />
            <small>{t("projection.waiting")}</small>
          </section>
        ) : cueRun.state === "ready" ? (
          <section className={interactions.length ? "projection-results projection-cue-ready" : "projection-results projection-background-only"}>
            {interactions.length > 0 && (multi
              ? interactions.map((interaction) => (
                <h1 key={interaction.id}><ProjectionHeading theme={theme} text={interaction.prompt} /></h1>
              ))
              : <h1><ProjectionHeading theme={theme} text={interactions[0]?.prompt ?? cueRun.cue_name} /></h1>)}
          </section>
        ) : (
          <section className={multi ? "projection-results projection-multi" : "projection-results"}>
            {interactions.length > 0 && <>
              {!multi && <h1><ProjectionHeading theme={theme} text={interactions[0]?.prompt ?? cueRun.cue_name} /></h1>}
              <CueResultVisuals
                t={t}
                interactions={interactions.map((interaction) => ({
                  id: interaction.id,
                  prompt: interaction.prompt,
                  interaction_type: interaction.interaction_type,
                  aggregate: projectionInteractionShowsResults(interaction, cueRun.state)
                    ? aggregateFor(live, interaction.id)
                    : null,
                }))}
                questions={live.questions}
                onToggleWordPin={(interactionId, text, pinned) => {
                  void pinWordCloud(sessionId, token, interactionId, text, pinned)
                    .then(() => refresh())
                    .catch(() => undefined);
                }}
              />
            </>}
          </section>
        )}
        <ProjectionThemePicker t={t} theme={theme} setTheme={setTheme} />
      </main>
    </ProjectionThemeContext.Provider>
  );
}

function useProjectionChrome() {
  useEffect(() => {
    let hideTimer = 0;
    const show = () => {
      document.body.classList.add("is-chrome-visible");
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => document.body.classList.remove("is-chrome-visible"), 2400);
    };
    show();
    window.addEventListener("mousemove", show);
    window.addEventListener("keydown", show);
    return () => {
      window.clearTimeout(hideTimer);
      window.removeEventListener("mousemove", show);
      window.removeEventListener("keydown", show);
      document.body.classList.remove("is-chrome-visible");
    };
  }, []);
}

export function ProjectionJoinQr({ code, label }: { code: string; label: string }) {
  const svg = useMemo(
    () => qrSvgTag(`${window.location.origin}/join/${encodeURIComponent(code)}`, 5),
    [code],
  );
  return <div className="projection-join-qr" aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} />;
}
