import { useEffect, useMemo, useState } from "react";

import { apiJson, postJson } from "./api";
import type { Translate } from "./i18n";
import { cueNavigationLabel } from "./lib/interactions";
import { qrSvgTag } from "./lib/qr";
import { ProjectionThemePicker } from "./ProjectionThemePicker";
import { projectionThemeSearch } from "./projectionTheme";
import { useProjectionTheme } from "./useProjectionTheme";
import type { Cue, LiveSession, Project, SessionCommand, SessionSnapshot } from "./types";

export function LiveControl({
  t, busy, project, cues, sessions, sessionId, setSessionId, snapshot, refreshSnapshot, createSession, send, onClose,
}: {
  t: Translate;
  busy: boolean;
  project: Project | null;
  cues: Cue[];
  sessions: LiveSession[];
  sessionId: string;
  setSessionId: (value: string) => void;
  snapshot: SessionSnapshot | null;
  refreshSnapshot: () => Promise<void>;
  createSession: () => void;
  send: (command: SessionCommand) => void;
  onClose: () => void;
}) {
  const [pairingCode, setPairingCode] = useState("");
  const [pairingOpen, setPairingOpen] = useState(false);
  const [remoteLink, setRemoteLink] = useState("");
  const [extensionConnected, setExtensionConnected] = useState<boolean | null>(null);
  const [theme, setTheme] = useProjectionTheme();
  useEffect(() => {
    if (!snapshot || snapshot.status === "ended" || snapshot.status === "draft") {
      setExtensionConnected(null);
      return;
    }
    const load = () => apiJson<{ paired: boolean; connected: boolean }>(`/api/sessions/${snapshot.session_id}/extension-status`).then((value) => setExtensionConnected(value.paired ? value.connected : null)).catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 15_000);
    return () => window.clearInterval(timer);
  }, [snapshot?.session_id, snapshot?.status]);
  useEffect(() => {
    setPairingCode("");
    setPairingOpen(false);
  }, [snapshot?.session_id]);
  const statusActions = useMemo(() => {
    if (!snapshot) return [];
    switch (snapshot.status) {
      case "lobby": return [["start", "live.start"]] as const;
      case "live":
      case "paused": return [["end", "live.end"]] as const;
      default: return [];
    }
  }, [snapshot]);
  const cueState = snapshot?.current_cue_run?.state;
  const visibleSessions = sessions.filter((item) => item.status !== "draft");
  const activeSession = visibleSessions.find((item) => item.status !== "ended");
  const isControllable = snapshot && snapshot.status !== "ended" && snapshot.status !== "draft";
  const isLive = snapshot?.status === "live";

  function showResults() {
    if (!snapshot) return;
    window.open(`/results/${snapshot.session_id}`, "_blank", "noopener,noreferrer");
  }

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
      const issued = await postJson<{ token: string }>(`/api/sessions/${snapshot.session_id}/tokens`, { role: "presenter" });
      const url = `/projection/${snapshot.session_id}?${projectionThemeSearch(theme)}#token=${encodeURIComponent(issued.token)}`;
      if (target) target.location.href = url;
      else location.href = url;
    } catch {
      target?.close();
    }
  }

  async function toggleExtensionPairing() {
    if (pairingOpen) {
      setPairingOpen(false);
      return;
    }
    if (pairingCode) {
      setPairingOpen(true);
      return;
    }
    if (!snapshot) return;
    const response = await postJson<{ code: string }>(
      `/api/sessions/${snapshot.session_id}/extension-pairing`,
      {},
    );
    setPairingCode(response.code);
    setPairingOpen(true);
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
    await refreshSnapshot().catch(() => undefined);
  }

  return (
    <section className="live-dock">
      <div className="live-summary">
        <span className={snapshot && snapshot.status !== "ended" ? "live-light active" : "live-light"} />
        <div><small>{t("live.heading")}</small><strong>{snapshot ? t(`statusName.${snapshot.status}`) : t("live.none")}</strong>{snapshot && <em className={extensionConnected === true ? "sync-connected" : ""}>{extensionConnected === true ? t("sync.connected") : extensionConnected === false ? t("sync.disconnected") : snapshot.sync_mode === "manual" ? t("sync.manualStatus") : t("sync.notPaired")}</em>}</div>
        {isControllable && snapshot?.join_code && <div className="join-code"><small>{t("live.joinCode")}</small><strong>{snapshot.join_code}</strong></div>}
        {statusActions.map(([type, key]) => <button className="live-end-button" disabled={busy} key={type} onClick={() => send({ type })}>{t(key)}</button>)}
      </div>
      {!activeSession && <button className="primary-button ended-session-create" disabled={!project || busy} onClick={createSession}>{t("live.new")}</button>}
      <div className="live-actions">
        {!isControllable && visibleSessions.length > 0 && <select aria-label={t("live.activityHistory")} value={sessionId} onChange={(event) => setSessionId(event.target.value)}>
          {visibleSessions.map((item) => <option key={item.id} value={item.id}>{sessionLabel(t, item)}</option>)}
        </select>}
        {isLive && (
          <select
            aria-label={t("live.selectCue")}
            value={snapshot.presentation_view === "join_qr" ? "__join_qr__" : (snapshot.current_cue_run?.cue_id ?? "__join_qr__")}
            disabled={busy}
            onChange={(event) => {
              if (event.target.value === "__join_qr__") send({ type: "show_join_qr" });
              else if (event.target.value === snapshot.current_cue_run?.cue_id) send({ type: "show_cue" });
              else if (event.target.value) send({ type: "prepare_cue", cue_id: event.target.value });
            }}
          >
            <option value="__join_qr__">{t("live.qrHome")}</option>
            {cues.map((item) => <option value={item.id} key={item.id}>{cueNavigationLabel(t, item)}</option>)}
          </select>
        )}
        {isControllable && cueState === "ready" && <button onClick={() => send({ type: "open_cue" })}>{t("live.open")}</button>}
        {isLive && (cueState === "open" || cueState === "closed") && <button onClick={() => send({ type: "reveal_cue" })}>{t("live.reveal")}</button>}
        {isControllable && cueState === "revealed" && <button onClick={() => send({ type: "reopen_cue" })}>{t("live.reopen")}</button>}
        {snapshot?.status === "ended" && <button disabled={busy || !project} onClick={() => send({ type: "reopen_session" })}>{t("live.reopen")}</button>}
        {isControllable && <ProjectionThemePicker t={t} theme={theme} setTheme={setTheme} variant="select" />}
        {isControllable && <button className="secondary-link" onClick={createRemoteAccess}>{t("live.remote")}</button>}
        {isControllable && <button className="secondary-link" onClick={launchProjection}>{t("live.projection")}</button>}
        {isControllable && <button className="secondary-link" onClick={launchOverlay}>{t("live.overlay")}</button>}
        {snapshot && <button className="secondary-link" onClick={showResults}>{t("live.results")}</button>}
        {isControllable && <button className="secondary-link" aria-expanded={pairingOpen} onClick={() => void toggleExtensionPairing()}>{t("sync.pair")}</button>}
        {isControllable && snapshot?.sync_mode !== "manual" && <button className="secondary-link" onClick={useManualSync}>{t("sync.manual")}</button>}
      </div>
      <button className="live-dock-close" type="button" onClick={onClose} aria-label={t("live.hideControls")}>×</button>
      {pairingOpen && pairingCode && <div className="pairing-code" role="status">
        <div className="pairing-code-copy"><small>{t("sync.pairingCode")}</small><strong>{pairingCode}</strong><span>{t("sync.pairingCopy")}</span></div>
        <a className="extension-download-link" href="/downloads/slideact-extension.zip" download>{t("sync.downloadExtension")}</a>
      </div>}
      {remoteLink && <RemoteAccessPanel t={t} url={remoteLink} close={() => setRemoteLink("")} />}
    </section>
  );
}

function sessionLabel(t: Translate, session: LiveSession) {
  const date = new Date(session.created_at).toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
  return `${t(`statusName.${session.status}`)} · ${date}${session.status === "ended" ? "" : ` · ${session.join_code ?? ""}`}`;
}

function RemoteAccessPanel({ t, url, close }: { t: Translate; url: string; close: () => void }) {
  const svg = useMemo(() => qrSvgTag(url, 4), [url]);
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
