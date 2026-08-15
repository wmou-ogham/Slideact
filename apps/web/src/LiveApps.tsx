import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";

import { ApiError, apiJson, postJson, uuid } from "./api";
import { sendCommand } from "./PresenterApp";
import { AggregateBars, CueResultVisuals, QuestionList } from "./ResultVisuals";
import type { Cue, LiveView, Question, SessionCommand, SessionSnapshot, SnapshotInteraction } from "./types";

type Translate = (key: any, params?: Readonly<Record<string, string | number>>) => string;

type JoinResponse = {
  session_id: string;
  participant_id: string;
  participant_key: string;
  token: string;
  topic: string;
  expires_in_seconds: number;
  snapshot: SessionSnapshot;
};

type PendingAnswer = {
  interaction: SnapshotInteraction;
  payload: Record<string, unknown>;
  label: string;
  idempotencyKey: string;
};

export function AudienceApp({ t, locale }: { t: Translate; locale: string }) {
  const pathCode = decodeURIComponent(location.pathname.split("/")[2] ?? "");
  const [code, setCode] = useState(pathCode);
  const [joined, setJoined] = useState<JoinResponse | null>(null);
  const [live, setLive] = useState<LiveView | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pendingAnswer, setPendingAnswer] = useState<PendingAnswer | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  const cueLiveCache = useRef<Record<string, LiveView>>({});

  useEffect(() => {
    const connected = () => setOnline(true);
    const disconnected = () => setOnline(false);
    window.addEventListener("online", connected);
    window.addEventListener("offline", disconnected);
    return () => {
      window.removeEventListener("online", connected);
      window.removeEventListener("offline", disconnected);
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!joined) return;
    const next = await loadLiveView(joined.session_id, joined.token);
    setLive(rememberCueLive(cueLiveCache.current, next));
    setAnswers((current) => mergeAudienceAnswers(joined.session_id, joined.participant_id, current, next.my_responses));
  }, [joined]);

  useEffect(() => {
    if (!joined) return;
    const stopSocket = connectLiveSocket(joined.token, joined.topic, refresh);
    const timer = window.setInterval(() => refresh().catch(() => undefined), 3500);
    return () => {
      stopSocket();
      window.clearInterval(timer);
    };
  }, [joined, refresh]);

  async function join(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError("");
    try {
      const participantKey = localStorage.getItem("slide-helper-participant-key");
      const response = await postJson<JoinResponse>("/api/audience/join", {
        join_code: code,
        locale,
        participant_key: participantKey,
      });
      localStorage.setItem("slide-helper-participant-key", response.participant_key);
      setJoined(response);
      setAnswers(readStoredAnswers(response.session_id, response.participant_id));
      setLive({ snapshot: response.snapshot, audience_count: 1, aggregates: [], questions: [], my_responses: [] });
      history.replaceState(null, "", `/join/${code}`);
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.code === "join_code_not_found"
          ? t("audience.codeNotFound")
          : t("error.generic", { code: cause instanceof ApiError ? cause.code : "network_error" }),
      );
    } finally {
      setBusy(false);
    }
  }

  async function answer(
    interaction: SnapshotInteraction,
    payload: Record<string, unknown>,
    label: string,
    idempotencyKey = uuid(),
  ) {
    if (!joined || !live?.snapshot.current_cue_run) return false;
    setBusy(true);
    setError("");
    setPendingAnswer(null);
    try {
      await apiJson(`/api/audience/interactions/${interaction.id}/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${joined.token}` },
        body: JSON.stringify({
          cue_run_id: live.snapshot.current_cue_run.id,
          idempotency_key: idempotencyKey,
          payload,
        }),
      });
      setAnswers((current) => {
        const next = { ...current, [interaction.id]: label };
        storeAnswers(joined.session_id, joined.participant_id, next);
        return next;
      });
      setPendingAnswer(null);
      await refresh();
      return true;
    } catch (cause) {
      setError(audienceError(t, cause));
      if (!(cause instanceof ApiError) || cause.status >= 500) {
        setPendingAnswer({ interaction, payload, label, idempotencyKey });
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submitQuestion(body: string) {
    if (!joined || !live?.snapshot.current_cue_run) return;
    setBusy(true);
    setError("");
    try {
      await apiJson("/api/audience/questions", {
        method: "POST",
        headers: { authorization: `Bearer ${joined.token}` },
        body: JSON.stringify({ cue_run_id: live.snapshot.current_cue_run.id, body }),
      });
      await refresh();
    } catch (cause) {
      setError(audienceError(t, cause));
    } finally {
      setBusy(false);
    }
  }

  async function voteQuestion(questionId: string) {
    if (!joined) return;
    setBusy(true);
    setError("");
    try {
      await apiJson(`/api/audience/questions/${questionId}/vote`, {
        method: "POST",
        headers: { authorization: `Bearer ${joined.token}` },
      });
      await refresh();
    } catch (cause) {
      setError(audienceError(t, cause));
    } finally {
      setBusy(false);
    }
  }

  if (!joined) {
    return (
      <main className="audience-shell join-card">
        <p className="eyebrow">{t("audience.eyebrow")}</p>
        <h1>{t("audience.joinHeading")}</h1>
        <p>{t("audience.joinCopy")}</p>
        <form onSubmit={join}>
          <input autoFocus inputMode="text" autoCapitalize="characters" pattern="[A-Za-z0-9]*" value={code} onChange={(event) => setCode(event.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 6))} maxLength={6} placeholder="123456" aria-label={t("landing.codePlaceholder")} />
          <button className="primary-button" disabled={busy || code.length !== 6}>{t("landing.join")}</button>
        </form>
        {error && <p className="form-error" role="alert">{error}</p>}
      </main>
    );
  }

  const snapshot = live?.snapshot ?? joined.snapshot;
  const cueRun = snapshot.current_cue_run;
  return (
    <main className="audience-shell">
      <header className="audience-header">
        <span className={online ? "connection-state online" : "connection-state offline"}>{online ? t("audience.online") : t("audience.offline")}</span>
        <span className="audience-count">{t("audience.people", { count: live?.audience_count ?? 1 })}</span>
      </header>
      <section className="audience-stage">
        <p className="eyebrow">{snapshot.join_code} · {t(`statusName.${snapshot.status}`)}</p>
        {!cueRun || cueRun.state === "ready" ? (
          <WaitingState t={t} status={snapshot.status} />
        ) : cueRun.state === "open" ? (
          <>
            <h1>{cueRun.cue_name}</h1>
            <div className="audience-interactions">
              {cueRun.interactions.map((interaction) => (
                <AudienceInteraction
                  key={interaction.id}
                  t={t}
                  interaction={interaction}
                  answer={answers[interaction.id]}
                  sentCount={(live?.my_responses ?? []).filter((item) => item.interaction_id === interaction.id).length}
                  busy={busy}
                  submit={(payload, label) => answer(interaction, payload, label)}
                  questions={live?.questions ?? []}
                  submitQuestion={submitQuestion}
                  voteQuestion={voteQuestion}
                />
              ))}
            </div>
          </>
        ) : (
          <ResultsView t={t} live={live} cueName={cueRun.cue_name} state={cueRun.state} />
        )}
        {error && <div className="audience-error"><p className="form-error" role="alert">{error}</p>{pendingAnswer && <button disabled={busy} onClick={() => answer(pendingAnswer.interaction, pendingAnswer.payload, pendingAnswer.label, pendingAnswer.idempotencyKey)}>{t("audience.retry")}</button>}</div>}
      </section>
    </main>
  );
}

const WORD_CLOUD_MAX_SUBMISSIONS = 3;

function audienceError(t: Translate, cause: unknown) {
  if (cause instanceof ApiError && cause.status === 429) return t("audience.rateLimited");
  if (cause instanceof ApiError && cause.code === "response_limit_reached") return t("audience.wordCloudLimit", { max: WORD_CLOUD_MAX_SUBMISSIONS });
  return t("error.generic", { code: cause instanceof ApiError ? cause.code : "network_error" });
}

function WaitingState({ t, status }: { t: Translate; status: string }) {
  return (
    <div className="waiting-state">
      <span className="waiting-orbit"><i /></span>
      <h1>{status === "paused" ? t("audience.paused") : status === "ended" ? t("audience.ended") : t("audience.waiting")}</h1>
      <p>{t("audience.waitingCopy")}</p>
    </div>
  );
}

function AudienceInteraction({ t, interaction, answer, sentCount = 0, busy, submit, questions, submitQuestion, voteQuestion }: {
  t: Translate;
  interaction: SnapshotInteraction;
  answer?: string;
  sentCount?: number;
  busy: boolean;
  submit: (payload: Record<string, unknown>, label: string) => Promise<boolean>;
  questions: Question[];
  submitQuestion: (body: string) => Promise<void>;
  voteQuestion: (questionId: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [questionBody, setQuestionBody] = useState("");
  const wordCloudRemaining = Math.max(0, WORD_CLOUD_MAX_SUBMISSIONS - sentCount);
  const wordCloudFull = interaction.interaction_type === "word_cloud" && wordCloudRemaining === 0;

  return (
    <article className="audience-question">
      <span className="type-badge">{typeName(t, interaction.interaction_type)}</span>
      <h2>{interaction.prompt}</h2>
      {interaction.description && <p>{interaction.description}</p>}
      {interaction.interaction_type === "understanding" && (
        <div className="understanding-buttons">
          <button className={answer === "green" ? "selected green" : "green"} disabled={busy} onClick={() => submit({ level: "green" }, "green")}>{t("audience.green")}</button>
          <button className={answer === "yellow" ? "selected yellow" : "yellow"} disabled={busy} onClick={() => submit({ level: "yellow" }, "yellow")}>{t("audience.yellow")}</button>
          <button className={answer === "red" ? "selected red" : "red"} disabled={busy} onClick={() => submit({ level: "red" }, "red")}>{t("audience.red")}</button>
        </div>
      )}
      {interaction.interaction_type === "single_choice" && (
        <div className="choice-buttons">
          {interaction.options.map((option, index) => (
            <button className={answer === option.id ? "selected" : ""} disabled={busy} key={option.id} onClick={() => submit({ option_id: option.id }, option.id)}>
              <span>{String.fromCharCode(65 + index)}</span>{option.label}
            </button>
          ))}
        </div>
      )}
      {interaction.interaction_type === "word_cloud" && (
        <form className="text-response" onSubmit={async (event) => {
          event.preventDefault();
          const value = text.trim();
          if (!value || wordCloudFull) return;
          if (await submit({ text: value }, value)) setText("");
        }}>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={200}
            placeholder={t("audience.textPlaceholder")}
            disabled={busy || wordCloudFull}
            rows={3}
          />
          <button disabled={busy || wordCloudFull || !text.trim()}>{t("audience.send")}</button>
        </form>
      )}
      {interaction.interaction_type === "qa" && (
        <div className="qa-audience">
          <form className="text-response" onSubmit={async (event) => {
            event.preventDefault();
            const value = questionBody.trim();
            if (!value) return;
            await submitQuestion(value);
            setQuestionBody("");
          }}>
            <textarea
              value={questionBody}
              onChange={(event) => setQuestionBody(event.target.value)}
              maxLength={500}
              placeholder={t("qa.placeholder")}
              disabled={busy}
              rows={3}
            />
            <button disabled={busy || !questionBody.trim()}>{t("qa.ask")}</button>
          </form>
          <QuestionList t={t} questions={questions} busy={busy} onVote={voteQuestion} />
        </div>
      )}
      {interaction.interaction_type === "word_cloud"
        ? sentCount > 0 && (
          <p className="answer-saved">
            {wordCloudFull
              ? t("audience.wordCloudLimit", { max: WORD_CLOUD_MAX_SUBMISSIONS })
              : t("audience.wordCloudSaved", { remaining: wordCloudRemaining })}
          </p>
        )
        : answer && <p className="answer-saved">{t("audience.saved")}</p>}
    </article>
  );
}

function ResultsView({ t, live, cueName, state }: { t: Translate; live: LiveView | null; cueName: string; state: string }) {
  return (
    <div className="audience-results">
      <p className="eyebrow">{state === "revealed" ? t("audience.results") : t("audience.closed")}</p>
      <h1>{cueName}</h1>
      {live?.aggregates.map((item) => <AggregateBars t={t} key={item.interaction_id} aggregate={item.aggregate} />)}
      {live?.questions.length ? <QuestionList t={t} questions={live.questions} busy /> : null}
    </div>
  );
}

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

export function RemoteApp({ t }: { t: Translate }) {
  const sessionId = location.pathname.split("/")[2] ?? "";
  const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [live, setLive] = useState<LiveView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cueLiveCache = useRef<Record<string, LiveView>>({});

  const refreshLive = useCallback(async () => {
    if (!token) return;
    setLive(rememberCueLive(cueLiveCache.current, await loadLiveView(sessionId, token)));
  }, [sessionId, token]);

  const refresh = useCallback(async () => {
    const headers = token ? { authorization: `Bearer ${token}` } : undefined;
    const next = await apiJson<SessionSnapshot>(`/api/sessions/${sessionId}/snapshot`, { headers });
    setSnapshot(next);
    const [nextCues, nextQuestions] = await Promise.all([
      apiJson<Cue[]>(`/api/sessions/${sessionId}/controller-cues`, { headers }),
      apiJson<Question[]>(`/api/sessions/${sessionId}/questions`, { headers }),
    ]);
    setCues(nextCues);
    setQuestions(nextQuestions);
    await refreshLive().catch(() => undefined);
  }, [refreshLive, sessionId, token]);

  useEffect(() => {
    refresh().catch((cause) => setError(cause instanceof ApiError && (cause.status === 401 || cause.status === 403) ? (token ? "token" : "auth") : "load"));
    const timer = window.setInterval(() => refresh().catch(() => undefined), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!token) return;
    return connectLiveSocket(token, `session:${sessionId}:presenter`, refreshLive);
  }, [refreshLive, sessionId, token]);

  async function send(command: SessionCommand) {
    if (!snapshot) return;
    setBusy(true);
    try {
      setSnapshot(await sendCommand(sessionId, snapshot.state_version, command, token || undefined));
      setError("");
      await refreshLive().catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.code : "network_error");
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function navigate(direction: "previous" | "next") {
    setBusy(true);
    try {
      const orderedCues = [...cues].sort((left, right) => left.position - right.position);
      const currentIndex = snapshot?.current_cue_run
        ? orderedCues.findIndex((cue) => cue.id === snapshot.current_cue_run?.cue_id)
        : -1;
      const showingQr = snapshot?.presentation_view === "join_qr";
      const targetCue = orderedCues[currentIndex + (direction === "next" ? 1 : -1)];
      if (showingQr && direction === "next" && snapshot?.current_cue_run) {
        setSnapshot(await sendCommand(
          sessionId,
          snapshot.state_version,
          { type: "show_cue" },
          token || undefined,
        ));
      } else if (!showingQr && direction === "previous" && currentIndex === 0 && snapshot) {
        setSnapshot(await sendCommand(
          sessionId,
          snapshot.state_version,
          { type: "show_join_qr" },
          token || undefined,
        ));
      } else if (targetCue && snapshot) {
        setSnapshot(await sendCommand(
          sessionId,
          snapshot.state_version,
          { type: "prepare_cue", cue_id: targetCue.id },
          token || undefined,
        ));
      }
      await apiJson(`/api/sessions/${sessionId}/navigation`, {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        body: JSON.stringify({ direction }),
      });
      setError("");
      await refreshLive().catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.code : "network_error");
    } finally {
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
      await refresh();
      setError("");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.code : "network_error");
    } finally {
      setBusy(false);
    }
  }

  if (error === "auth") return <main className="remote-shell remote-auth"><h1>{t("auth.heading")}</h1><p>{t("remote.openFromStudio")}</p><a className="primary-button" href={`/api/auth/google/start?return_to=/remote/${sessionId}`}>{t("auth.google")}</a></main>;
  if (error === "token") return <main className="remote-shell remote-auth"><h1>{t("remote.invalid")}</h1><p>{t("remote.expired")}</p></main>;
  if (!snapshot) return <main className="center-state">{t("status.checking")}</main>;
  const cueState = snapshot.current_cue_run?.state;
  const currentInteraction = snapshot.current_cue_run?.interactions[0];
  const showingQr = snapshot.presentation_view === "join_qr";
  const liveQuestions = live?.questions.length ? live.questions : questions;
  const responseCount = live?.aggregates.reduce((sum, item) => sum + (item.aggregate.total_responses ?? 0), 0) ?? 0;
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
                        <article className={`question-card question-${question.status}`} key={question.id}>
                          <div>
                            {question.status === "pinned" && <span>{t("qa.pinned")}</span>}
                            {question.status === "highlighted" && <span>{t("qa.highlighted")}</span>}
                            <p>{question.body}</p>
                            <small>{t("qa.votes", { count: question.votes })}</small>
                          </div>
                          <div className="question-actions">
                            <button disabled={busy} onClick={() => updateQuestion(question.id, question.status === "pinned" ? "visible" : "pinned")}>{question.status === "pinned" ? t("qa.unpin") : t("qa.pin")}</button>
                            <button disabled={busy} onClick={() => updateQuestion(question.id, question.status === "highlighted" ? "visible" : "highlighted")}>{question.status === "highlighted" ? t("qa.unhighlight") : t("qa.highlight")}</button>
                            <button disabled={busy} onClick={() => updateQuestion(question.id, question.status === "answered" ? "visible" : "answered")}>{question.status === "answered" ? t("qa.restore") : t("qa.markAnswered")}</button>
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
                  onToggleWordPin={(text, pinned) => void pinWordCloud(sessionId, token, interaction.id, text, pinned).then(() => refreshLive()).catch((cause) => setError(cause instanceof ApiError ? cause.code : "network_error"))}
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
        {cues.map((cue) => <button className={!showingQr && cue.id === snapshot.current_cue_run?.cue_id ? "selected" : ""} disabled={busy} key={cue.id} onClick={() => send(cue.id === snapshot.current_cue_run?.cue_id ? { type: "show_cue" } : { type: "prepare_cue", cue_id: cue.id })}><span>{cue.position + 1}</span>{remoteCueLabel(t, cue)}<small>{cue.trigger_mode === "immediate" ? t("cue.immediate") : t("cue.confirm")}</small></button>)}
      </section>
      {error && error !== "auth" && <p className="form-error">{t("error.generic", { code: error })}</p>}
    </main>
  );
}

export function ProjectionApp({ t }: { t: Translate }) {
  const sessionId = location.pathname.split("/")[2] ?? "";
  const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
  const [live, setLive] = useState<LiveView | null>(null);
  const [error, setError] = useState("");
  const cueLiveCache = useRef<Record<string, LiveView>>({});
  const refresh = useCallback(async () => {
    if (!token) throw new Error("projection_token_missing");
    setLive(rememberCueLive(cueLiveCache.current, await loadLiveView(sessionId, token)));
  }, [sessionId, token]);

  useEffect(() => {
    document.body.classList.add("projection-body");
    refresh().catch(() => setError("projection_token_invalid"));
    const timer = window.setInterval(() => refresh().catch(() => undefined), 2000);
    return () => {
      document.body.classList.remove("projection-body");
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (!token) return;
    return connectLiveSocket(token, `session:${sessionId}:presenter`, refresh);
  }, [refresh, sessionId, token]);

  if (error) return <main className="projection-error">{t("projection.invalid")}</main>;
  if (!live) return <main className="projection-root"><span className="waiting-orbit"><i /></span></main>;
  const cueRun = live.snapshot.current_cue_run;
  const interactions = cueRun?.interactions ?? [];
  const multi = interactions.length > 1;
  return (
    <main className="projection-root">
      <header><span>SLIDEACT · LIVE</span><strong>{live.snapshot.join_code}</strong></header>
      {live.snapshot.presentation_view === "join_qr" || !cueRun ? (
        <section className="projection-waiting"><p>{t("projection.join")}</p><strong>{live.snapshot.join_code}</strong><ProjectionJoinQr code={live.snapshot.join_code ?? ""} label={t("live.joinQr")} /><small>{t("projection.waiting")}</small></section>
      ) : cueRun.state === "ready" ? (
        <section className="projection-results projection-cue-ready">
          <p>{t("status.ready")}</p>
          {multi
            ? interactions.map((interaction) => <h1 key={interaction.id}>{interaction.prompt}</h1>)
            : <h1>{interactions[0]?.prompt ?? cueRun.cue_name}</h1>}
        </section>
      ) : (
        <section className={multi ? "projection-results projection-multi" : "projection-results"}>
          <p>{cueRun.state === "open" ? t("overlay.collecting") : cueRun.state === "revealed" ? t("audience.results") : t("audience.closed")}</p>
          {!multi && <h1>{interactions[0]?.prompt ?? cueRun.cue_name}</h1>}
          <CueResultVisuals
            t={t}
            interactions={interactions.map((interaction) => ({
              id: interaction.id,
              prompt: interaction.prompt,
              interaction_type: interaction.interaction_type,
              aggregate: aggregateFor(live, interaction.id),
            }))}
            questions={live.questions}
            onToggleWordPin={(interactionId, text, pinned) => {
              void pinWordCloud(sessionId, token, interactionId, text, pinned)
                .then(() => refresh())
                .catch(() => undefined);
            }}
          />
        </section>
      )}
    </main>
  );
}

function ProjectionJoinQr({ code, label }: { code: string; label: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(`${window.location.origin}/join/${encodeURIComponent(code)}`);
    qr.make();
    return qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
  }, [code]);
  return <div className="projection-join-qr" aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function OverlayApp({ t }: { t: Translate }) {
  const sessionId = location.pathname.split("/")[2] ?? "";
  const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
  const [live, setLive] = useState<LiveView | null>(null);
  const [error, setError] = useState("");
  const cueLiveCache = useRef<Record<string, LiveView>>({});
  const refresh = useCallback(async () => {
    if (!token) throw new Error("token_missing");
    setLive(rememberCueLive(cueLiveCache.current, await loadLiveView(sessionId, token)));
  }, [sessionId, token]);

  useEffect(() => {
    document.documentElement.classList.add("overlay-html");
    document.body.classList.add("overlay-body");
    refresh().catch(() => setError("overlay_token_invalid"));
    const timer = window.setInterval(() => refresh().catch(() => undefined), 2000);
    return () => {
      document.documentElement.classList.remove("overlay-html");
      document.body.classList.remove("overlay-body");
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (!token) return;
    return connectLiveSocket(token, `session:${sessionId}:overlay`, refresh);
  }, [refresh, sessionId, token]);

  if (error) return <main className="overlay-error"><span>{t("overlay.invalid")}</span></main>;
  if (!live) return <main className="overlay-root"><span className="waiting-orbit"><i /></span></main>;
  const cueRun = live.snapshot.current_cue_run;
  if (live.snapshot.presentation_view === "join_qr") return <main className="overlay-root overlay-minimal"><div className="overlay-code"><small>{t("projection.join")}</small><ProjectionJoinQr code={live.snapshot.join_code ?? ""} label={t("live.joinQr")} /><strong>{live.snapshot.join_code}</strong></div></main>;
  if (!cueRun) return <main className="overlay-root overlay-minimal"><div className="overlay-code"><small>{t("projection.waiting")}</small><strong>{live.snapshot.join_code}</strong></div></main>;
  if (cueRun.state === "ready") return <main className="overlay-root"><section className="overlay-card"><div className="overlay-meta"><span>{t("status.ready")}</span><strong>{live.snapshot.join_code}</strong></div><h1>{cueRun.interactions[0]?.prompt ?? cueRun.cue_name}</h1></section></main>;
  const pinnedQuestion = live.questions.find((question) => question.status === "pinned")
    ?? live.questions.find((question) => question.status === "highlighted");
  const multi = cueRun.interactions.length > 1;
  return (
    <main className="overlay-root">
      <section className="overlay-card">
        <div className="overlay-meta"><span>LIVE · {live.audience_count}</span><strong>{live.snapshot.join_code}</strong></div>
        {cueRun.interactions.map((interaction) => {
          const aggregate = aggregateFor(live, interaction.id);
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

async function loadLiveView(sessionId: string, token: string) {
  return apiJson<LiveView>(`/api/live/sessions/${sessionId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

async function pinWordCloud(
  sessionId: string,
  token: string,
  interactionId: string,
  text: string,
  pinned: boolean,
) {
  await apiJson(`/api/sessions/${sessionId}/interactions/${interactionId}/word-cloud/pin`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ text, pinned }),
  });
}

function aggregateFor(live: LiveView | null, interactionId: string) {
  return live?.aggregates.find((item) => item.interaction_id === interactionId)?.aggregate;
}

function rememberCueLive(cache: Record<string, LiveView>, live: LiveView) {
  const cueId = live.snapshot.current_cue_run?.cue_id;
  if (!cueId) return live;
  const hasResponses = live.aggregates.some((item) => (item.aggregate.total_responses ?? 0) > 0)
    || live.questions.length > 0;
  if (hasResponses) {
    cache[cueId] = live;
    return live;
  }
  const remembered = cache[cueId];
  if (!remembered) return live;
  return {
    ...live,
    aggregates: remembered.aggregates,
    questions: live.questions.length ? live.questions : remembered.questions,
  };
}

function mergeAudienceAnswers(
  sessionId: string,
  participantId: string,
  current: Record<string, string>,
  myResponses: LiveView["my_responses"] | undefined,
) {
  const next = { ...readStoredAnswers(sessionId, participantId), ...current };
  for (const item of myResponses ?? []) {
    const label = labelFromPayload(item.payload);
    if (label) next[item.interaction_id] = label;
  }
  storeAnswers(sessionId, participantId, next);
  return next;
}

function labelFromPayload(payload: Record<string, unknown>) {
  if (typeof payload.level === "string") return payload.level;
  if (typeof payload.option_id === "string") return payload.option_id;
  if (typeof payload.text === "string") return payload.text;
  if (payload.understood === true) return "green";
  if (payload.understood === false) return "red";
  return undefined;
}

function answersStorageKey(sessionId: string, participantId: string) {
  return `slide-helper-answers:${sessionId}:${participantId}`;
}

function readStoredAnswers(sessionId: string, participantId: string) {
  try {
    const raw = localStorage.getItem(answersStorageKey(sessionId, participantId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function storeAnswers(sessionId: string, participantId: string, answers: Record<string, string>) {
  localStorage.setItem(answersStorageKey(sessionId, participantId), JSON.stringify(answers));
}

function connectLiveSocket(token: string, topic: string, refresh: () => Promise<void>) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/api/ws?token=${encodeURIComponent(token)}`);
  socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "subscribe", topic })));
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data)) as { type?: string };
      if (message.type === "event") refresh().catch(() => undefined);
    } catch {
      // The server only sends JSON protocol messages; polling remains the fallback.
    }
  });
  return () => socket.close();
}

function remoteCueLabel(t: Translate, cue: Cue) {
  const anchor = cue.anchor_value ?? String(cue.position + 1);
  return /^\d+$/.test(anchor)
    ? t("cue.slide", { slide: anchor })
    : t("cue.slideId", { id: anchor });
}

function typeName(t: Translate, type: SnapshotInteraction["interaction_type"]) {
  return t(`interaction.${type === "single_choice" ? "choice" : type === "word_cloud" ? "wordCloud" : type}`);
}
