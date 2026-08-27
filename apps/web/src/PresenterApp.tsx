import { type FormEvent, useCallback, useEffect, useState } from "react";

import { ApiError, apiJson, postJson } from "./api";
import type { Translate } from "./i18n";
import { InteractionWorkspace, liveVisibilityFromForm } from "./InteractionWorkspace";
import { defaultVisibility, parseOptions, slideAnchorLabel, typeName } from "./lib/interactions";
import { sendCommand } from "./lib/liveSession";
import { LiveControl } from "./LiveControl";
import { PresenterLogin, downloadGuestVault } from "./PresenterAuth";
import {
  type TemplateKind,
  generatedCueName,
  templates,
} from "./presenterTemplates";
import type {
  Cue,
  Interaction,
  LiveSession,
  Profile,
  Project,
  SessionCommand,
  SessionSnapshot,
} from "./types";

type DeletedCueSnapshot = {
  projectId: string;
  cue: Cue;
};

export type CueShortcutAction = "delete" | "undo" | "move-up" | "move-down" | null;

export function reorderCueIds(
  source: ReadonlyArray<Pick<Cue, "id" | "position">>,
  sourceId: string,
  targetId: string,
) {
  const ordered = [...source].sort((left, right) => left.position - right.position);
  const sourceIndex = ordered.findIndex((item) => item.id === sourceId);
  const targetIndex = ordered.findIndex((item) => item.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return ordered.map((item) => item.id);
  }
  const [moved] = ordered.splice(sourceIndex, 1);
  if (!moved) return ordered.map((item) => item.id);
  ordered.splice(Math.min(targetIndex, ordered.length), 0, moved);
  return ordered.map((item) => item.id);
}

export function moveCueIds(
  source: ReadonlyArray<Pick<Cue, "id" | "position">>,
  sourceId: string,
  offset: -1 | 1,
) {
  const ordered = [...source].sort((left, right) => left.position - right.position);
  const sourceIndex = ordered.findIndex((item) => item.id === sourceId);
  const target = ordered[sourceIndex + offset];
  return target ? reorderCueIds(ordered, sourceId, target.id) : ordered.map((item) => item.id);
}

export function insertCueIdAtPosition(
  source: ReadonlyArray<Pick<Cue, "id" | "position">>,
  cueId: string,
  position: number,
) {
  const cueIds = [...source]
    .sort((left, right) => left.position - right.position)
    .map((item) => item.id)
    .filter((id) => id !== cueId);
  cueIds.splice(Math.min(Math.max(position, 0), cueIds.length), 0, cueId);
  return cueIds;
}

export function cueShortcutAction(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  editableTarget: boolean,
): CueShortcutAction {
  if (editableTarget || event.altKey) return null;
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "z") {
    return "undo";
  }
  if (event.metaKey || event.ctrlKey || event.shiftKey) return null;
  if (event.key === "Delete" || event.key === "Backspace") return "delete";
  if (event.key === "ArrowUp") return "move-up";
  if (event.key === "ArrowDown") return "move-down";
  return null;
}

export function PresenterApp({ t, locale }: { t: Translate; locale: string }) {
  const [profile, setProfile] = useState<Profile | null>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [cues, setCues] = useState<Cue[]>([]);
  const [cueId, setCueId] = useState("");
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [libraryCollapsed, setLibraryCollapsed] = useState(true);
  const [draggedCueId, setDraggedCueId] = useState("");
  const [dragOverCueId, setDragOverCueId] = useState("");
  const [expandedInteractionId, setExpandedInteractionId] = useState("");
  const [creatingInteraction, setCreatingInteraction] = useState(false);
  const [liveControlsOpen, setLiveControlsOpen] = useState(false);
  const [deletedCueStack, setDeletedCueStack] = useState<DeletedCueSnapshot[]>([]);
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

  useEffect(() => setDeletedCueStack([]), [projectId]);

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
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(""), 3200);
    return () => window.clearTimeout(timer);
  }, [message]);

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

  async function createCue() {
    if (!projectId) return;
    await run(async () => {
      const created = await postJson<Cue>(`/api/projects/${projectId}/cues`, {
        name: generatedCueName(t, cues.length + 1),
        anchor_type: "deck_slide",
        anchor_value: String(cues.length + 1),
        trigger_mode: "immediate",
        delay_seconds: 0,
      });
      await refreshProject();
      setCueId(created.id);
      setExpandedInteractionId("");
      setCreatingInteraction(true);
    }, t("notice.cueCreated"));
  }

  async function updateCue(item: Cue, value: string) {
    if (!projectId) return;
    const anchor = normalizeSlideAnchor(value, item.position + 1);
    await run(async () => {
      await apiJson<Cue>(`/api/projects/${projectId}/cues/${item.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: generatedCueName(t, item.position + 1),
          anchor_type: "deck_slide",
          anchor_value: anchor,
          trigger_mode: item.trigger_mode,
          delay_seconds: 0,
        }),
      });
      await refreshProject();
    }, t("notice.cueUpdated"));
  }

  async function deleteCue(item: Cue) {
    if (!projectId || !window.confirm(t("cue.deleteConfirm", { index: item.position + 1 }))) return;
    const ordered = [...cues].sort((left, right) => left.position - right.position);
    const deletedIndex = ordered.findIndex((candidate) => candidate.id === item.id);
    const replacement = ordered[deletedIndex + 1] ?? ordered[deletedIndex - 1] ?? null;
    const snapshot: DeletedCueSnapshot = { projectId, cue: item };
    await run(async () => {
      await apiJson(`/api/projects/${projectId}/cues/${item.id}`, { method: "DELETE" });
      setDeletedCueStack((current) => [...current, snapshot]);
      await refreshProject();
      setCueId(replacement?.id ?? "");
      setExpandedInteractionId(replacement?.interactions.at(0)?.id ?? "");
      setCreatingInteraction(false);
    }, t("notice.cueDeletedUndo"));
  }

  async function undoDeletedCue() {
    const snapshot = deletedCueStack.at(-1);
    if (!projectId || !snapshot || snapshot.projectId !== projectId) return;
    await run(async () => {
      const restored = await postJson<Cue>(`/api/projects/${projectId}/cues`, {
        name: snapshot.cue.name,
        anchor_type: snapshot.cue.anchor_type,
        anchor_value: snapshot.cue.anchor_value,
        trigger_mode: snapshot.cue.trigger_mode,
        delay_seconds: snapshot.cue.delay_seconds,
      });
      let firstInteractionId = "";
      const interactions = [...snapshot.cue.interactions]
        .sort((left, right) => left.position - right.position);
      for (const interaction of interactions) {
        const created = await postJson<Interaction>(
          `/api/projects/${projectId}/cues/${restored.id}/interactions`,
          interactionInput(interaction),
        );
        if (!firstInteractionId) firstInteractionId = created.id;
      }
      const latest = await apiJson<Cue[]>(`/api/projects/${projectId}/cues`);
      const cueIds = insertCueIdAtPosition(latest, restored.id, snapshot.cue.position);
      const next = await apiJson<Cue[]>(`/api/projects/${projectId}/cues/reorder`, {
        method: "PUT",
        body: JSON.stringify({ cue_ids: cueIds }),
      });
      setCues(next);
      setCueId(restored.id);
      setExpandedInteractionId(firstInteractionId);
      setCreatingInteraction(false);
      setDeletedCueStack((current) => current.slice(0, -1));
    }, t("notice.cueRestored"));
  }

  async function saveCueOrder(sourceId: string, cueIds: string[]) {
    if (!projectId) return;
    const currentCueIds = [...cues]
      .sort((left, right) => left.position - right.position)
      .map((item) => item.id);
    if (cueIds.every((id, index) => id === currentCueIds[index])) return;
    await run(async () => {
      const next = await apiJson<Cue[]>(`/api/projects/${projectId}/cues/reorder`, {
        method: "PUT",
        body: JSON.stringify({ cue_ids: cueIds }),
      });
      setCues(next);
      setCueId(sourceId);
    }, t("notice.cuesReordered"));
  }

  async function reorderCue(sourceId: string, targetId: string) {
    const cueIds = reorderCueIds(cues, sourceId, targetId);
    await saveCueOrder(sourceId, cueIds);
  }

  async function moveCue(item: Cue, offset: -1 | 1) {
    await saveCueOrder(item.id, moveCueIds(cues, item.id, offset));
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
              purpose: data.get("interaction_purpose") ?? item.settings.purpose,
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

  useEffect(() => {
    const handleCueShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || busy) return;
      const action = cueShortcutAction(event, isEditableShortcutTarget(event.target));
      if (!action) return;
      if (action === "undo") {
        if (!deletedCueStack.length) return;
        event.preventDefault();
        void undoDeletedCue();
        return;
      }
      if (!cue) return;
      event.preventDefault();
      if (action === "delete") void deleteCue(cue);
      if (action === "move-up") void moveCue(cue, -1);
      if (action === "move-down") void moveCue(cue, 1);
    };
    window.addEventListener("keydown", handleCueShortcut);
    return () => window.removeEventListener("keydown", handleCueShortcut);
  }, [busy, cue, cues, deletedCueStack, projectId]);

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
      <header className="workspace-toolbar">
        <a className="workspace-brand" href="/" aria-label={t("app.name")}><span>S</span></a>
        <strong className="workspace-project-title" title={project?.title}>{project?.title ?? t("project.heading")}</strong>
        <div className="workspace-toolbar-actions">
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
          <button
            className="start-presentation-button"
            type="button"
            aria-expanded={liveControlsOpen}
            onClick={() => setLiveControlsOpen(true)}
          >
            <span aria-hidden="true">▶</span>{t("live.startPresentation")}
          </button>
        </div>
      </header>

      {message && <div className="workspace-toast" role="status">{message}</div>}

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
              <button className="new-cue-button" type="button" disabled={busy} onClick={() => void createCue()}>
                <span aria-hidden="true">＋</span>{t("cue.newSlide")}
              </button>
              <div className="cue-list">
                {cues.map((item) => (
                  <article
                    className={`cue-accordion${draggedCueId === item.id ? " dragging" : ""}${dragOverCueId === item.id ? " drag-over" : ""}`}
                    key={item.id}
                    draggable={!busy}
                    onDragStart={(event) => {
                      setDraggedCueId(item.id);
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", item.id);
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setDragOverCueId(item.id);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const sourceId = event.dataTransfer.getData("text/plain") || draggedCueId;
                      setDraggedCueId("");
                      setDragOverCueId("");
                      if (sourceId) void reorderCue(sourceId, item.id);
                    }}
                    onDragEnd={() => {
                      setDraggedCueId("");
                      setDragOverCueId("");
                    }}
                  >
                    <div className="cue-row">
                      <span className="cue-position">{item.position + 1}</span>
                      <button
                        className={item.id === cueId ? "cue-card selected" : "cue-card"}
                        aria-current={item.id === cueId ? "true" : undefined}
                        title={t("cue.keyboardHelp")}
                        onClick={() => {
                          setCueId(item.id);
                          setExpandedInteractionId(item.interactions.at(0)?.id ?? "");
                          setCreatingInteraction(false);
                        }}
                      >
                        <CueThumbnail t={t} cue={item} />
                        <span className="cue-thumbnail-meta">
                          <strong>{item.name}</strong>
                          <small>{t("cue.interactionCount", { count: item.interactions.length })}</small>
                        </span>
                      </button>
                      <span className="cue-drag-handle" aria-hidden="true">⋮⋮</span>
                    </div>
                  </article>
                ))}
                {!cues.length && <p className="empty-copy">{t("cue.empty")}</p>}
              </div>
            </>
          ) : <p className="empty-copy roomy">{t("cue.selectProject")}</p>}
        </section>

        <section className="panel editor-panel">
          <div className="panel-heading">
            <div className="editor-heading-main">
              <span className="step">03</span><h2>{t("interaction.heading")}</h2>
              {cue && <CueBindingField key={cue.id} t={t} cue={cue} busy={busy} onSave={(value) => updateCue(cue, value)} />}
            </div>
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

      {liveControlsOpen && <LiveControl
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
        onClose={() => setLiveControlsOpen(false)}
      />}
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

function isEditableShortcutTarget(target: EventTarget | null) {
  return target instanceof Element
    && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function interactionInput(item: Interaction) {
  return {
    interaction_type: item.interaction_type,
    prompt: item.prompt,
    description: item.description,
    settings: item.settings,
    options: item.options
      .slice()
      .sort((left, right) => left.position - right.position)
      .map((option) => ({ label: option.label, is_correct: option.is_correct })),
  };
}

function CueBindingField({ t, cue, busy, onSave }: {
  t: Translate;
  cue: Cue;
  busy: boolean;
  onSave: (value: string) => Promise<void>;
}) {
  const currentValue = cue.anchor_value ?? String(cue.position + 1);
  const [value, setValue] = useState(currentValue);

  useEffect(() => setValue(currentValue), [cue.id, currentValue]);

  useEffect(() => {
    const trimmed = value.trim();
    if (!trimmed || busy || normalizeSlideAnchor(trimmed, cue.position + 1) === currentValue) return;
    const timer = window.setTimeout(() => void onSave(trimmed), 650);
    return () => window.clearTimeout(timer);
  }, [busy, cue.position, currentValue, onSave, value]);

  return (
    <label className="cue-binding-inline">
      <span>{t("cue.googleSlidesBinding")}</span>
      <input
        name="slide"
        value={value}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
        placeholder={t("cue.slidePlaceholder")}
      />
    </label>
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
