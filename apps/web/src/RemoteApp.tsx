import { useCallback, useEffect, useState } from "react";

import { ApiError, apiJson } from "./api";
import type { Translate } from "./i18n";
import { cueNavigationLabel } from "./lib/interactions";
import {
  LIVE_POLL_INTERVAL_MS,
  aggregateFor,
  pinWordCloud,
  sendCommand,
  useLiveSession,
} from "./lib/liveSession";
import { AggregateBars } from "./ResultVisuals";
import type { Cue, LiveView, Question, SessionCommand } from "./types";

function RemoteAggregate({ t, aggregate, onToggleWordPin }: {
  t: Translate;
  aggregate: LiveView["aggregates"][number]["aggregate"];
  onToggleWordPin?: (text: string, pinned: boolean) => void;
}) {
  if (aggregate.interaction_type === "understanding") {
    return (
      <div className="remote-aggregate">
        <div className="history-signals">
          <span className="signal-green">{t("audience.green")} <b>{aggregate.green ?? 0}</b></span>
          <span className="signal-yellow">{t("audience.yellow")} <b>{aggregate.yellow ?? 0}</b></span>
          <span className="signal-red">{t("audience.red")} <b>{aggregate.red ?? 0}</b></span>
        </div>
        <AggregateBars t={t} aggregate={aggregate} />
      </div>
    );
  }
  if (aggregate.interaction_type === "word_cloud") {
    const entries = aggregate.entries ?? [];
    const pinned = new Set(aggregate.pinned ?? []);
    if (!entries.length) return <p className="remote-empty">{t("history.noResponses")}</p>;
    return (
      <div className="history-words remote-words">
        {entries.slice(0, 40).map((entry) => {
          const isPinned = pinned.has(entry.text);
          if (!onToggleWordPin) {
            return <span className={isPinned ? "is-pinned" : undefined} key={entry.text}>{entry.text} <b>×{entry.count}</b></span>;
          }
          return (
            <button
              className={isPinned ? "is-pinned" : undefined}
              key={entry.text}
              type="button"
              aria-pressed={isPinned}
              onClick={() => onToggleWordPin(entry.text, !isPinned)}
            >
              {entry.text} <b>×{entry.count}</b>
            </button>
          );
        })}
      </div>
    );
  }
  if (!aggregate.options?.length) return <p className="remote-empty">{t("history.noResponses")}</p>;
  return <AggregateBars t={t} aggregate={aggregate} />;
}

type RemoteError =
  | { kind: "auth" }
  | { kind: "token" }
  | { kind: "load" }
  | { kind: "action"; code: string };

function actionError(cause: unknown): RemoteError {
  return { kind: "action", code: cause instanceof ApiError ? cause.code : "network_error" };
}

function actionMessage(t: Translate, code: string) {
  if (code === "network_error") return t("error.network");
  if (code === "state_version_conflict") return t("remote.errorConflict");
  return t("error.generic", { code });
}

export function RemoteApp({ t }: { t: Translate }) {
  const sessionId = location.pathname.split("/")[2] ?? "";
  const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
  const [cues, setCues] = useState<Cue[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RemoteError | null>(null);

  const classifyLoadError = useCallback((cause: unknown) => {
    setError(cause instanceof ApiError && (cause.status === 401 || cause.status === 403)
      ? { kind: token ? "token" : "auth" }
      : { kind: "load" });
  }, [token]);

  const { live, refresh: refreshLive } = useLiveSession({
    sessionId,
    token,
    topic: `session:${sessionId}:presenter`,
    pollMs: LIVE_POLL_INTERVAL_MS.remote,
    onInitialError: classifyLoadError,
  });

  const refreshCues = useCallback(async () => {
    const headers = token ? { authorization: `Bearer ${token}` } : undefined;
    setCues(await apiJson<Cue[]>(`/api/sessions/${sessionId}/controller-cues`, { headers }));
  }, [sessionId, token]);

  useEffect(() => {
    refreshCues().catch(classifyLoadError);
    const timer = window.setInterval(() => refreshCues().catch(() => undefined), LIVE_POLL_INTERVAL_MS.remote);
    return () => window.clearInterval(timer);
  }, [classifyLoadError, refreshCues]);

  async function send(command: SessionCommand) {
    if (!live) return;
    setBusy(true);
    try {
      await sendCommand(sessionId, live.snapshot.state_version, command, token || undefined);
      setError(null);
    } catch (cause) {
      setError(actionError(cause));
    } finally {
      await refreshLive().catch(() => undefined);
      setBusy(false);
    }
  }

  async function navigate(direction: "previous" | "next") {
    if (!live) return;
    const snapshot = live.snapshot;
    setBusy(true);
    try {
      const orderedCues = [...cues].sort((left, right) => left.position - right.position);
      const currentIndex = snapshot.current_cue_run
        ? orderedCues.findIndex((cue) => cue.id === snapshot.current_cue_run?.cue_id)
        : -1;
      const showingQr = snapshot.presentation_view === "join_qr";
      const targetCue = orderedCues[currentIndex + (direction === "next" ? 1 : -1)];
      if (showingQr && direction === "next" && snapshot.current_cue_run) {
        await sendCommand(sessionId, snapshot.state_version, { type: "show_cue" }, token || undefined);
      } else if (!showingQr && direction === "previous" && currentIndex === 0) {
        await sendCommand(sessionId, snapshot.state_version, { type: "show_join_qr" }, token || undefined);
      } else if (targetCue) {
        await sendCommand(sessionId, snapshot.state_version, { type: "prepare_cue", cue_id: targetCue.id }, token || undefined);
      }
      await apiJson(`/api/sessions/${sessionId}/navigation`, {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        body: JSON.stringify({ direction }),
      });
      setError(null);
    } catch (cause) {
      setError(actionError(cause));
    } finally {
      await refreshLive().catch(() => undefined);
      setBusy(false);
    }
  }

  async function updateQuestion(questionId: string, status: Question["status"]) {
    setBusy(true);
    try {
      await apiJson(`/api/sessions/${sessionId}/questions/${questionId}`, {
        method: "PATCH",
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        body: JSON.stringify({ status }),
      });
      await refreshLive();
      setError(null);
    } catch (cause) {
      setError(actionError(cause));
    } finally {
      setBusy(false);
    }
  }

  if (error?.kind === "auth") return <main className="remote-shell remote-auth"><h1>{t("auth.heading")}</h1><p>{t("remote.openFromStudio")}</p><a className="primary-button" href={`/api/auth/google/start?return_to=/remote/${sessionId}`}>{t("auth.google")}</a></main>;
  if (error?.kind === "token") return <main className="remote-shell remote-auth"><h1>{t("remote.invalid")}</h1><p>{t("remote.expired")}</p></main>;
  if (error?.kind === "load" && !live) return <main className="remote-shell remote-auth"><h1>{t("remote.loadFailed")}</h1><p>{t("remote.loadFailedCopy")}</p></main>;
  if (!live) return <main className="center-state">{t("status.checking")}</main>;
  const snapshot = live.snapshot;
  const cueState = snapshot.current_cue_run?.state;
  const currentInteraction = snapshot.current_cue_run?.interactions[0];
  const showingQr = snapshot.presentation_view === "join_qr";
  const liveQuestions = live.questions;
  const responseCount = live.aggregates.reduce((sum, item) => sum + (item.aggregate.total_responses ?? 0), 0);
  return (
    <main className="remote-shell">
      <header><span className={snapshot.status === "live" ? "live-light active" : "live-light"} /><span>{t(`statusName.${snapshot.status}`)}</span><strong>{snapshot.join_code}</strong></header>
      <section>
        <p className="eyebrow">{t("remote.heading")}</p>
        <h1>{showingQr ? t("live.qrHome") : (currentInteraction?.prompt ?? t("remote.noCue"))}</h1>
        <div className="remote-reveal">
          {snapshot.status === "lobby" && <button disabled={busy} onClick={() => send({ type: "start" })}>{t("live.start")}</button>}
          {cueState === "ready" && <button disabled={busy} onClick={() => send({ type: "open_cue" })}>{t("live.open")}</button>}
          {(cueState === "open" || cueState === "closed") && <button className="reveal-action" disabled={busy} onClick={() => send({ type: "reveal_cue" })}>{t("live.reveal")}</button>}
          {cueState === "revealed" && <button disabled={busy} onClick={() => send({ type: "reopen_cue" })}>{t("live.reopen")}</button>}
        </div>
        <div className="remote-navigation">
          <button disabled={busy} onClick={() => navigate("previous")}><span>←</span>{t("remote.previous")}</button>
          <button disabled={busy} onClick={() => navigate("next")}>{t("remote.next")}<span>→</span></button>
        </div>
      </section>
      <section className="remote-responses">
        <h2>{t("remote.responses")}<small>{t("live.responses")} {responseCount}</small></h2>
        {snapshot.current_cue_run?.interactions.length ? snapshot.current_cue_run.interactions.map((interaction) => {
          const aggregate = aggregateFor(live, interaction.id);
          const showPrompt = (snapshot.current_cue_run?.interactions.length ?? 0) > 1;
          return (
            <article className="remote-interaction" key={interaction.id}>
              {showPrompt && <h3>{interaction.prompt}</h3>}
              {interaction.interaction_type === "qa" ? (
                liveQuestions.length
                  ? (
                    <div className="question-list">
                      {liveQuestions.map((question) => (
                        <article className={`question-card question-${question.status}${question.display_name ? " question-card-signed" : ""}`} key={question.id}>
                          <div>
                            {question.status === "pinned" && <span className="question-status">{t("qa.pinned")}</span>}
                            {question.status === "highlighted" && <span className="question-status">{t("qa.highlighted")}</span>}
                            <p>{question.body}</p>
                            <small>{t("qa.votes", { count: question.votes })}</small>
                          </div>
                          {question.display_name && <small className="question-author">— {question.display_name}</small>}
                          <div className="question-actions">
                            <button disabled={busy} onClick={() => updateQuestion(question.id, question.status === "pinned" ? "visible" : "pinned")}>{question.status === "pinned" ? t("qa.unpin") : t("qa.pin")}</button>
                            <button disabled={busy} onClick={() => updateQuestion(question.id, question.status === "highlighted" ? "visible" : "highlighted")}>{question.status === "highlighted" ? t("qa.unhighlight") : t("qa.highlight")}</button>
                            <button disabled={busy} onClick={() => updateQuestion(question.id, question.status === "answered" ? "visible" : "answered")}>{question.status === "answered" ? t("qa.unlowlight") : t("qa.lowlight")}</button>
                            <button disabled={busy} onClick={() => updateQuestion(question.id, question.status === "hidden" ? "visible" : "hidden")}>{question.status === "hidden" ? t("qa.restore") : t("qa.hide")}</button>
                          </div>
                        </article>
                      ))}
                    </div>
                  )
                  : <p className="remote-empty">{t("qa.empty")}</p>
              ) : aggregate ? (
                <RemoteAggregate
                  t={t}
                  aggregate={aggregate}
                  onToggleWordPin={(text, pinned) => void pinWordCloud(sessionId, token, interaction.id, text, pinned).then(() => refreshLive()).catch((cause) => setError(actionError(cause)))}
                />
              ) : (
                <p className="remote-empty">{t("projection.noResults")}</p>
              )}
            </article>
          );
        }) : <p className="remote-empty">{t("projection.noResults")}</p>}
      </section>
      <section className="remote-cues">
        <h2>{t("remote.cues")}</h2>
        <button className={showingQr ? "selected" : ""} disabled={busy} onClick={() => send({ type: "show_join_qr" })}><span>QR</span>{t("live.qrHome")}<small>{t("projection.join")}</small></button>
        {cues.map((cue) => <button className={!showingQr && cue.id === snapshot.current_cue_run?.cue_id ? "selected" : ""} disabled={busy} key={cue.id} onClick={() => send(cue.id === snapshot.current_cue_run?.cue_id ? { type: "show_cue" } : { type: "prepare_cue", cue_id: cue.id })}><span>{cue.position + 1}</span>{cueNavigationLabel(t, cue)}<small>{cue.trigger_mode === "immediate" ? t("cue.immediate") : t("cue.confirm")}</small></button>)}
      </section>
      {error && <p className="form-error">{error.kind === "action" ? actionMessage(t, error.code) : t("remote.loadFailed")}</p>}
    </main>
  );
}
