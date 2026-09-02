import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

import {
  DEFAULT_PROJECTION_THEME,
  PROJECTION_THEME_CHANNEL,
  PROJECTION_THEME_STORAGE_KEY,
  type ProjectionTheme,
  broadcastProjectionTheme,
  parseProjectionTheme,
  persistProjectionTheme,
  resolveProjectionTheme,
} from "./projectionTheme";

export const ProjectionThemeContext = createContext<ProjectionTheme>(DEFAULT_PROJECTION_THEME);

export function useProjectionThemeValue() {
  return useContext(ProjectionThemeContext);
}

type ThemeOptions = {
  applyToBody?: boolean;
  broadcastChanges?: boolean;
  persistChanges?: boolean;
  syncExternal?: boolean;
  syncUrl?: boolean;
};

export function useProjectionTheme(options: ThemeOptions = {}) {
  const applyToBody = options.applyToBody ?? false;
  const broadcastChanges = options.broadcastChanges ?? true;
  const persistChanges = options.persistChanges ?? true;
  const syncExternal = options.syncExternal ?? true;
  const syncUrl = options.syncUrl ?? false;
  const [theme, setThemeState] = useState<ProjectionTheme>(() => resolveProjectionTheme());
  const themeRef = useRef(theme);
  themeRef.current = theme;

  const applyTheme = useCallback((next: ProjectionTheme, broadcast: boolean) => {
    if (themeRef.current === next) {
      if (broadcast) broadcastProjectionTheme(next);
      return;
    }
    setThemeState(next);
    if (persistChanges) persistProjectionTheme(next);
    if (broadcast) broadcastProjectionTheme(next);
  }, [persistChanges]);

  useEffect(() => {
    if (!applyToBody) return;
    document.body.classList.add("projection-body");
    document.body.dataset.projectionTheme = theme;
    if (persistChanges) persistProjectionTheme(theme);
    return () => {
      document.body.classList.remove("projection-body");
      delete document.body.dataset.projectionTheme;
    };
  }, [applyToBody, persistChanges, theme]);

  useEffect(() => {
    if (!syncUrl) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("theme") === theme) return;
    url.searchParams.set("theme", theme);
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [syncUrl, theme]);

  useEffect(() => {
    if (!syncExternal) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== PROJECTION_THEME_STORAGE_KEY) return;
      const next = parseProjectionTheme(event.newValue);
      if (next) applyTheme(next, false);
    };
    window.addEventListener("storage", onStorage);
    if (typeof BroadcastChannel === "undefined") {
      return () => window.removeEventListener("storage", onStorage);
    }
    const channel = new BroadcastChannel(PROJECTION_THEME_CHANNEL);
    channel.addEventListener("message", (event) => {
      const next = parseProjectionTheme((event.data as { theme?: unknown } | null)?.theme);
      if (next) applyTheme(next, false);
    });
    return () => {
      window.removeEventListener("storage", onStorage);
      channel.close();
    };
  }, [applyTheme, syncExternal]);

  const setTheme = useCallback((next: ProjectionTheme) => {
    applyTheme(next, broadcastChanges);
  }, [applyTheme, broadcastChanges]);

  return [theme, setTheme] as const;
}
