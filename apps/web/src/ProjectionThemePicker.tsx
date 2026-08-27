import type { Translate } from "./i18n";
import { PROJECTION_THEMES, type ProjectionTheme } from "./projectionTheme";

export function ProjectionThemePicker({
  t,
  theme,
  setTheme,
  variant = "buttons",
}: {
  t: Translate;
  theme: ProjectionTheme;
  setTheme: (theme: ProjectionTheme) => void;
  variant?: "buttons" | "select";
}) {
  if (variant === "select") {
    return (
      <select
        className="projection-theme-select"
        aria-label={t("theme.label")}
        value={theme}
        onChange={(event) => setTheme(event.target.value as ProjectionTheme)}
      >
        {PROJECTION_THEMES.map((id) => (
          <option key={id} value={id}>{t(`theme.${id}`)}</option>
        ))}
      </select>
    );
  }

  return (
    <div className="projection-theme-picker" role="group" aria-label={t("theme.label")}>
      {PROJECTION_THEMES.map((id) => (
        <button
          className={theme === id ? "selected" : undefined}
          type="button"
          key={id}
          aria-pressed={theme === id}
          onClick={(event) => {
            setTheme(id);
            if (event.detail) event.currentTarget.blur();
          }}
        >
          {t(`theme.${id}`)}
        </button>
      ))}
    </div>
  );
}
