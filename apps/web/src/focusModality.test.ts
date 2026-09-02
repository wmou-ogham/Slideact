import { describe, expect, it } from "vitest";

import { isFocusNavigationKey } from "./focusModality";

function key(keyName: string, modifiers: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) {
  return {
    altKey: false,
    ctrlKey: false,
    key: keyName,
    metaKey: false,
    ...modifiers,
  };
}

describe("focus modality", () => {
  it("recognizes keyboard focus navigation", () => {
    expect(isFocusNavigationKey(key("Tab"))).toBe(true);
    expect(isFocusNavigationKey(key("ArrowDown"))).toBe(true);
  });

  it("does not treat typing or modified shortcuts as focus navigation", () => {
    expect(isFocusNavigationKey(key("a"))).toBe(false);
    expect(isFocusNavigationKey(key("Tab", { ctrlKey: true }))).toBe(false);
  });
});
