import { useEffect, useMemo, useState } from "react";

import { ApiError, apiJson } from "./api";
import { ProjectionThemePicker } from "./ProjectionThemePicker";
import { CueResultVisuals } from "./ResultVisuals";
import { ProjectionHeading } from "./TypewriterText";
import type { Question, SessionResults } from "./types";
import { uniqueCueRuns } from "./uniqueCueRuns";
import { ProjectionThemeContext, useProjectionTheme } from "./useProjectionTheme";

type Translate = (key: any, params?: Readonly<Record<string, string | number>>) => string;

export function ResultsApp({ t }: { t: Translate }) {
  const sessionId = location.pathname.split("/")[2] ?? "";
  const [results, setResults] = useState<SessionResults | null>(null);
  const [error, setError] = useState("");
  const [theme, setTheme] = useProjectionTheme({ applyToBody: true, syncUrl: true });
  const cueRuns = useMemo(() => uniqueCueRuns(results?.cue_runs ?? []), [results]);

  useEffect(() => {
    document.body.classList.add("is-chrome-visible");
    apiJson<SessionResults>(`/api/sessions/${sessionId}/results`)
      .then(setResults)
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError && cause.status === 401 ? "auth" : "invalid");
      });
    return () => document.body.classList.remove("is-chrome-visible");
  }, [sessionId]);

  if (error === "auth") {
    return (
      <main className="projection-error">
        <div>
          <h1>{t("history.signIn")}</h1>
          <a className="primary-button" href={`/api/auth/google/start?return_to=/results/${sessionId}`}>{t("auth.google")}</a>
        </div>
      </main>
    );
  }
  if (error) return <main className="projection-error">{t("history.invalid")}</main>;
  if (!results) return <main className="projection-root"><span className="waiting-orbit"><i /></span></main>;

  return (
    <ProjectionThemeContext.Provider value={theme}>
      <main className="projection-root session-results-root" data-projection-theme={theme}>
        <header>
          <span>{t("history.heading")}</span>
          <strong>{results.join_code ?? "—"}</strong>
        </header>
        <div className="session-results-summary">
          <div><small>{t("history.status")}</small><strong>{t(`statusName.${results.status}`)}</strong></div>
          <div><small>{t("history.audience")}</small><strong>{results.audience_count}</strong></div>
          <div><small>{t("history.started")}</small><strong>{formatSessionDate(results.started_at ?? results.created_at)}</strong></div>
        </div>
        {cueRuns.map((run) => {
          const questions = questionsFromRun(run);
          const multi = run.interactions.length > 1;
          return (
            <section className={multi ? "projection-results projection-multi" : "projection-results"} key={run.cue_id}>
              <p>{run.anchor_value ? t("cue.slide", { slide: run.anchor_value }) : t("cue.manual")}</p>
              {!multi && <h1><ProjectionHeading theme={theme} text={run.interactions[0]?.prompt ?? run.cue_name} /></h1>}
              {run.interactions.length
                ? (
                  <CueResultVisuals
                    t={t}
                    interactions={run.interactions.map((interaction) => ({
                      id: interaction.id,
                      prompt: interaction.prompt,
                      interaction_type: interaction.interaction_type,
                      aggregate: interaction.aggregate,
                    }))}
                    questions={questions}
                  />
                )
                : <p className="projection-empty">{t("history.empty")}</p>}
            </section>
          );
        })}
        {!cueRuns.length && <p className="projection-empty">{t("history.empty")}</p>}
        <ProjectionThemePicker t={t} theme={theme} setTheme={setTheme} />
      </main>
    </ProjectionThemeContext.Provider>
  );
}

function questionsFromRun(run: SessionResults["cue_runs"][number]): Question[] {
  return run.questions.map((question) => ({
    id: question.id,
    cue_run_id: run.id,
    body: question.body,
    status: question.status as Question["status"],
    votes: question.votes,
    voted_by_me: false,
    created_at: question.created_at,
  }));
}

function formatSessionDate(value: string) {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
