import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROJECTION_THEME,
  PROJECTION_THEME_STORAGE_KEY,
  parseProjectionTheme,
  persistProjectionTheme,
  projectionThemeSearch,
  readStoredProjectionTheme,
  resolveProjectionTheme,
} from "./projectionTheme";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem(key: string) {
      return data[key] ?? null;
    },
    setItem(key: string, value: string) {
      data[key] = value;
    },
    data,
  };
}

describe("projectionTheme", () => {
  it("accepts only the three present themes", () => {
    expect(parseProjectionTheme("classic")).toBe("classic");
    expect(parseProjectionTheme("lively")).toBe("lively");
    expect(parseProjectionTheme("terminal")).toBe("terminal");
    expect(parseProjectionTheme("mentimeter")).toBeNull();
    expect(parseProjectionTheme("")).toBeNull();
  });

  it("prefers the URL theme over the stored preference", () => {
    const storage = memoryStorage({ [PROJECTION_THEME_STORAGE_KEY]: "classic" });
    expect(resolveProjectionTheme("?theme=terminal", storage)).toBe("terminal");
    expect(resolveProjectionTheme("?theme=nope", storage)).toBe("classic");
    expect(resolveProjectionTheme("", memoryStorage())).toBe(DEFAULT_PROJECTION_THEME);
  });

  it("persists a valid theme and builds a query string", () => {
    const storage = memoryStorage();
    persistProjectionTheme("lively", storage);
    expect(readStoredProjectionTheme(storage)).toBe("lively");
    expect(projectionThemeSearch("lively")).toBe("theme=lively");
  });
});
