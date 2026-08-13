import { useEffect, useState } from "react";

import { ApiError, apiJson } from "./api";

type Translate = (key: any, params?: Readonly<Record<string, string | number>>) => string;
type Version = { version: string; protocol_version: number; google_oauth_configured: boolean };
type Readiness = { status: string; database: boolean; redis: boolean };
type ClientError = { id: string; surface: string; route: string; message: string; created_at: string };

export function DiagnosticsApp({ t }: { t: Translate }) {
  const [version, setVersion] = useState<Version | null>(null);
  const [ready, setReady] = useState<Readiness | null>(null);
  const [errors, setErrors] = useState<ClientError[]>([]);
  const [authRequired, setAuthRequired] = useState(false);

  useEffect(() => {
    Promise.all([
      apiJson<Version>("/api/version"),
      apiJson<Readiness>("/health/ready"),
      apiJson<ClientError[]>("/api/diagnostics/client-errors"),
    ]).then(([nextVersion, nextReady, nextErrors]) => {
      setVersion(nextVersion);
      setReady(nextReady);
      setErrors(nextErrors);
    }).catch((error) => {
      if (error instanceof ApiError && error.status === 401) setAuthRequired(true);
    });
  }, []);

  if (authRequired) return <main className="center-state"><a className="primary-button" href="/presenter">{t("diagnostics.signIn")}</a></main>;
  return (
    <main className="diagnostics-shell">
      <p className="eyebrow">{t("diagnostics.eyebrow")}</p>
      <h1>{t("diagnostics.heading")}</h1>
      <section className="diagnostic-grid">
        <StatusCard label="API" ok={ready?.status === "ready"} value={ready?.status ?? t("status.checking")} />
        <StatusCard label="PostgreSQL" ok={ready?.database === true} value={ready?.database ? t("status.ready") : t("status.checking")} />
        <StatusCard label="Redis" ok={ready?.redis === true} value={ready?.redis ? t("status.ready") : t("status.checking")} />
        <StatusCard label="Google OAuth" ok={version?.google_oauth_configured === true} value={version?.google_oauth_configured ? t("status.ready") : t("diagnostics.notConfigured")} />
      </section>
      <p className="diagnostic-version">Slideact {version?.version ?? "—"} · protocol {version?.protocol_version ?? "—"}</p>
      <section className="diagnostic-errors">
        <h2>{t("diagnostics.recentErrors")}</h2>
        {!errors.length ? <p>{t("diagnostics.noErrors")}</p> : errors.map((error) => (
          <article key={error.id}><strong>{error.message}</strong><span>{error.surface} · {error.route}</span><time>{error.created_at}</time></article>
        ))}
      </section>
    </main>
  );
}

function StatusCard({ label, ok, value }: { label: string; ok: boolean; value: string }) {
  return <article className={ok ? "diagnostic-card ready" : "diagnostic-card"}><span /> <small>{label}</small><strong>{value}</strong></article>;
}
