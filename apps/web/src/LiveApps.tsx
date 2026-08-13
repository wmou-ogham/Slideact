import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, apiJson, postJson, uuid } from "./api";
import { sendCommand } from "./PresenterApp";
import type { Cue, LiveView, SessionCommand, SessionSnapshot, SnapshotInteraction } from "./types";

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

export function AudienceApp({ t, locale }: { t: Translate; locale: string }) {
  const pathCode = decodeURIComponent(location.pathname.split("/")[2] ?? "");
  const [code, setCode] = useState(pathCode);
  const [joined, setJoined] = useState<JoinResponse | null>(null);
  const [live, setLive] = useState<LiveView | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
      setLive({ snapshot: response.snapshot, audience_count: 1, aggregates: [] });
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

  async function answer(interaction: SnapshotInteraction, payload: Record<string, unknown>, label: string) {
    if (!joined || !live?.snapshot.current_cue_run) return;
    setBusy(true);
    setError("");
    try {
      await apiJson(`/api/audience/interactions/${interaction.id}/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${joined.token}` },
        body: JSON.stringify({
          cue_run_id: live.snapshot.current_cue_run.id,
          idempotency_key: uuid(),
          payload,
        }),
      });
      setAnswers((current) => ({ ...current, [interaction.id]: label }));
      await refresh();
    } catch (cause) {
      setError(t("error.generic", { code: cause instanceof ApiError ? cause.code : "network_error" }));
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
                />
              ))}
            </div>
          </>
        ) : (
          <ResultsView t={t} live={live} cueName={cueRun.cue_name} state={cueRun.state} />
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
      </section>
    </main>
  );
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

function AudienceInteraction({ t, interaction, answer, busy, submit }: {
  t: Translate;
  interaction: SnapshotInteraction;
  answer?: string;
  busy: boolean;
  submit: (payload: Record<string, unknown>, label: string) => void;
}) {
  const [text, setText] = useState("");

  return (
    <article className="audience-question">
      <span className="type-badge">{typeName(t, interaction.interaction_type)}</span>
      <h2>{interaction.prompt}</h2>
      {interaction.description && <p>{interaction.description}</p>}
      {interaction.interaction_type === "understanding" && (
        <div className="understanding-buttons">
          <button className={answer === "yes" ? "selected yes" : "yes"} disabled={busy} onClick={() => submit({ understood: true }, "yes")}>{t("audience.yes")}</button>
          <button className={answer === "no" ? "selected no" : "no"} disabled={busy} onClick={() => submit({ understood: false }, "no")}>{t("audience.no")}</button>
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
      {interaction.interaction_type === "qa" && <p className="pending-type">{t("audience.typeSoon")}</p>}
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
    </div>
  );
}

function AggregateBars({ aggregate }: { aggregate: LiveView["aggregates"][number]["aggregate"] }) {
  if (aggregate.interaction_type === "understanding") {
    const percent = Math.round(aggregate.understood_percent ?? 0);
    return <div className="result-block"><strong>{percent}%</strong><div className="result-track"><span style={{ width: `${percent}%` }} /></div></div>;
  }
  if (aggregate.interaction_type === "word_cloud") {
    return (
      <div className="word-cloud-results">
        {aggregate.entries?.map((entry) => (
          <span key={entry.text} style={{ fontSize: `${Math.min(2.2, 1 + entry.count / 3)}rem` }}>
            {entry.text}<small>×{entry.count}</small>
          </span>
        ))}
      </div>
    );
  }
  return <div className="result-options">{aggregate.options?.map((option) => {
    const percent = aggregate.total_responses ? Math.round(option.count * 100 / aggregate.total_responses) : 0;
    return <div key={option.option_id}><span>{option.label}</span><div className="result-track"><i style={{ width: `${percent}%` }} /></div><strong>{percent}%</strong></div>;
  })}</div>;
}

export function RemoteApp({ t }: { t: Translate }) {
  const sessionId = location.pathname.split("/")[2] ?? "";
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const next = await apiJson<SessionSnapshot>(`/api/sessions/${sessionId}/snapshot`);
    setSnapshot(next);
    setCues(await apiJson<Cue[]>(`/api/projects/${next.project_id}/cues`));
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
        </div>
      </section>
      <section className="remote-cues">
        <h2>{t("remote.cues")}</h2>
        {cues.map((cue) => <button disabled={busy} key={cue.id} onClick={() => send({ type: "prepare_cue", cue_id: cue.id })}><span>{cue.position + 1}</span>{cue.name}<small>{cue.anchor_value ? t("cue.slide", { slide: cue.anchor_value }) : t("cue.manual")}</small></button>)}
      </section>
      {error && error !== "auth" && <p className="form-error">{t("error.generic", { code: error })}</p>}
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
  return (
    <main className="overlay-root">
      <section className="overlay-card">
        <div className="overlay-meta"><span>LIVE · {live.audience_count}</span><strong>{live.snapshot.join_code}</strong></div>
        <h1>{cueRun.interactions[0]?.prompt ?? cueRun.cue_name}</h1>
        {live.aggregates.length ? live.aggregates.map((item) => <AggregateBars key={item.interaction_id} aggregate={item.aggregate} />) : <p>{cueRun.state === "open" ? t("overlay.collecting") : t("audience.closed")}</p>}
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
