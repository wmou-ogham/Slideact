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
  const [preview, setPreview] = useState<"projection" | "mobile" | "presenter" | null>(null);
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

  async function createTemplate(kind: TemplateKind) {
    const template = templates(locale)[kind];
    await run(async () => {
      const createdProject = await postJson<Project>("/api/projects", {
        title: template.title,
        default_locale: locale,
      });
      for (const [cueIndex, templateCue] of template.cues.entries()) {
        const createdCue = await postJson<Cue>(`/api/projects/${createdProject.id}/cues`, {
          name: templateCue.name,
          anchor_type: templateCue.slide ? "deck_slide" : "manual",
          anchor_value: templateCue.slide ? String(templateCue.slide) : null,
          trigger_mode: templateCue.confirm ? "presenter_confirm" : "immediate",
          delay_seconds: 0,
        });
        for (const interaction of templateCue.interactions) {
          await postJson<Interaction>(
            `/api/projects/${createdProject.id}/cues/${createdCue.id}/interactions`,
            {
              interaction_type: interaction.type,
              prompt: interaction.prompt,
              description: interaction.description ?? null,
              settings: { schema_version: 1, template: kind, cue: cueIndex + 1 },
              options: interaction.options?.map((label) => ({ label, is_correct: null })) ?? [],
            },
          );
        }
      }
      await refreshProjects();
      setProjectId(createdProject.id);
    }, t("notice.templateCreated"));
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
          <div className="template-picker">
            <small>{t("template.startWith")}</small>
            <button disabled={busy} onClick={() => createTemplate("teaching")}><b>{t("template.teaching")}</b><span>{t("template.teachingCopy")}</span></button>
            <button disabled={busy} onClick={() => createTemplate("lightning")}><b>{t("template.lightning")}</b><span>{t("template.lightningCopy")}</span></button>
            <button disabled={busy} onClick={() => createTemplate("demo")}><b>{t("template.demo")}</b><span>{t("template.demoCopy")}</span></button>
          </div>
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
            {cue && <div className="preview-actions">
              <button onClick={() => setPreview("projection")}>{t("preview.projection")}</button>
              <button onClick={() => setPreview("mobile")}>{t("preview.mobile")}</button>
              <button onClick={() => setPreview("presenter")}>{t("preview.presenter")}</button>
            </div>}
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

      {cue && preview && <PreviewDialog t={t} cue={cue} mode={preview} close={() => setPreview(null)} />}

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

type TemplateKind = "teaching" | "lightning" | "demo";
type TemplateInteraction = {
  type: Interaction["interaction_type"];
  prompt: string;
  description?: string;
  options?: string[];
};
type PresentationTemplate = {
  title: string;
  cues: Array<{
    name: string;
    slide?: number;
    confirm?: boolean;
    interactions: TemplateInteraction[];
  }>;
};

function templates(locale: string): Record<TemplateKind, PresentationTemplate> {
  if (locale === "zh-TW") {
    return {
      teaching: {
        title: "教學互動範本",
        cues: [
          { name: "確認理解度", slide: 2, interactions: [{ type: "understanding", prompt: "目前為止都聽懂了嗎？", description: "即時確認是否需要多做說明" }] },
          { name: "課中小測驗", slide: 5, confirm: true, interactions: [{ type: "single_choice", prompt: "哪一個敘述最符合剛才的觀念？", options: ["選項 A", "選項 B", "選項 C", "選項 D"] }] },
          { name: "學生提問", confirm: true, interactions: [{ type: "qa", prompt: "有什麼地方希望老師再說明？" }] },
        ],
      },
      lightning: {
        title: "Lightning Talk 互動範本",
        cues: [
          { name: "快速暖場", slide: 2, interactions: [{ type: "understanding", prompt: "你曾經遇過這個問題嗎？" }] },
          { name: "一句話收斂", slide: 4, interactions: [{ type: "word_cloud", prompt: "用一個詞形容你最大的收穫" }] },
          { name: "限時問答", confirm: true, interactions: [{ type: "qa", prompt: "把最想問的問題送上來" }] },
        ],
      },
      demo: {
        title: "產品 Demo 互動範本",
        cues: [
          { name: "痛點優先序", slide: 2, interactions: [{ type: "single_choice", prompt: "目前哪個問題最影響你的團隊？", options: ["效率", "協作", "成本", "可見性"] }] },
          { name: "功能清晰度", slide: 4, interactions: [{ type: "understanding", prompt: "這個功能的價值是否清楚？" }] },
          { name: "使用情境", slide: 6, interactions: [{ type: "word_cloud", prompt: "你最想把它用在哪個情境？" }] },
        ],
      },
    };
  }
  return {
    teaching: {
      title: "Interactive teaching template",
      cues: [
        { name: "Check understanding", slide: 2, interactions: [{ type: "understanding", prompt: "Does everything make sense so far?", description: "See whether the room needs another explanation" }] },
        { name: "Knowledge check", slide: 5, confirm: true, interactions: [{ type: "single_choice", prompt: "Which statement best matches the concept?", options: ["Option A", "Option B", "Option C", "Option D"] }] },
        { name: "Student questions", confirm: true, interactions: [{ type: "qa", prompt: "What should the instructor explain again?" }] },
      ],
    },
    lightning: {
      title: "Lightning Talk template",
      cues: [
        { name: "Quick opener", slide: 2, interactions: [{ type: "understanding", prompt: "Have you experienced this problem?" }] },
        { name: "One-word takeaway", slide: 4, interactions: [{ type: "word_cloud", prompt: "Describe your biggest takeaway in one word" }] },
        { name: "Rapid Q&A", confirm: true, interactions: [{ type: "qa", prompt: "Send the one question you most want answered" }] },
      ],
    },
    demo: {
      title: "Product demo template",
      cues: [
        { name: "Pain-point priority", slide: 2, interactions: [{ type: "single_choice", prompt: "Which problem affects your team most?", options: ["Efficiency", "Collaboration", "Cost", "Visibility"] }] },
        { name: "Feature clarity", slide: 4, interactions: [{ type: "understanding", prompt: "Is the value of this feature clear?" }] },
        { name: "Use cases", slide: 6, interactions: [{ type: "word_cloud", prompt: "Where would you use this first?" }] },
      ],
    },
  };
}

function PreviewDialog({ t, cue, mode, close }: {
  t: Translate;
  cue: Cue;
  mode: "projection" | "mobile" | "presenter";
  close: () => void;
}) {
  const interaction = cue.interactions[0];
  return (
    <div className="preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className={`preview-dialog preview-${mode}`} role="dialog" aria-modal="true" aria-label={t(`preview.${mode}`)}>
        <header><span>{t(`preview.${mode}`)}</span><button onClick={close} aria-label={t("preview.close")}>×</button></header>
        {mode === "projection" && (
          <div className="projection-preview">
            <small>LIVE · ABC234</small>
            <h2>{interaction?.prompt ?? cue.name}</h2>
            <div className="preview-bars"><i /><i /><i /></div>
          </div>
        )}
        {mode === "mobile" && (
          <div className="mobile-preview">
            <small>ABC234 · {t("audience.people", { count: 42 })}</small>
            <h2>{interaction?.prompt ?? cue.name}</h2>
            {interaction?.interaction_type === "single_choice" ? interaction.options.map((option, index) => <button key={option.id}><span>{String.fromCharCode(65 + index)}</span>{option.label}</button>) : interaction?.interaction_type === "qa" || interaction?.interaction_type === "word_cloud" ? <><textarea disabled placeholder={interaction.interaction_type === "qa" ? t("qa.placeholder") : t("audience.textPlaceholder")} /><button>{interaction.interaction_type === "qa" ? t("qa.ask") : t("audience.send")}</button></> : <><button>{t("audience.yes")}</button><button>{t("audience.no")}</button></>}
          </div>
        )}
        {mode === "presenter" && (
          <div className="presenter-preview">
            <small>{t("remote.heading")}</small><h2>{cue.name}</h2>
            <button>{t("live.open")}</button>
            <ol>{cue.interactions.map((item) => <li key={item.id}>{typeName(t, item.interaction_type)} · {item.prompt}</li>)}</ol>
          </div>
        )}
      </section>
    </div>
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
