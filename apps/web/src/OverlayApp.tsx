import { useEffect, useState } from "react";

import type { Translate } from "./i18n";
import {
  LIVE_POLL_INTERVAL_MS,
  aggregateFor,
  useLiveSession,
} from "./lib/liveSession";
import { projectionInteractionIsVisible, projectionInteractionShowsResults } from "./lib/interactions";
import { ProjectionJoinQr } from "./ProjectionApp";
import { AggregateBars } from "./ResultVisuals";

export function OverlayApp({ t }: { t: Translate }) {
  const sessionId = location.pathname.split("/")[2] ?? "";
  const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
  const [error, setError] = useState("");
  const { live } = useLiveSession({
    sessionId,
    token,
    topic: `session:${sessionId}:overlay`,
    pollMs: LIVE_POLL_INTERVAL_MS.overlay,
    onInitialError: () => setError("overlay_token_invalid"),
  });

  useEffect(() => {
    document.documentElement.classList.add("overlay-html");
    document.body.classList.add("overlay-body");
    return () => {
      document.documentElement.classList.remove("overlay-html");
      document.body.classList.remove("overlay-body");
    };
  }, []);

  if (error) return <main className="overlay-error"><span>{t("overlay.invalid")}</span></main>;
  if (!live) return <main className="overlay-root"><span className="waiting-orbit"><i /></span></main>;
  const cueRun = live.snapshot.current_cue_run;
  if (live.snapshot.presentation_view === "join_qr") return <main className="overlay-root overlay-minimal"><div className="overlay-code"><small>{t("projection.join")}</small><ProjectionJoinQr code={live.snapshot.join_code ?? ""} label={t("live.joinQr")} /><strong>{live.snapshot.join_code}</strong></div></main>;
  if (!cueRun) return <main className="overlay-root overlay-minimal"><div className="overlay-code"><small>{t("projection.waiting")}</small><strong>{live.snapshot.join_code}</strong></div></main>;
  const interactions = cueRun.interactions.filter(projectionInteractionIsVisible);
  if (cueRun.state === "ready") return <main className="overlay-root"><section className="overlay-card"><div className="overlay-meta"><span>{t("status.ready")}</span><strong>{live.snapshot.join_code}</strong></div>{interactions.length > 0 && <h1>{interactions[0]?.prompt ?? cueRun.cue_name}</h1>}</section></main>;
  const pinnedQuestion = live.questions.find((question) => question.status === "pinned")
    ?? live.questions.find((question) => question.status === "highlighted");
  const multi = interactions.length > 1;
  return (
    <main className="overlay-root">
      <section className="overlay-card">
        <div className="overlay-meta"><span>LIVE · {live.audience_count}</span><strong>{live.snapshot.join_code}</strong></div>
        {interactions.map((interaction) => {
          const aggregate = projectionInteractionShowsResults(interaction, cueRun.state)
            ? aggregateFor(live, interaction.id)
            : null;
          return (
            <article className="overlay-interaction" key={interaction.id}>
              <h1>{interaction.prompt}</h1>
              {interaction.interaction_type === "qa"
                ? pinnedQuestion && <div className={`overlay-question ${pinnedQuestion.status === "highlighted" ? "question-highlighted" : ""}`}>{pinnedQuestion.status === "pinned" && <span>{t("qa.pinned")}</span>}<p>{pinnedQuestion.body}</p><small>{t("qa.votes", { count: pinnedQuestion.votes })}</small></div>
                : aggregate
                  ? <AggregateBars t={t} aggregate={aggregate} />
                  : !multi && <p>{cueRun.state === "open" ? t("overlay.collecting") : t("audience.closed")}</p>}
            </article>
          );
        })}
      </section>
    </main>
  );
}
