import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, apiJson, postJson, uuid } from "./api";
import type {
  Cue,
  Interaction,
  LiveSession,
  Profile,
  Project,
  SessionCommand,
  SessionSnapshot,
} from "./types";

type Translate = (key: any, params?: Readonly<Record<string, string | number>>) => string;

export function PresenterApp({ t, locale }: { t: Translate; locale: string }) {
  const [profile, setProfile] = useState<Profile | null>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [cues, setCues] = useState<Cue[]>([]);
  const [cueId, setCueId] = useState("");
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const project = projects.find((item) => item.id === projectId) ?? null;
  const cue = cues.find((item) => item.id === cueId) ?? null;

  const report = useCallback(
    (error: unknown) => {
      const code = error instanceof ApiError ? error.code : "network_error";
      setMessage(t("error.generic", { code }));
    },
    [t],
  );

  const refreshProjects = useCallback(async () => {
    const next = await apiJson<Project[]>("/api/projects");
    setProjects(next);
    setProjectId((current) =>
      next.some((item) => item.id === current) ? current : (next[0]?.id ?? ""),
    );
  }, []);

  useEffect(() => {
    apiJson<Profile>("/api/auth/me")
      .then((next) => {
        setProfile(next);
        return refreshProjects();
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) setProfile(null);
        else report(error);
      });
  }, [refreshProjects, report]);

  const refreshProject = useCallback(async () => {
    if (!projectId) {
      setCues([]);
      setSessions([]);
      return;
    }
    const [nextCues, nextSessions] = await Promise.all([
      apiJson<Cue[]>(`/api/projects/${projectId}/cues`),
      apiJson<LiveSession[]>(`/api/projects/${projectId}/sessions`),
    ]);
    setCues(nextCues);
    setSessions(nextSessions);
    setCueId((current) =>
      nextCues.some((item) => item.id === current) ? current : (nextCues[0]?.id ?? ""),
    );
    setSessionId((current) =>
      nextSessions.some((item) => item.id === current)
        ? current
        : (nextSessions.find((item) => item.status !== "ended")?.id ?? ""),
    );
  }, [projectId]);

  useEffect(() => {
    refreshProject().catch(report);
  }, [refreshProject, report]);

  const refreshSnapshot = useCallback(async () => {
    if (!sessionId) {
      setSnapshot(null);
      return;
    }
    setSnapshot(await apiJson<SessionSnapshot>(`/api/sessions/${sessionId}/snapshot`));
  }, [sessionId]);

  useEffect(() => {
    refreshSnapshot().catch(report);
  }, [refreshSnapshot, report]);

  useEffect(() => {
    if (!sessionId) return;
    const timer = window.setInterval(() => refreshSnapshot().catch(() => undefined), 3000);
    return () => window.clearInterval(timer);
  }, [refreshSnapshot, sessionId]);

  async function run(action: () => Promise<void>, success: string) {
    setBusy(true);
    setMessage("");
    try {
      await action();
      setMessage(success);
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await run(async () => {
      const created = await postJson<Project>("/api/projects", {
        title: data.get("title"),
        default_locale: locale,
      });
      await refreshProjects();
      setProjectId(created.id);
      form.reset();
    }, t("notice.projectCreated"));
  }

  async function createCue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const slide = String(data.get("slide") ?? "").trim();
    await run(async () => {
      const created = await postJson<Cue>(`/api/projects/${projectId}/cues`, {
        name: data.get("name"),
        anchor_type: slide ? "deck_slide" : "manual",
        anchor_value: slide || null,
        trigger_mode: data.get("trigger_mode"),
        delay_seconds: 0,
      });
      await refreshProject();
      setCueId(created.id);
      form.reset();
    }, t("notice.cueCreated"));
  }

  async function createInteraction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId || !cueId) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const type = String(data.get("interaction_type"));
    const rawOptions = String(data.get("options") ?? "")
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
    await run(async () => {
      await postJson<Interaction>(
        `/api/projects/${projectId}/cues/${cueId}/interactions`,
        {
          interaction_type: type,
          prompt: data.get("prompt"),
          description: null,
          settings: { schema_version: 1 },
          options:
            type === "single_choice"
              ? rawOptions.map((label) => ({ label, is_correct: null }))
              : [],
        },
      );
      await refreshProject();
      form.reset();
    }, t("notice.interactionCreated"));
  }

  async function createSession() {
    if (!projectId) return;
    await run(async () => {
      const created = await postJson<LiveSession>(`/api/projects/${projectId}/sessions`, {
        locale,
      });
      setSessionId(created.id);
      const opened = await sendCommand(created.id, created.state_version, {
        type: "open_lobby",
      });
      setSnapshot(opened);
      await refreshProject();
    }, t("notice.sessionCreated"));
  }

  async function send(command: SessionCommand) {
    if (!sessionId || !snapshot) return;
    await run(async () => {
      setSnapshot(await sendCommand(sessionId, snapshot.state_version, command));
      await refreshProject();
    }, t("notice.commandSent"));
  }

  if (profile === undefined) {
    return <main className="center-state">{t("auth.checking")}</main>;
  }

  if (profile === null) {
    return (
      <main className="center-state auth-card">
        <p className="eyebrow">{t("presenter.eyebrow")}</p>
        <h1 className="compact-heading">{t("auth.heading")}</h1>
        <p>{t("auth.description")}</p>
        <a className="primary-button" href="/api/auth/google/start?return_to=/presenter">
          {t("auth.google")}
        </a>
        <button
          className="guest-button"
          onClick={async () => {
            await postJson("/api/auth/guest", { locale });
            window.location.reload();
          }}
        >
          {t("auth.guest")}
        </button>
        <small className="guest-note">{t("auth.guestNote")}</small>
      </main>
    );
  }

  return (
    <main className="presenter-layout">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">{t("presenter.eyebrow")}</p>
          <h1 className="workspace-title">{t("presenter.heading")}</h1>
        </div>
        <div className="profile-chip">
          <span>{profile.account_type === "guest" ? t("auth.guestVault") : profile.display_name}</span>
          <button onClick={() => apiJson("/api/auth/logout", { method: "POST" }).then(() => location.reload())}>
            {t("auth.logout")}
          </button>
        </div>
      </header>

      {message && <div className="notice" role="status">{message}</div>}

      <section className="studio-grid" aria-busy={busy}>
        <aside className="panel library-panel">
          <div className="panel-heading">
            <div><span className="step">01</span><h2>{t("project.heading")}</h2></div>
          </div>
          <form className="inline-form" onSubmit={createProject}>
            <input name="title" required maxLength={200} placeholder={t("project.placeholder")} />
            <button className="icon-button" disabled={busy} aria-label={t("project.create")}>+</button>
          </form>
          <div className="item-list">
            {projects.map((item) => (
              <button
                className={item.id === projectId ? "list-item selected" : "list-item"}
                key={item.id}
                onClick={() => setProjectId(item.id)}
              >
                <span>{item.title}</span><small>{item.status}</small>
              </button>
            ))}
            {!projects.length && <p className="empty-copy">{t("project.empty")}</p>}
          </div>
        </aside>

        <section className="panel cue-panel">
          <div className="panel-heading">
            <div><span className="step">02</span><h2>{t("cue.heading")}</h2></div>
            {project && <span className="context-label">{project.title}</span>}
          </div>
          {project ? (
            <>
              <form className="form-stack cue-form" onSubmit={createCue}>
                <input name="name" required maxLength={200} placeholder={t("cue.namePlaceholder")} />
                <div className="form-row">
                  <input name="slide" inputMode="numeric" placeholder={t("cue.slidePlaceholder")} />
                  <select name="trigger_mode" defaultValue="presenter_confirm">
                    <option value="presenter_confirm">{t("cue.confirm")}</option>
                    <option value="immediate">{t("cue.immediate")}</option>
                  </select>
                  <button disabled={busy}>{t("cue.create")}</button>
                </div>
              </form>
              <div className="cue-list">
                {cues.map((item) => (
                  <button
                    key={item.id}
                    className={item.id === cueId ? "cue-card selected" : "cue-card"}
                    onClick={() => setCueId(item.id)}
                  >
                    <span className="cue-position">{String(item.position + 1).padStart(2, "0")}</span>
                    <span><strong>{item.name}</strong><small>{item.anchor_value ? t("cue.slide", { slide: item.anchor_value }) : t("cue.manual")}</small></span>
                    <span className="interaction-count">{item.interactions.length}</span>
                  </button>
                ))}
                {!cues.length && <p className="empty-copy">{t("cue.empty")}</p>}
              </div>
            </>
          ) : <p className="empty-copy roomy">{t("cue.selectProject")}</p>}
        </section>

        <section className="panel editor-panel">
          <div className="panel-heading">
            <div><span className="step">03</span><h2>{t("interaction.heading")}</h2></div>
            {cue && <span className="context-label">{cue.name}</span>}
          </div>
          {cue ? (
            <>
              <form className="form-stack interaction-form" onSubmit={createInteraction}>
                <select name="interaction_type" defaultValue="understanding">
                  <option value="understanding">{t("interaction.understanding")}</option>
                  <option value="single_choice">{t("interaction.choice")}</option>
                  <option value="word_cloud">{t("interaction.wordCloud")}</option>
                  <option value="qa">{t("interaction.qa")}</option>
                </select>
                <textarea name="prompt" required maxLength={500} placeholder={t("interaction.promptPlaceholder")} />
                <textarea name="options" placeholder={t("interaction.optionsPlaceholder")} />
                <button disabled={busy}>{t("interaction.create")}</button>
              </form>
              <div className="interaction-list">
                {cue.interactions.map((item) => (
                  <article className="interaction-card" key={item.id}>
                    <span className={`type-badge type-${item.interaction_type}`}>{typeName(t, item.interaction_type)}</span>
                    <h3>{item.prompt}</h3>
                    {!!item.options.length && <ol>{item.options.map((option) => <li key={option.id}>{option.label}</li>)}</ol>}
                  </article>
                ))}
                {!cue.interactions.length && <p className="empty-copy">{t("interaction.empty")}</p>}
              </div>
            </>
          ) : <p className="empty-copy roomy">{t("interaction.selectCue")}</p>}
        </section>
      </section>

      <LiveControl
        t={t}
        busy={busy}
        project={project}
        cues={cues}
        sessions={sessions}
        sessionId={sessionId}
        setSessionId={setSessionId}
        snapshot={snapshot}
        createSession={createSession}
        send={send}
      />
    </main>
  );
}

export async function sendCommand(sessionId: string, expectedVersion: number, command: SessionCommand) {
  const response = await postJson<{ snapshot: SessionSnapshot }>(
    `/api/sessions/${sessionId}/commands`,
    { idempotency_key: uuid(), expected_version: expectedVersion, command },
  );
  return response.snapshot;
}

function typeName(t: Translate, type: Interaction["interaction_type"]) {
  return t(`interaction.${type === "single_choice" ? "choice" : type === "word_cloud" ? "wordCloud" : type}`);
}

function LiveControl({
  t, busy, project, cues, sessions, sessionId, setSessionId, snapshot, createSession, send,
}: {
  t: Translate;
  busy: boolean;
  project: Project | null;
  cues: Cue[];
  sessions: LiveSession[];
  sessionId: string;
  setSessionId: (value: string) => void;
  snapshot: SessionSnapshot | null;
  createSession: () => void;
  send: (command: SessionCommand) => void;
}) {
  const statusActions = useMemo(() => {
    if (!snapshot) return [];
    switch (snapshot.status) {
      case "lobby": return [["start", "live.start"]] as const;
      case "live": return [["pause", "live.pause"], ["end", "live.end"]] as const;
      case "paused": return [["resume", "live.resume"], ["end", "live.end"]] as const;
      default: return [];
    }
  }, [snapshot]);
  const cueState = snapshot?.current_cue_run?.state;

  async function launchOverlay() {
    if (!snapshot) return;
    const target = window.open("about:blank", "_blank");
    try {
      const issued = await postJson<{ token: string }>(`/api/sessions/${snapshot.session_id}/tokens`, { role: "overlay" });
      const url = `/overlay/${snapshot.session_id}#token=${encodeURIComponent(issued.token)}`;
      if (target) target.location.href = url;
      else location.href = url;
    } catch {
      target?.close();
    }
  }

  return (
    <section className="live-dock">
      <div className="live-summary">
        <span className={snapshot && snapshot.status !== "ended" ? "live-light active" : "live-light"} />
        <div><small>{t("live.heading")}</small><strong>{snapshot ? t(`statusName.${snapshot.status}`) : t("live.none")}</strong></div>
        {snapshot?.join_code && <div className="join-code"><small>{t("live.joinCode")}</small><strong>{snapshot.join_code}</strong></div>}
      </div>
      <div className="live-actions">
        <select value={sessionId} onChange={(event) => setSessionId(event.target.value)} disabled={!sessions.length}>
          <option value="">{t("live.select")}</option>
          {sessions.map((item) => <option key={item.id} value={item.id}>{t(`statusName.${item.status}`)} · {item.join_code ?? item.id.slice(0, 6)}</option>)}
        </select>
        <button className="primary-button" disabled={!project || busy} onClick={createSession}>{t("live.new")}</button>
        {statusActions.map(([type, key]) => <button disabled={busy} key={type} onClick={() => send({ type })}>{t(key)}</button>)}
        {snapshot && snapshot.status !== "draft" && snapshot.status !== "ended" && (
          <select defaultValue="" onChange={(event) => { if (event.target.value) send({ type: "prepare_cue", cue_id: event.target.value }); event.target.value = ""; }}>
            <option value="">{t("live.prepare")}</option>
            {cues.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
          </select>
        )}
        {cueState === "ready" && <button onClick={() => send({ type: "open_cue" })}>{t("live.open")}</button>}
        {cueState === "open" && <button onClick={() => send({ type: "close_cue" })}>{t("live.close")}</button>}
        {cueState === "closed" && <button onClick={() => send({ type: "reveal_cue" })}>{t("live.reveal")}</button>}
        {snapshot && <a className="secondary-link" href={`/remote/${snapshot.session_id}`}>{t("live.remote")}</a>}
        {snapshot && <button className="secondary-link" onClick={launchOverlay}>{t("live.overlay")}</button>}
      </div>
    </section>
  );
}
