import { type FormEvent, useCallback, useEffect, useState } from "react";

import { ApiError, apiJson, postJson } from "./api";
import type { Translate } from "./i18n";
import { InteractionWorkspace, liveVisibilityFromForm } from "./InteractionWorkspace";
import { defaultVisibility, parseOptions, slideAnchorLabel, typeName } from "./lib/interactions";
import { sendCommand } from "./lib/liveSession";
import { LiveControl } from "./LiveControl";
import { PresenterLogin, downloadGuestVault } from "./PresenterAuth";
import { ProjectionThemePicker } from "./ProjectionThemePicker";
import {
  type TemplateKind,
  generatedCueName,
  templates,
} from "./presenterTemplates";
import { useProjectionTheme } from "./useProjectionTheme";
import type {
  Cue,
  Interaction,
  LiveSession,
  Profile,
  Project,
  SessionCommand,
  SessionSnapshot,
} from "./types";

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
  const [libraryCollapsed, setLibraryCollapsed] = useState(true);
  const [expandedCueId, setExpandedCueId] = useState("");
  const [expandedInteractionId, setExpandedInteractionId] = useState("");
  const [creatingInteraction, setCreatingInteraction] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const project = projects.find((item) => item.id === projectId) ?? null;
  const cue = cues.find((item) => item.id === cueId) ?? null;
  const selectedInteraction = cue?.interactions.find((item) => item.id === expandedInteractionId)
    ?? cue?.interactions.at(0)
    ?? null;

  const report = useCallback(
    (error: unknown) => {
      const code = error instanceof ApiError ? error.code : "network_error";
      setMessage(code === "project_has_history"
        ? t("project.deleteHistory")
        : t("error.generic", { code }));
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
    const selectableSessions = nextSessions.filter((item) => item.status !== "draft");
    setSessionId((current) => selectableSessions.some((item) => item.id === current)
      ? current
      : (selectableSessions.find((item) => item.status !== "ended")?.id
        ?? selectableSessions[0]?.id
        ?? ""));
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
    const template = templates(t)[kind];
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
      await apiJson(`/api/projects/${project.id}/archive`, { method: "POST" });
      await refreshProjects();
    }, t("notice.projectArchived"));
  }

  async function deleteProject() {
    if (!project) return;
    const confirmation = window.prompt(t("project.deleteConfirm", { title: project.title }));
    if (confirmation !== project.title) return;
    await run(async () => {
      await apiJson(`/api/projects/${project.id}`, { method: "DELETE" });
      await refreshProjects();
    }, t("notice.projectDeleted"));
  }

  async function createCue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const slide = normalizeSlideAnchor(String(data.get("slide") ?? ""), cues.length + 1);
    await run(async () => {
      const created = await postJson<Cue>(`/api/projects/${projectId}/cues`, {
        name: generatedCueName(t, cues.length + 1),
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
          name: generatedCueName(t, item.position + 1),
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
    const data = new FormData(event.currentTarget);
    const type = String(data.get("interaction_type"));
    const rawOptions = parseOptions(data.get("options"));
    await run(async () => {
      const created = await postJson<Interaction>(
        `/api/projects/${projectId}/cues/${cueId}/interactions`,
        {
          interaction_type: type,
          prompt: data.get("prompt"),
          description: null,
          settings: {
            schema_version: 1,
            purpose: data.get("interaction_purpose"),
            results: { audience_visibility: liveVisibilityFromForm(data.get("publish_live")) },
            response: { allow_change: true },
          },
          options:
            type === "single_choice"
              ? rawOptions.map((label) => ({ label, is_correct: null }))
              : [],
        },
      );
      await refreshProject();
      setExpandedInteractionId(created.id);
      setCreatingInteraction(false);
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
              results: { audience_visibility: liveVisibilityFromForm(data.get("publish_live")) },
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
    return <PresenterLogin t={t} locale={locale} busy={busy} message={message} setMessage={setMessage} />;
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
          {profile.account_type === "guest" && (
            <button disabled={busy} onClick={() => downloadGuestVault(profile.vault_id, setMessage, t)}>
              {t("auth.takeVault")}
            </button>
          )}
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
                <button onClick={() => setLibraryCollapsed(true)} aria-label={t("project.collapse")} title={t("project.collapse")}>‹</button>
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
            {project && <div className="project-actions project-instance-actions">
              <span className="project-action-context" title={project.title}>{project.title}</span>
              <button disabled={busy} onClick={duplicateProject}>{t("project.duplicate")}</button>
              <button disabled={busy || project.status === "archived"} onClick={archiveProject}>{t("project.archive")}</button>
              <button className="danger-action" disabled={busy} onClick={deleteProject}>{t("common.delete")}</button>
            </div>}
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
                      <span className="cue-position">{item.position + 1}</span>
                      <button
                        className={item.id === cueId ? "cue-card selected" : "cue-card"}
                        onClick={() => {
                          setCueId(item.id);
                          setExpandedInteractionId(item.interactions.at(0)?.id ?? "");
                          setCreatingInteraction(false);
                        }}
                      >
                        <CueThumbnail t={t} cue={item} />
                        <span className="cue-thumbnail-meta">
                          <strong>{slideAnchorLabel(t, item)}</strong>
                          <small>{item.interactions.length} · {item.trigger_mode === "immediate" ? t("cue.immediate") : t("cue.confirm")}</small>
                        </span>
                      </button>
                      <span className="cue-order-actions">
                        <button onClick={() => setExpandedCueId((current) => current === item.id ? "" : item.id)} aria-expanded={expandedCueId === item.id} aria-label={t("cue.anchor")}>•••</button>
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
              <nav className="interaction-tabs" aria-label={t("interaction.heading")}>
                {cue.interactions.map((item) => (
                  <button
                    className={!creatingInteraction && selectedInteraction?.id === item.id ? "interaction-tab active" : "interaction-tab"}
                    key={item.id}
                    onClick={() => {
                      setExpandedInteractionId(item.id);
                      setCreatingInteraction(false);
                    }}
                  >
                    <span className={`type-badge type-${item.interaction_type}`}>{typeName(t, item.interaction_type)}</span>
                    <span>{item.prompt}</span>
                  </button>
                ))}
                <button className={creatingInteraction ? "interaction-tab add active" : "interaction-tab add"} onClick={() => setCreatingInteraction(true)}>+ {t("interaction.addHeading")}</button>
              </nav>
              {creatingInteraction || !selectedInteraction ? (
                <InteractionWorkspace
                  key={`new-${cue.id}`}
                  t={t}
                  busy={busy}
                  cue={cue}
                  onSubmit={createInteraction}
                  onCancel={selectedInteraction ? () => setCreatingInteraction(false) : undefined}
                />
              ) : (
                <InteractionWorkspace
                  key={selectedInteraction.id}
                  t={t}
                  busy={busy}
                  cue={cue}
                  item={selectedInteraction}
                  onSubmit={(event) => updateInteraction(selectedInteraction, event)}
                  onDelete={() => deleteInteraction(selectedInteraction)}
                />
              )}
            </>
          ) : <p className="empty-copy roomy">{t("interaction.selectCue")}</p>}
        </section>
      </section>

      {cue && preview && <PreviewDialog t={t} cue={cue} interaction={selectedInteraction} mode={preview} close={() => setPreview(null)} />}

      <LiveControl
        t={t}
        busy={busy}
        project={project}
        cues={cues}
        sessions={sessions}
        sessionId={sessionId}
        setSessionId={setSessionId}
        snapshot={snapshot}
        refreshSnapshot={refreshSnapshot}
        createSession={createSession}
        send={send}
      />
    </main>
  );
}

function CueThumbnail({ t, cue }: { t: Translate; cue: Cue }) {
  const interaction = cue.interactions.at(0);
  const interactionType = interaction?.interaction_type ?? "empty";
  return (
    <span className="cue-thumbnail-canvas" aria-hidden="true">
      <span className="cue-thumbnail-kicker">
        {interaction ? typeName(t, interaction.interaction_type) : slideAnchorLabel(t, cue)}
      </span>
      <span className="cue-thumbnail-title">{interaction?.prompt ?? cue.name}</span>
      <span className={`cue-thumbnail-visual cue-thumbnail-${interactionType}`}>
        {interactionType === "single_choice" && <><i /><i /><i /><i /></>}
        {interactionType === "understanding" && <><i /><i /><i /></>}
        {interactionType === "word_cloud" && <><i>IDEA</i><i>LIVE</i><i>WORD</i></>}
        {interactionType === "qa" && <><i /><i /></>}
        {interactionType === "empty" && <i>+</i>}
      </span>
    </span>
  );
}

function PreviewDialog({ t, cue, interaction, mode, close }: {
  t: Translate;
  cue: Cue;
  interaction: Interaction | null;
  mode: "projection" | "mobile" | "presenter";
  close: () => void;
}) {
  const [theme, setTheme] = useProjectionTheme();
  return (
    <div className="preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className={`preview-dialog preview-${mode}`} role="dialog" aria-modal="true" aria-label={t(`preview.${mode}`)}>
        <header>
          <span>{t(`preview.${mode}`)}</span>
          {mode === "projection" && <ProjectionThemePicker t={t} theme={theme} setTheme={setTheme} />}
          <button onClick={close} aria-label={t("preview.close")}>×</button>
        </header>
        {mode === "projection" && (
          <div className="projection-preview" data-projection-theme={theme}>
            <small>{theme === "terminal" ? "live" : "LIVE"} · ABC234</small>
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

export function normalizeSlideAnchor(value: string, fallbackIndex: number) {
  const trimmed = value.trim();
  if (!trimmed) return String(fallbackIndex);
  const matches = [...trimmed.matchAll(/(?:[?#&]|^)slide=id\.([^&#]+)/g)];
  const matched = matches.at(-1)?.[1];
  if (matched) return decodeURIComponent(matched);
  return trimmed.replace(/^id\./, "");
}
