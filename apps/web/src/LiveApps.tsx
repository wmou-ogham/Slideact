import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Wordcloud } from "@visx/wordcloud";

import { ApiError, apiJson, postJson, uuid } from "./api";
import { sendCommand } from "./PresenterApp";
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
    setLive(await loadLiveView(joined.session_id, joined.token));
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
      setLive({ snapshot: response.snapshot, audience_count: 1, aggregates: [], questions: [] });
      history.replaceState(null, "", `/join/${code.toUpperCase()}`);
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
    if (!joined || !live?.snapshot.current_cue_run) return;
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
      setAnswers((current) => ({ ...current, [interaction.id]: label }));
      setPendingAnswer(null);
      await refresh();
    } catch (cause) {
      setError(audienceError(t, cause));
      if (!(cause instanceof ApiError) || cause.status >= 500) {
        setPendingAnswer({ interaction, payload, label, idempotencyKey });
      }
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
          <input autoFocus value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} maxLength={6} placeholder="ABC234" aria-label={t("landing.codePlaceholder")} />
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

function audienceError(t: Translate, cause: unknown) {
  if (cause instanceof ApiError && cause.status === 429) return t("audience.rateLimited");
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

function AudienceInteraction({ t, interaction, answer, busy, submit, questions, submitQuestion, voteQuestion }: {
  t: Translate;
  interaction: SnapshotInteraction;
  answer?: string;
  busy: boolean;
  submit: (payload: Record<string, unknown>, label: string) => void;
  questions: Question[];
  submitQuestion: (body: string) => Promise<void>;
  voteQuestion: (questionId: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [questionBody, setQuestionBody] = useState("");

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
        <form className="text-response" onSubmit={(event) => {
          event.preventDefault();
          const value = text.trim();
          if (value) submit({ text: value }, value);
        }}>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={200}
            placeholder={t("audience.textPlaceholder")}
            disabled={busy}
            rows={3}
          />
          <button disabled={busy || !text.trim()}>{t("audience.send")}</button>
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
      {answer && <p className="answer-saved">{t("audience.saved")}</p>}
    </article>
  );
}

function ResultsView({ t, live, cueName, state }: { t: Translate; live: LiveView | null; cueName: string; state: string }) {
  return (
    <div className="audience-results">
      <p className="eyebrow">{state === "revealed" ? t("audience.results") : t("audience.closed")}</p>
      <h1>{cueName}</h1>
      {live?.aggregates.map((item) => <AggregateBars key={item.interaction_id} aggregate={item.aggregate} />)}
      {live?.questions.length ? <QuestionList t={t} questions={live.questions} busy /> : null}
    </div>
  );
}

function QuestionList({ t, questions, busy, onVote }: {
  t: Translate;
  questions: Question[];
  busy: boolean;
  onVote?: (questionId: string) => Promise<void>;
}) {
  if (!questions.length) return <p className="qa-empty">{t("qa.empty")}</p>;
  return (
    <div className="question-list">
      {questions.map((question) => (
        <article className={`question-card question-${question.status}`} key={question.id}>
          <div>
            {question.status === "pinned" && <span>{t("qa.pinned")}</span>}
            <p>{question.body}</p>
            {question.status === "answered" && <small>{t("qa.answered")}</small>}
          </div>
          <button
            className={question.voted_by_me ? "question-vote selected" : "question-vote"}
            disabled={busy || !onVote}
            onClick={() => onVote?.(question.id)}
            aria-label={t("qa.votes", { count: question.votes })}
          >
            <b>▲</b>{question.votes}
          </button>
        </article>
      ))}
    </div>
  );
}

function AggregateBars({ aggregate }: { aggregate: LiveView["aggregates"][number]["aggregate"] }) {
  if (aggregate.interaction_type === "understanding") {
    const segments = [
      ["green", aggregate.green_percent ?? aggregate.understood_percent ?? 0],
      ["yellow", aggregate.yellow_percent ?? 0],
      ["red", aggregate.red_percent ?? 0],
    ] as const;
    return <div className="understanding-result">{segments.map(([name, percent]) => <div key={name} className={name} style={{ width: `${percent}%` }}><span>{Math.round(percent)}%</span></div>)}</div>;
  }
  if (aggregate.interaction_type === "word_cloud") {
    return <WordCloudResult entries={aggregate.entries ?? []} />;
  }
  return <div className="result-options">{aggregate.options?.map((option) => {
    const percent = aggregate.total_responses ? Math.round(option.count * 100 / aggregate.total_responses) : 0;
    return <div key={option.option_id}><span>{option.label}</span><div className="result-track"><i style={{ width: `${percent}%` }} /></div><strong>{percent}%</strong></div>;
  })}</div>;
}

function WordCloudResult({ entries }: { entries: Array<{ text: string; count: number }> }) {
  const words = entries.slice(0, 80).map((entry) => ({ text: entry.text, value: entry.count }));
  if (!words.length) return null;
  const minimum = Math.min(...words.map((word) => word.value));
  const maximum = Math.max(...words.map((word) => word.value));
  const size = (value: number) => 24 + ((value - minimum) / Math.max(1, maximum - minimum)) * 64;
  const colors = ["#f8f6ef", "#f2ce6e", "#8dd5ae", "#f0a89f", "#d9c2f0"];
  return (
    <div className="word-cloud-results" aria-label="Word cloud">
      <svg viewBox="0 0 720 400" role="img">
        <Wordcloud
          width={720}
          height={400}
          words={words}
          padding={4}
          font='Inter, ui-sans-serif, system-ui, sans-serif'
          fontSize={(word) => size(word.value)}
          fontWeight={800}
          rotate={(_, index) => index % 7 === 0 ? -12 : index % 11 === 0 ? 12 : 0}
          spiral="archimedean"
          random={() => 0.5}
        >
          {(cloudWords) => cloudWords.map((word, index) => (
            <text
              key={`${word.text}-${index}`}
              x={word.x}
              y={word.y}
              fill={colors[index % colors.length]}
              fontFamily={word.font}
              fontSize={word.size}
              fontWeight={word.weight}
              textAnchor="middle"
              transform={`rotate(${word.rotate ?? 0}, ${word.x ?? 0}, ${word.y ?? 0})`}
            >
              {word.text}
            </text>
          ))}
        </Wordcloud>
      </svg>
    </div>
  );
}

export function RemoteApp({ t }: { t: Translate }) {
  const sessionId = location.pathname.split("/")[2] ?? "";
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const next = await apiJson<SessionSnapshot>(`/api/sessions/${sessionId}/snapshot`);
    setSnapshot(next);
    const [nextCues, nextQuestions] = await Promise.all([
      apiJson<Cue[]>(`/api/projects/${next.project_id}/cues`),
      apiJson<Question[]>(`/api/sessions/${sessionId}/questions`),
    ]);
    setCues(nextCues);
    setQuestions(nextQuestions);
  }, [sessionId]);

  useEffect(() => {
    refresh().catch((cause) => setError(cause instanceof ApiError && cause.status === 401 ? "auth" : "load"));
    const timer = window.setInterval(() => refresh().catch(() => undefined), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function send(command: SessionCommand) {
    if (!snapshot) return;
    setBusy(true);
    try {
      setSnapshot(await sendCommand(sessionId, snapshot.state_version, command));
      setError("");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.code : "network_error");
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function updateQuestion(questionId: string, status: Question["status"]) {
    setBusy(true);
    try {
      await apiJson(`/api/sessions/${sessionId}/questions/${questionId}`, {
        method: "PATCH",
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

  if (error === "auth") return <main className="remote-shell"><h1>{t("auth.heading")}</h1><a className="primary-button" href={`/api/auth/google/start?return_to=/remote/${sessionId}`}>{t("auth.google")}</a></main>;
  if (!snapshot) return <main className="center-state">{t("status.checking")}</main>;
  const cueState = snapshot.current_cue_run?.state;
  return (
    <main className="remote-shell">
      <header><span className={snapshot.status === "live" ? "live-light active" : "live-light"} /><span>{t(`statusName.${snapshot.status}`)}</span><strong>{snapshot.join_code}</strong></header>
      <section>
        <p className="eyebrow">{t("remote.heading")}</p>
        <h1>{snapshot.current_cue_run?.cue_name ?? t("remote.noCue")}</h1>
        <div className="remote-primary">
          {snapshot.status === "lobby" && <button disabled={busy} onClick={() => send({ type: "start" })}>{t("live.start")}</button>}
          {snapshot.status === "live" && <button disabled={busy} onClick={() => send({ type: "pause" })}>{t("live.pause")}</button>}
          {snapshot.status === "paused" && <button disabled={busy} onClick={() => send({ type: "resume" })}>{t("live.resume")}</button>}
          {cueState === "ready" && <button disabled={busy} onClick={() => send({ type: "open_cue" })}>{t("live.open")}</button>}
          {cueState === "open" && <button disabled={busy} onClick={() => send({ type: "close_cue" })}>{t("live.close")}</button>}
          {cueState === "closed" && <button disabled={busy} onClick={() => send({ type: "reveal_cue" })}>{t("live.reveal")}</button>}
          {(cueState === "closed" || cueState === "revealed") && <button disabled={busy} onClick={() => send({ type: "reopen_cue" })}>{t("live.reopen")}</button>}
        </div>
      </section>
      <section className="remote-cues">
        <h2>{t("remote.cues")}</h2>
        {cues.map((cue) => <button disabled={busy} key={cue.id} onClick={() => send({ type: "prepare_cue", cue_id: cue.id })}><span>{cue.position + 1}</span>{cue.name}<small>{cue.anchor_value ? t("cue.slide", { slide: cue.anchor_value }) : t("cue.manual")}</small></button>)}
      </section>
      {questions.length > 0 && (
        <section className="remote-questions">
          <h2>{t("qa.heading")}</h2>
          <div className="question-list">
            {questions.map((question) => (
              <article className={`question-card question-${question.status}`} key={question.id}>
                <div>
                  {question.status === "pinned" && <span>{t("qa.pinned")}</span>}
                  <p>{question.body}</p>
                  <small>{t("qa.votes", { count: question.votes })}</small>
                </div>
                <div className="question-actions">
                  <button disabled={busy} onClick={() => updateQuestion(question.id, question.status === "pinned" ? "visible" : "pinned")}>{question.status === "pinned" ? t("qa.unpin") : t("qa.pin")}</button>
                  <button disabled={busy} onClick={() => updateQuestion(question.id, question.status === "answered" ? "visible" : "answered")}>{question.status === "answered" ? t("qa.restore") : t("qa.markAnswered")}</button>
                  <button disabled={busy} onClick={() => updateQuestion(question.id, question.status === "hidden" ? "visible" : "hidden")}>{question.status === "hidden" ? t("qa.restore") : t("qa.hide")}</button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
      {error && error !== "auth" && <p className="form-error">{t("error.generic", { code: error })}</p>}
    </main>
  );
}

export function ProjectionApp({ t }: { t: Translate }) {
  const sessionId = location.pathname.split("/")[2] ?? "";
  const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
  const [live, setLive] = useState<LiveView | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    if (!token) throw new Error("projection_token_missing");
    setLive(await loadLiveView(sessionId, token));
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
    if (!token || !live) return;
    return connectLiveSocket(token, `session:${sessionId}:overlay`, refresh);
  }, [live?.snapshot.session_id, refresh, sessionId, token]);

  if (error) return <main className="projection-error">{t("projection.invalid")}</main>;
  if (!live) return <main className="projection-root"><span className="waiting-orbit"><i /></span></main>;
  const cueRun = live.snapshot.current_cue_run;
  const prompt = cueRun?.interactions[0]?.prompt;
  return (
    <main className="projection-root">
      <header><span>SLIDEACT · LIVE</span><strong>{live.snapshot.join_code}</strong></header>
      {!cueRun || cueRun.state === "ready" ? (
        <section className="projection-waiting"><p>{t("projection.join")}</p><strong>{live.snapshot.join_code}</strong><small>{t("projection.waiting")}</small></section>
      ) : (
        <section className="projection-results">
          <p>{cueRun.state === "open" ? t("overlay.collecting") : cueRun.state === "revealed" ? t("audience.results") : t("audience.closed")}</p>
          <h1>{prompt ?? cueRun.cue_name}</h1>
          <div className="projection-visuals">
            {live.aggregates.length
              ? live.aggregates.map((item) => <AggregateBars key={item.interaction_id} aggregate={item.aggregate} />)
              : <span className="projection-empty">{t("projection.noResults")}</span>}
          </div>
        </section>
      )}
    </main>
  );
}

export function OverlayApp({ t }: { t: Translate }) {
  const sessionId = location.pathname.split("/")[2] ?? "";
  const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
  const [live, setLive] = useState<LiveView | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    if (!token) throw new Error("token_missing");
    setLive(await loadLiveView(sessionId, token));
  }, [sessionId, token]);

  useEffect(() => {
    document.body.classList.add("overlay-body");
    refresh().catch(() => setError("overlay_token_invalid"));
    const timer = window.setInterval(() => refresh().catch(() => undefined), 2000);
    return () => {
      document.body.classList.remove("overlay-body");
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (!token || !live) return;
    return connectLiveSocket(token, `session:${sessionId}:overlay`, refresh);
  }, [live?.snapshot.session_id, refresh, sessionId, token]);

  if (error) return <main className="overlay-error">{t("overlay.invalid")}</main>;
  if (!live) return <main className="overlay-root"><span className="waiting-orbit"><i /></span></main>;
  const cueRun = live.snapshot.current_cue_run;
  if (!cueRun || cueRun.state === "ready") return <main className="overlay-root overlay-minimal"><div className="overlay-code"><small>{t("live.joinCode")}</small><strong>{live.snapshot.join_code}</strong></div></main>;
  const pinnedQuestion = live.questions.find((question) => question.status === "pinned");
  return (
    <main className="overlay-root">
      <section className="overlay-card">
        <div className="overlay-meta"><span>LIVE · {live.audience_count}</span><strong>{live.snapshot.join_code}</strong></div>
        <h1>{cueRun.interactions[0]?.prompt ?? cueRun.cue_name}</h1>
        {live.aggregates.length ? live.aggregates.map((item) => <AggregateBars key={item.interaction_id} aggregate={item.aggregate} />) : <p>{cueRun.state === "open" ? t("overlay.collecting") : t("audience.closed")}</p>}
        {pinnedQuestion && <div className="overlay-question"><span>{t("qa.pinned")}</span><p>{pinnedQuestion.body}</p><small>{t("qa.votes", { count: pinnedQuestion.votes })}</small></div>}
      </section>
    </main>
  );
}

async function loadLiveView(sessionId: string, token: string) {
  return apiJson<LiveView>(`/api/live/sessions/${sessionId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
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

function typeName(t: Translate, type: SnapshotInteraction["interaction_type"]) {
  return t(`interaction.${type === "single_choice" ? "choice" : type === "word_cloud" ? "wordCloud" : type}`);
}
