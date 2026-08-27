import { ApiError, postJson } from "./api";
import type { Translate } from "./i18n";
import type { GuestVaultFile } from "./types";

export function PresenterLogin({ t, locale, busy, message, setMessage }: {
  t: Translate;
  locale: string;
  busy: boolean;
  message: string;
  setMessage: (value: string) => void;
}) {
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
        disabled={busy}
        onClick={async () => {
          await postJson("/api/auth/guest", { locale });
          window.location.reload();
        }}
      >
        {t("auth.guest")}
      </button>
      <small className="guest-note">{t("auth.guestNote")}</small>
      <form
        className="vault-restore"
        onSubmit={async (event) => {
          event.preventDefault();
          const key = new FormData(event.currentTarget).get("vaultKey");
          if (typeof key !== "string") return;
          await restoreGuestVault(key, setMessage, t).then((ok) => ok && location.reload());
        }}
      >
        <p>{t("auth.restoreHeading")}</p>
        <label className="guest-button vault-file">
          {t("auth.openVault")}
          <input
            type="file"
            accept="application/json,.json"
            onChange={async (event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (!file) return;
              const ok = await restoreGuestVault(await file.text(), setMessage, t);
              if (ok) location.reload();
            }}
          />
        </label>
        <div className="inline-form">
          <input name="vaultKey" maxLength={200} placeholder={t("auth.vaultKeyPlaceholder")} autoComplete="off" />
          <button disabled={busy} type="submit">{t("auth.restoreVault")}</button>
        </div>
        {message && <p className="form-error" role="alert">{message}</p>}
      </form>
    </main>
  );
}

export function parseVaultCredential(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { recovery_key?: unknown };
    if (typeof parsed.recovery_key === "string" && parsed.recovery_key.trim()) {
      return parsed.recovery_key.trim();
    }
  } catch {
    // Plain recovery keys are accepted as well as downloaded JSON files.
  }
  return trimmed;
}

async function restoreGuestVault(
  raw: string,
  setMessage: (value: string) => void,
  t: Translate,
): Promise<boolean> {
  const recovery_key = parseVaultCredential(raw);
  if (!recovery_key) {
    setMessage(t("auth.vaultInvalid"));
    return false;
  }
  try {
    await postJson("/api/auth/guest/restore", { recovery_key });
    return true;
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "network_error";
    setMessage(code === "guest_vault_recovery_invalid" ? t("auth.vaultInvalid") : t("error.generic", { code }));
    return false;
  }
}

export async function downloadGuestVault(
  vaultId: string | null,
  setMessage: (value: string) => void,
  t: Translate,
): Promise<void> {
  if (!window.confirm(t("auth.takeVaultConfirm"))) return;
  try {
    const file = await postJson<GuestVaultFile>("/api/auth/guest/export", {});
    const blob = new Blob([`${JSON.stringify(file, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `slideact-vault-${(file.vault_id || vaultId || "guest").slice(0, 8)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setMessage(t("auth.vaultTaken"));
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "network_error";
    setMessage(t("error.generic", { code }));
  }
}
