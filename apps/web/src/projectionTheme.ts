export const PROJECTION_THEMES = ["classic", "lively", "terminal"] as const;

export type ProjectionTheme = (typeof PROJECTION_THEMES)[number];

export const DEFAULT_PROJECTION_THEME: ProjectionTheme = "lively";
export const PROJECTION_THEME_STORAGE_KEY = "slide-helper-projection-theme";
export const PROJECTION_THEME_CHANNEL = "slide-helper-projection-theme";

export const WORD_CLOUD_THEME = {
  classic: {
    colors: ["#f8f6ef", "#f2ce6e", "#8dd5ae", "#f0a89f", "#d9c2f0", "#7ed0e6", "#ffc09a"],
    font: "Inter, ui-sans-serif, system-ui, sans-serif",
    rotate: true,
  },
  lively: {
    colors: ["#335cff", "#2448d8", "#171717", "#5e73e8", "#173d8f", "#4664ff"],
    font: "Inter, ui-sans-serif, system-ui, sans-serif",
    rotate: true,
  },
  terminal: {
    colors: ["#55dfff", "#22b8d6", "#b3efff", "#77b8c8", "#1e8baa", "#c5f6ff"],
    font: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
    rotate: false,
  },
} as const;

export function isProjectionTheme(value: unknown): value is ProjectionTheme {
  return typeof value === "string" && (PROJECTION_THEMES as readonly string[]).includes(value);
}

export function parseProjectionTheme(value: unknown): ProjectionTheme | null {
  return isProjectionTheme(value) ? value : null;
}

export function readStoredProjectionTheme(storage: Pick<Storage, "getItem"> | null = defaultStorage()): ProjectionTheme {
  try {
    return parseProjectionTheme(storage?.getItem(PROJECTION_THEME_STORAGE_KEY)) ?? DEFAULT_PROJECTION_THEME;
  } catch {
    return DEFAULT_PROJECTION_THEME;
  }
}

export function resolveProjectionTheme(
  search: string = typeof window === "undefined" ? "" : window.location.search,
  storage: Pick<Storage, "getItem"> | null = defaultStorage(),
): ProjectionTheme {
  const fromQuery = parseProjectionTheme(new URLSearchParams(search).get("theme"));
  return fromQuery ?? readStoredProjectionTheme(storage);
}

export function persistProjectionTheme(
  theme: ProjectionTheme,
  storage: Pick<Storage, "setItem"> | null = defaultStorage(),
): void {
  try {
    storage?.setItem(PROJECTION_THEME_STORAGE_KEY, theme);
  } catch {
    // Private mode and blocked storage should not break the live projection page.
  }
}

export function projectionThemeSearch(theme: ProjectionTheme): string {
  return `theme=${encodeURIComponent(theme)}`;
}

export function broadcastProjectionTheme(theme: ProjectionTheme): void {
  persistProjectionTheme(theme);
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(PROJECTION_THEME_CHANNEL);
  channel.postMessage({ theme });
  channel.close();
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
