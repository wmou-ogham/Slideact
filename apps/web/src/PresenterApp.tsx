import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";

import { ApiError, apiJson, postJson, uuid } from "./api";
import type {
  Cue,
  Interaction,
  LiveView,
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
  const [presenterLive, setPresenterLive] = useState<LiveView | null>(null);
  const [preview, setPreview] = useState<"projection" | "mobile" | "presenter" | null>(null);
  const [libraryCollapsed, setLibraryCollapsed] = useState(false);
  const [expandedCueId, setExpandedCueId] = useState("");
  const [expandedInteractionId, setExpandedInteractionId] = useState("");
  const [interactionPurpose, setInteractionPurpose] = useState<InteractionPurpose>("understanding");
  const [interactionType, setInteractionType] = useState<Interaction["interaction_type"]>("understanding");
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

  useEffect(() => {
    if (!sessionId) {
      setPresenterLive(null);
      return;
    }
    let cancelled = false;
    let timer = 0;
    const start = async () => {
      const issued = await postJson<{ token: string }>(`/api/sessions/${sessionId}/tokens`, {
        role: "presenter",
      });
      const load = async () => {
        const next = await apiJson<LiveView>(`/api/live/sessions/${sessionId}`, {
          headers: { authorization: `Bearer ${issued.token}` },
        });
        if (!cancelled) setPresenterLive(next);
      };
      await load();
      if (!cancelled) timer = window.setInterval(() => load().catch(() => undefined), 2500);
    };
    setPresenterLive(null);
    start().catch(() => undefined);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionId]);

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
              settings: {
                schema_version: 1,
                template: kind,
                cue: cueIndex + 1,
                results: { audience_visibility: defaultVisibility(interaction.type) },
              },
              options: interaction.options?.map((label) => ({ label, is_correct: null })) ?? [],
            },
          );
        }
      }
      await refreshProjects();
      setProjectId(createdProject.id);
    }, t("notice.templateCreated"));
  }

  async function duplicateProject() {
    if (!project) return;
    await run(async () => {
      const duplicate = await postJson<Project>(`/api/projects/${project.id}/duplicate`, {});
      await refreshProjects();
      setProjectId(duplicate.id);
    }, t("notice.projectDuplicated"));
  }

  async function archiveProject() {
    if (!project || !window.confirm(t("project.archiveConfirm"))) return;
    await run(async () => {
      await apiJson(`/api/projects/${project.id}`, { method: "DELETE" });
      setProjectId("");
      await refreshProjects();
    }, t("notice.projectArchived"));
  }

  async function createCue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const slide = normalizeSlideAnchor(String(data.get("slide") ?? ""), cues.length + 1);
    await run(async () => {
      const created = await postJson<Cue>(`/api/projects/${projectId}/cues`, {
        name: generatedCueName(locale, cues.length + 1),
        anchor_type: "deck_slide",
        anchor_value: slide,
        trigger_mode: data.get("trigger_mode"),
        delay_seconds: 0,
      });
      await refreshProject();
      setCueId(created.id);
      setExpandedCueId(created.id);
      form.reset();
    }, t("notice.cueCreated"));
  }

  async function updateCue(item: Cue, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId) return;
    const data = new FormData(event.currentTarget);
    const anchor = normalizeSlideAnchor(String(data.get("slide") ?? ""), item.position + 1);
    await run(async () => {
      await apiJson<Cue>(`/api/projects/${projectId}/cues/${item.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: generatedCueName(locale, item.position + 1),
          anchor_type: "deck_slide",
          anchor_value: anchor,
          trigger_mode: data.get("trigger_mode"),
          delay_seconds: 0,
        }),
      });
      await refreshProject();
    }, t("notice.cueUpdated"));
  }

  async function deleteCue(item: Cue) {
    if (!projectId || !window.confirm(t("cue.deleteConfirm", { index: item.position + 1 }))) return;
    await run(async () => {
      await apiJson(`/api/projects/${projectId}/cues/${item.id}`, { method: "DELETE" });
      if (cueId === item.id) setCueId("");
      if (expandedCueId === item.id) setExpandedCueId("");
      await refreshProject();
    }, t("notice.cueDeleted"));
  }

  async function reorderCue(targetId: string, direction: -1 | 1) {
    if (!projectId) return;
    const ordered = [...cues].sort((left, right) => left.position - right.position);
    const index = ordered.findIndex((item) => item.id === targetId);
    const swapIndex = index + direction;
    if (index < 0 || swapIndex < 0 || swapIndex >= ordered.length) return;
    [ordered[index], ordered[swapIndex]] = [ordered[swapIndex], ordered[index]];
    await run(async () => {
      const next = await apiJson<Cue[]>(`/api/projects/${projectId}/cues/reorder`, {
        method: "PUT",
        body: JSON.stringify({ cue_ids: ordered.map((item) => item.id) }),
      });
      setCues(next);
      setCueId(targetId);
    }, t("notice.cuesReordered"));
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
          settings: {
            schema_version: 1,
            purpose: data.get("interaction_purpose"),
            results: { audience_visibility: data.get("audience_visibility") },
            response: { allow_change: true },
          },
          options:
            type === "single_choice"
              ? rawOptions.map((label) => ({ label, is_correct: null }))
              : [],
        },
      );
      await refreshProject();
      form.reset();
      setInteractionPurpose("understanding");
      setInteractionType("understanding");
    }, t("notice.interactionCreated"));
  }

  async function updateInteraction(item: Interaction, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId || !cueId) return;
    const data = new FormData(event.currentTarget);
    const type = String(data.get("interaction_type"));
    const rawOptions = parseOptions(data.get("options"));
    await run(async () => {
      await apiJson<Interaction>(
        `/api/projects/${projectId}/cues/${cueId}/interactions/${item.id}`,
        {
          method: "PUT",
          body: JSON.stringify({
            interaction_type: type,
            prompt: data.get("prompt"),
            description: item.description,
            settings: {
              ...item.settings,
              schema_version: 1,
              purpose: data.get("interaction_purpose"),
              results: { audience_visibility: data.get("audience_visibility") },
              response: { allow_change: true },
            },
            options: type === "single_choice"
              ? rawOptions.map((label) => ({ label, is_correct: null }))
              : [],
          }),
        },
      );
      await refreshProject();
    }, t("notice.interactionUpdated"));
  }

  async function deleteInteraction(item: Interaction) {
    if (!projectId || !cueId || !window.confirm(t("interaction.deleteConfirm"))) return;
    await run(async () => {
      await apiJson(
        `/api/projects/${projectId}/cues/${cueId}/interactions/${item.id}`,
        { method: "DELETE" },
      );
      if (expandedInteractionId === item.id) setExpandedInteractionId("");
      await refreshProject();
    }, t("notice.interactionDeleted"));
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
          <button className="delete-account" onClick={async () => {
            if (!window.confirm(t("auth.deleteConfirm"))) return;
            await apiJson("/api/auth/account", { method: "DELETE", body: JSON.stringify({ confirmation: "DELETE" }) });
            location.assign("/");
          }}>{t("auth.delete")}</button>
        </div>
      </header>

      {message && <div className="notice" role="status">{message}</div>}

      <section className={libraryCollapsed ? "studio-grid library-collapsed" : "studio-grid"} aria-busy={busy}>
        <aside className={libraryCollapsed ? "panel library-panel collapsed" : "panel library-panel"}>
          {libraryCollapsed ? (
            <button
              className="library-expand"
              onClick={() => setLibraryCollapsed(false)}
              aria-label={t("project.expand")}
              title={project?.title ?? t("project.heading")}
            >
              <span>›</span><b>{project?.title.slice(0, 1) ?? "P"}</b>
            </button>
          ) : <>
            <div className="panel-heading">
              <div><span className="step">01</span><h2>{t("project.heading")}</h2></div>
              <div className="project-actions">
                {project && <>
                  <button disabled={busy} onClick={duplicateProject}>{t("project.duplicate")}</button>
                  <button disabled={busy} onClick={archiveProject}>{t("project.archive")}</button>
                  <button onClick={() => setLibraryCollapsed(true)} aria-label={t("project.collapse")} title={t("project.collapse")}>‹</button>
                </>}
              </div>
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
          </>}
        </aside>

        <section className="panel cue-panel">
          <div className="panel-heading">
            <div><span className="step">02</span><h2>{t("cue.heading")}</h2></div>
            {project && <span className="context-label">{project.title}</span>}
          </div>
          {project ? (
            <>
              <div className="cue-list">
                {cues.map((item) => (
                  <article className={expandedCueId === item.id ? "cue-accordion expanded" : "cue-accordion"} key={item.id}>
                    <div className="cue-row">
                      <button
                        className={item.id === cueId ? "cue-card selected" : "cue-card"}
                        aria-expanded={expandedCueId === item.id}
                        onClick={() => {
                          setCueId(item.id);
                          setExpandedCueId((current) => current === item.id ? "" : item.id);
                        }}
                      >
                        <span className="cue-position">{String(item.position + 1).padStart(2, "0")}</span>
                        <span><strong>{slideAnchorLabel(t, item)}</strong><small>{item.trigger_mode === "immediate" ? t("cue.immediate") : t("cue.confirm")}</small></span>
                        <span className="interaction-count">{item.interactions.length}</span>
                      </button>
                      <span className="cue-order-actions">
                        <button disabled={busy || item.position === 0} onClick={() => reorderCue(item.id, -1)} aria-label={t("cue.moveUp", { name: slideAnchorLabel(t, item) })}>↑</button>
                        <button disabled={busy || item.position === cues.length - 1} onClick={() => reorderCue(item.id, 1)} aria-label={t("cue.moveDown", { name: slideAnchorLabel(t, item) })}>↓</button>
                      </span>
                    </div>
                    {expandedCueId === item.id && (
                      <form className="accordion-form" onSubmit={(event) => updateCue(item, event)}>
                        <label><span>{t("cue.anchor")}</span><input name="slide" defaultValue={item.anchor_value ?? String(item.position + 1)} required placeholder={t("cue.slidePlaceholder")} /></label>
                        <label><span>{t("cue.behavior")}</span><select name="trigger_mode" defaultValue={item.trigger_mode === "presenter_confirm" ? "presenter_confirm" : "immediate"}><option value="immediate">{t("cue.immediate")}</option><option value="presenter_confirm">{t("cue.confirm")}</option></select></label>
                        <div className="editor-actions"><button disabled={busy}>{t("common.save")}</button><button className="danger-button" disabled={busy} type="button" onClick={() => deleteCue(item)}>{t("common.delete")}</button></div>
                      </form>
                    )}
                  </article>
                ))}
                {!cues.length && <p className="empty-copy">{t("cue.empty")}</p>}
              </div>
              <form className="form-stack cue-form add-form" onSubmit={createCue}>
                <div className="add-form-heading"><strong>{t("cue.addHeading")}</strong><small>{t("cue.anchorHelp")}</small></div>
                <div className="form-row">
                  <input name="slide" placeholder={t("cue.slidePlaceholder")} />
                  <select name="trigger_mode" defaultValue="immediate">
                    <option value="immediate">{t("cue.immediate")}</option>
                    <option value="presenter_confirm">{t("cue.confirm")}</option>
                  </select>
                  <button disabled={busy}>{t("cue.create")}</button>
                </div>
              </form>
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
              <div className="interaction-list">
                {cue.interactions.map((item) => (
                  <article className={expandedInteractionId === item.id ? "interaction-card expanded" : "interaction-card"} key={item.id}>
                    <button className="interaction-summary" aria-expanded={expandedInteractionId === item.id} onClick={() => setExpandedInteractionId((current) => current === item.id ? "" : item.id)}>
                      <span className={`type-badge type-${item.interaction_type}`}>{typeName(t, item.interaction_type)}</span>
                      <h3>{item.prompt}</h3><span className="expand-glyph">⌄</span>
                    </button>
                    {expandedInteractionId === item.id && <InteractionEditForm t={t} busy={busy} item={item} onSave={(event) => updateInteraction(item, event)} onDelete={() => deleteInteraction(item)} />}
                  </article>
                ))}
                {!cue.interactions.length && <p className="empty-copy">{t("interaction.empty")}</p>}
              </div>
              <form className="form-stack interaction-form add-form" onSubmit={createInteraction}>
                <div className="add-form-heading"><strong>{t("interaction.addHeading")}</strong><small>{t("interaction.addHelp")}</small></div>
                <label className="field-label">
                  <span>{t("interaction.purpose")}</span>
                  <select name="interaction_purpose" value={interactionPurpose} onChange={(event) => {
                    const purpose = event.target.value as InteractionPurpose;
                    setInteractionPurpose(purpose);
                    setInteractionType(purposeRecommendation(locale, purpose).type);
                  }}>
                    {interactionPurposes.map((purpose) => <option value={purpose} key={purpose}>{t(`purpose.${purpose}`)}</option>)}
                  </select>
                </label>
                <small className="recommendation-copy">{t("interaction.recommendation", { type: typeName(t, purposeRecommendation(locale, interactionPurpose).type) })}</small>
                <select name="interaction_type" value={interactionType} onChange={(event) => setInteractionType(event.target.value as Interaction["interaction_type"])}>
                  <option value="understanding">{t("interaction.understanding")}</option>
                  <option value="single_choice">{t("interaction.choice")}</option>
                  <option value="word_cloud">{t("interaction.wordCloud")}</option>
                  <option value="qa">{t("interaction.qa")}</option>
                </select>
                <textarea key={interactionPurpose} name="prompt" required maxLength={500} defaultValue={purposeRecommendation(locale, interactionPurpose).prompt} placeholder={t("interaction.promptPlaceholder")} />
                {interactionType === "single_choice" && <textarea name="options" required placeholder={t("interaction.optionsPlaceholder")} />}
                <label className="field-label">
                  <span>{t("interaction.visibility")}</span>
                  <select key={interactionType} name="audience_visibility" defaultValue={defaultVisibility(interactionType)}>
                    <option value="after_reveal">{t("interaction.visibilityAfterReveal")}</option>
                    <option value="live">{t("interaction.visibilityLive")}</option>
                  </select>
                </label>
                <button disabled={busy}>{t("interaction.create")}</button>
              </form>
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
        live={presenterLive}
        createSession={createSession}
        send={send}
      />
    </main>
  );
}

type TemplateKind = "teaching" | "lightning" | "demo";
type InteractionPurpose = "understanding" | "knowledge" | "opinions" | "questions" | "next" | "mood" | "priorities" | "ideas";
const interactionPurposes: InteractionPurpose[] = ["understanding", "knowledge", "opinions", "questions", "next", "mood", "priorities", "ideas"];

function purposeRecommendation(locale: string, purpose: InteractionPurpose): { type: Interaction["interaction_type"]; prompt: string } {
  const zh = locale === "zh-TW";
  const recommendations: Record<InteractionPurpose, { type: Interaction["interaction_type"]; prompt: string }> = {
    understanding: { type: "understanding", prompt: zh ? "目前為止都理解了嗎？" : "How clear is this so far?" },
    knowledge: { type: "single_choice", prompt: zh ? "哪一個選項最符合剛才的重點？" : "Which option best matches the key idea?" },
    opinions: { type: "single_choice", prompt: zh ? "你最認同哪一個方向？" : "Which direction do you agree with most?" },
    questions: { type: "qa", prompt: zh ? "你希望我進一步說明什麼？" : "What would you like me to clarify?" },
    next: { type: "single_choice", prompt: zh ? "接下來最想先看哪個內容？" : "What should we explore next?" },
    mood: { type: "word_cloud", prompt: zh ? "用一個詞描述你現在的感受。" : "Describe the room in one word." },
    priorities: { type: "single_choice", prompt: zh ? "哪一項最值得優先處理？" : "What should be the top priority?" },
    ideas: { type: "word_cloud", prompt: zh ? "用一個短詞分享你的想法。" : "Share one short idea." },
  };
  return recommendations[purpose];
}

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

export async function sendCommand(sessionId: string, expectedVersion: number, command: SessionCommand, token?: string) {
  const response = await apiJson<{ snapshot: SessionSnapshot }>(
    `/api/sessions/${sessionId}/commands`,
    {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      body: JSON.stringify({ idempotency_key: uuid(), expected_version: expectedVersion, command }),
    },
  );
  return response.snapshot;
}

function typeName(t: Translate, type: Interaction["interaction_type"]) {
  return t(`interaction.${type === "single_choice" ? "choice" : type === "word_cloud" ? "wordCloud" : type}`);
}

function defaultVisibility(type: Interaction["interaction_type"]) {
  return type === "single_choice" ? "after_reveal" : "live";
}

function InteractionEditForm({ t, busy, item, onSave, onDelete }: {
  t: Translate;
  busy: boolean;
  item: Interaction;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
  onDelete: () => void;
}) {
  const [type, setType] = useState(item.interaction_type);
  const [purpose, setPurpose] = useState(() => interactionPurposeFrom(item));
  const [prompt, setPrompt] = useState(item.prompt);
  const [options, setOptions] = useState(() => item.options.map((option) => option.label).join("\n"));
  const [visibility, setVisibility] = useState(() => visibilityFrom(item));

  useEffect(() => {
    setType(item.interaction_type);
    setPurpose(interactionPurposeFrom(item));
    setPrompt(item.prompt);
    setOptions(item.options.map((option) => option.label).join("\n"));
    setVisibility(visibilityFrom(item));
  }, [item]);

  return (
    <form className="accordion-form interaction-edit-form" onSubmit={onSave}>
      <label><span>{t("interaction.purpose")}</span><select name="interaction_purpose" value={purpose} onChange={(event) => setPurpose(event.target.value as InteractionPurpose)}>{interactionPurposes.map((value) => <option value={value} key={value}>{t(`purpose.${value}`)}</option>)}</select></label>
      <label><span>{t("interaction.heading")}</span><select name="interaction_type" value={type} onChange={(event) => setType(event.target.value as Interaction["interaction_type"])}><option value="understanding">{t("interaction.understanding")}</option><option value="single_choice">{t("interaction.choice")}</option><option value="word_cloud">{t("interaction.wordCloud")}</option><option value="qa">{t("interaction.qa")}</option></select></label>
      <label className="editor-wide"><span>{t("interaction.promptLabel")}</span><textarea name="prompt" required maxLength={500} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
      {type === "single_choice" && <label className="editor-wide"><span>{t("interaction.optionsLabel")}</span><textarea name="options" required value={options} onChange={(event) => setOptions(event.target.value)} placeholder={t("interaction.optionsPlaceholder")} /></label>}
      <label><span>{t("interaction.visibility")}</span><select name="audience_visibility" value={visibility} onChange={(event) => setVisibility(event.target.value as ResultVisibility)}><option value="after_reveal">{t("interaction.visibilityAfterReveal")}</option><option value="live">{t("interaction.visibilityLive")}</option></select></label>
      <div className="editor-actions"><button disabled={busy}>{t("common.save")}</button><button className="danger-button" disabled={busy} type="button" onClick={onDelete}>{t("common.delete")}</button></div>
    </form>
  );
}

type ResultVisibility = "after_reveal" | "live";

function interactionPurposeFrom(item: Interaction): InteractionPurpose {
  const purpose = item.settings.purpose;
  return typeof purpose === "string" && interactionPurposes.includes(purpose as InteractionPurpose)
    ? purpose as InteractionPurpose
    : "understanding";
}

function visibilityFrom(item: Interaction): ResultVisibility {
  const results = item.settings.results;
  const visibility = typeof results === "object" && results !== null
    ? (results as Record<string, unknown>).audience_visibility
    : null;
  return visibility === "live" ? "live" : "after_reveal";
}

function parseOptions(value: FormDataEntryValue | null) {
  return String(value ?? "")
    .split("\n")
    .map((option) => option.trim())
    .filter(Boolean);
}

export function normalizeSlideAnchor(value: string, fallbackIndex: number) {
  const trimmed = value.trim();
  if (!trimmed) return String(fallbackIndex);
  const matches = [...trimmed.matchAll(/(?:[?#&]|^)slide=id\.([^&#]+)/g)];
  const matched = matches.at(-1)?.[1];
  if (matched) return decodeURIComponent(matched);
  return trimmed.replace(/^id\./, "");
}

function generatedCueName(locale: string, index: number) {
  return locale === "zh-TW" ? `投影片 ${index}` : `Slide ${index}`;
}

function slideAnchorLabel(t: Translate, cue: Cue) {
  const anchor = cue.anchor_value ?? String(cue.position + 1);
  return /^\d+$/.test(anchor)
    ? t("cue.slide", { slide: anchor })
    : t("cue.slideId", { id: anchor });
}

function LiveControl({
  t, busy, project, cues, sessions, sessionId, setSessionId, snapshot, live, createSession, send,
}: {
  t: Translate;
  busy: boolean;
  project: Project | null;
  cues: Cue[];
  sessions: LiveSession[];
  sessionId: string;
  setSessionId: (value: string) => void;
  snapshot: SessionSnapshot | null;
  live: LiveView | null;
  createSession: () => void;
  send: (command: SessionCommand) => void;
}) {
  const [pairingCode, setPairingCode] = useState("");
  const [remoteLink, setRemoteLink] = useState("");
  const [extensionConnected, setExtensionConnected] = useState<boolean | null>(null);
  useEffect(() => {
    if (!snapshot) return;
    const load = () => apiJson<{ paired: boolean; connected: boolean }>(`/api/sessions/${snapshot.session_id}/extension-status`).then((value) => setExtensionConnected(value.paired ? value.connected : null)).catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 15_000);
    return () => window.clearInterval(timer);
  }, [snapshot?.session_id]);
  const statusActions = useMemo(() => {
    if (!snapshot) return [];
    switch (snapshot.status) {
      case "lobby": return [["start", "live.start"]] as const;
      case "live": return [["end", "live.end"]] as const;
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

  async function launchProjection() {
    if (!snapshot) return;
    const target = window.open("about:blank", "_blank");
    try {
      const issued = await postJson<{ token: string }>(`/api/sessions/${snapshot.session_id}/tokens`, { role: "overlay" });
      const url = `/projection/${snapshot.session_id}#token=${encodeURIComponent(issued.token)}`;
      if (target) target.location.href = url;
      else location.href = url;
    } catch {
      target?.close();
    }
  }

  async function createExtensionPairing() {
    if (!snapshot) return;
    const response = await postJson<{ code: string }>(
      `/api/sessions/${snapshot.session_id}/extension-pairing`,
      {},
    );
    setPairingCode(response.code);
  }

  async function createRemoteAccess() {
    if (!snapshot) return;
    const issued = await postJson<{ token: string; expires_in_seconds: number }>(
      `/api/sessions/${snapshot.session_id}/tokens`,
      { role: "controller" },
    );
    setRemoteLink(`${window.location.origin}/remote/${snapshot.session_id}#token=${encodeURIComponent(issued.token)}`);
  }

  async function useManualSync() {
    if (!snapshot) return;
    await apiJson(`/api/sessions/${snapshot.session_id}/sync-mode`, {
      method: "PUT",
      body: JSON.stringify({ mode: "manual" }),
    });
    window.location.reload();
  }

  return (
    <section className="live-dock">
      {snapshot?.current_cue_run && live && <PresenterInsights t={t} live={live} />}
      <div className="live-summary">
        <span className={snapshot && snapshot.status !== "ended" ? "live-light active" : "live-light"} />
        <div><small>{t("live.heading")}</small><strong>{snapshot ? t(`statusName.${snapshot.status}`) : t("live.none")}</strong>{snapshot && <em className={extensionConnected === true ? "sync-connected" : ""}>{extensionConnected === true ? t("sync.connected") : extensionConnected === false ? t("sync.disconnected") : snapshot.sync_mode === "manual" ? t("sync.manualStatus") : t("sync.notPaired")}</em>}</div>
        {snapshot?.join_code && <div className="join-code"><small>{t("live.joinCode")}</small><strong>{snapshot.join_code}</strong><JoinQr code={snapshot.join_code} label={t("live.joinQr")} /></div>}
      </div>
      <div className="live-actions">
        <select value={sessionId} onChange={(event) => setSessionId(event.target.value)} disabled={!sessions.length}>
          <option value="">{t("live.select")}</option>
          {sessions.map((item) => <option key={item.id} value={item.id}>{t(`statusName.${item.status}`)} · {item.join_code ?? item.id.slice(0, 6)}</option>)}
        </select>
        <button className="primary-button" disabled={!project || busy} onClick={createSession}>{t("live.new")}</button>
        {statusActions.map(([type, key]) => <button disabled={busy} key={type} onClick={() => send({ type })}>{t(key)}</button>)}
        {snapshot && snapshot.status !== "draft" && snapshot.status !== "ended" && (
          <select
            aria-label={t("live.selectCue")}
            value={snapshot.current_cue_run?.cue_id ?? ""}
            disabled={busy}
            onChange={(event) => { if (event.target.value) send({ type: "prepare_cue", cue_id: event.target.value }); }}
          >
            <option value="">{t("live.prepare")}</option>
            {cues.map((item) => <option value={item.id} key={item.id}>{slideAnchorLabel(t, item)}</option>)}
          </select>
        )}
        {cueState === "ready" && <button onClick={() => send({ type: "open_cue" })}>{t("live.open")}</button>}
        {(cueState === "open" || cueState === "closed") && <button onClick={() => send({ type: "reveal_cue" })}>{t("live.reveal")}</button>}
        {cueState === "revealed" && <button onClick={() => send({ type: "reopen_cue" })}>{t("live.reopen")}</button>}
        {snapshot && <button className="secondary-link" onClick={createRemoteAccess}>{t("live.remote")}</button>}
        {snapshot && <button className="secondary-link" onClick={launchProjection}>{t("live.projection")}</button>}
        {snapshot && <button className="secondary-link" onClick={launchOverlay}>{t("live.overlay")}</button>}
        {snapshot && <a className="secondary-link" href={`/api/sessions/${snapshot.session_id}/export.csv`} download>{t("live.export")}</a>}
        {snapshot && <button className="secondary-link" onClick={createExtensionPairing}>{t("sync.pair")}</button>}
        {snapshot?.sync_mode !== "manual" && <button className="secondary-link" onClick={useManualSync}>{t("sync.manual")}</button>}
      </div>
      {pairingCode && <div className="pairing-code" role="status"><small>{t("sync.pairingCode")}</small><strong>{pairingCode}</strong><span>{t("sync.pairingCopy")}</span></div>}
      {remoteLink && <RemoteAccessPanel t={t} url={remoteLink} close={() => setRemoteLink("")} />}
    </section>
  );
}

function PresenterInsights({ t, live }: { t: Translate; live: LiveView }) {
  const aggregate = live.aggregates.find((item) => item.aggregate.interaction_type === "understanding")?.aggregate
    ?? live.aggregates[0]?.aggregate;
  const total = aggregate?.total_responses ?? 0;
  const responseRate = live.audience_count ? Math.round(total * 100 / live.audience_count) : 0;
  const needsAttention = aggregate?.interaction_type === "understanding"
    && total > 0
    && (((aggregate.yellow ?? 0) + (aggregate.red ?? 0)) * 100 / total >= 25);
  return (
    <aside className={needsAttention ? "presenter-insights needs-attention" : "presenter-insights"} aria-live="polite">
      <div><small>{t("live.audience")}</small><strong>{live.audience_count}</strong></div>
      <div><small>{t("live.responses")}</small><strong>{total}</strong></div>
      <div><small>{t("live.responseRate")}</small><strong>{responseRate}%</strong></div>
      {aggregate?.interaction_type === "understanding" && <div className="signal-counts">
        <span className="signal-green">{t("audience.green")} <b>{aggregate.green ?? 0}</b></span>
        <span className="signal-yellow">{t("audience.yellow")} <b>{aggregate.yellow ?? 0}</b></span>
        <span className="signal-red">{t("audience.red")} <b>{aggregate.red ?? 0}</b></span>
      </div>}
      {needsAttention && <p role="alert">{t("live.attention")}</p>}
    </aside>
  );
}

function JoinQr({ code, label }: { code: string; label: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(`${window.location.origin}/join/${encodeURIComponent(code)}`);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [code]);
  return <details className="join-qr"><summary>{label}</summary><div aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} /></details>;
}

function RemoteAccessPanel({ t, url, close }: { t: Translate; url: string; close: () => void }) {
  const svg = useMemo(() => qrSvg(url), [url]);
  return (
    <aside className="remote-access-panel" role="dialog" aria-label={t("remote.qrHeading")}>
      <header><strong>{t("remote.qrHeading")}</strong><button onClick={close} aria-label={t("preview.close")}>×</button></header>
      <div className="remote-access-content">
        <div className="remote-access-qr" dangerouslySetInnerHTML={{ __html: svg }} />
        <div><p>{t("remote.qrCopy")}</p><input readOnly value={url} onFocus={(event) => event.currentTarget.select()} aria-label={t("remote.link")} /><a href={url} target="_blank" rel="noreferrer">{t("remote.open")}</a><small>{t("remote.expires")}</small></div>
      </div>
    </aside>
  );
}

function qrSvg(value: string) {
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}
