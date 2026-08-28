import { describe, expect, it } from "vitest";

import {
  cueAnchorUpdate,
  cueShortcutAction,
  insertCueIdAtPosition,
  normalizeSlideAnchor,
  reorderCueIds,
  shouldCollapseLibraryByDefault,
} from "./PresenterApp";
import { parseVaultCredential } from "./PresenterAuth";

describe("normalizeSlideAnchor", () => {
  it("uses the next one-based slide index when the field is empty", () => {
    expect(normalizeSlideAnchor("", 5)).toBe("5");
  });

  it("accepts a one-based slide number or a direct Google slide id", () => {
    expect(normalizeSlideAnchor(" 12 ", 1)).toBe("12");
    expect(normalizeSlideAnchor("id.g3f7c2fe3ef4_1_84", 1)).toBe("g3f7c2fe3ef4_1_84");
  });

  it("extracts the final slide id from a Google Slides URL", () => {
    expect(normalizeSlideAnchor(
      "https://docs.google.com/presentation/d/deck/edit?slide=id.g-old#slide=id.g3f7c2fe3ef4_1_84",
      1,
    )).toBe("g3f7c2fe3ef4_1_84");
    expect(normalizeSlideAnchor(
      "https://docs.google.com/presentation/d/deck/edit#slide=id.p",
      1,
    )).toBe("p");
  });
});

describe("reorderCueIds", () => {
  const cues = [
    { id: "cue-a", position: 0 },
    { id: "cue-b", position: 1 },
    { id: "cue-c", position: 2 },
  ];

  it("moves a dragged cue to the dropped position in either direction", () => {
    expect(reorderCueIds(cues, "cue-a", "cue-c")).toEqual(["cue-b", "cue-c", "cue-a"]);
    expect(reorderCueIds(cues, "cue-c", "cue-a")).toEqual(["cue-c", "cue-a", "cue-b"]);
  });

  it("keeps the order stable for missing or identical cues", () => {
    expect(reorderCueIds(cues, "missing", "cue-a")).toEqual(["cue-a", "cue-b", "cue-c"]);
    expect(reorderCueIds(cues, "cue-b", "cue-b")).toEqual(["cue-a", "cue-b", "cue-c"]);
  });

  it("inserts a restored cue at its previous position", () => {
    expect(insertCueIdAtPosition(cues, "cue-restored", 1))
      .toEqual(["cue-a", "cue-restored", "cue-b", "cue-c"]);
    expect(insertCueIdAtPosition(cues, "cue-b", 0))
      .toEqual(["cue-b", "cue-a", "cue-c"]);
  });
});

describe("cueShortcutAction", () => {
  const shortcut = (key: string, overrides: Partial<KeyboardEvent> = {}) => cueShortcutAction({
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  }, false);

  it("maps delete, backspace, arrow selection, and platform undo", () => {
    expect(shortcut("Delete")).toBe("delete");
    expect(shortcut("Backspace")).toBe("delete");
    expect(shortcut("ArrowUp")).toBe("select-previous");
    expect(shortcut("ArrowDown")).toBe("select-next");
    expect(shortcut("z", { metaKey: true })).toBe("undo");
    expect(shortcut("Z", { ctrlKey: true })).toBe("undo");
  });

  it("preserves native editing shortcuts and ignores modified movement", () => {
    expect(cueShortcutAction({
      key: "Backspace",
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    }, true)).toBeNull();
    expect(shortcut("ArrowDown", { metaKey: true })).toBeNull();
    expect(shortcut("z", { ctrlKey: true, shiftKey: true })).toBeNull();
  });
});

describe("cueAnchorUpdate", () => {
  it("clears the Google Slides binding as a manual cue", () => {
    expect(cueAnchorUpdate("   ", 5)).toEqual({ anchor_type: "manual", anchor_value: null });
  });

  it("normalizes a populated binding as a deck slide cue", () => {
    expect(cueAnchorUpdate("id.gabc", 5)).toEqual({
      anchor_type: "deck_slide",
      anchor_value: "gabc",
    });
  });
});

describe("parseVaultCredential", () => {
  it("extracts the recovery key from a downloaded vault file or a pasted key", () => {
    expect(parseVaultCredential("  svlt1.abc  ")).toBe("svlt1.abc");
    expect(parseVaultCredential(JSON.stringify({
      kind: "slideact.guest_vault",
      version: 1,
      vault_id: "11111111-1111-1111-1111-111111111111",
      recovery_key: "svlt1.secret-key",
    }))).toBe("svlt1.secret-key");
    expect(parseVaultCredential("   ")).toBeNull();
  });
});

describe("shouldCollapseLibraryByDefault", () => {
  it("opens onboarding for a new account and collapses an existing project library", () => {
    expect(shouldCollapseLibraryByDefault([])).toBe(false);
    expect(shouldCollapseLibraryByDefault([{ id: "project-a" }])).toBe(true);
  });
});
