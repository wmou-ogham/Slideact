import { describe, expect, it } from "vitest";

import {
  interactionDraftValid,
  resultVisibilityFromForm,
  responseSettingsFromForm,
  responseSettingsFromInteraction,
} from "./InteractionWorkspace";

describe("resultVisibilityFromForm", () => {
  it("maps background questions and published results to separate modes", () => {
    expect(resultVisibilityFromForm("background")).toBe("background");
    expect(resultVisibilityFromForm("after_reveal")).toBe("after_reveal");
  });

  it("keeps results gated when the radio value is absent", () => {
    expect(resultVisibilityFromForm(null)).toBe("after_reveal");
    expect(resultVisibilityFromForm("unexpected")).toBe("after_reveal");
  });
});

describe("interactionDraftValid", () => {
  const draft = {
    interaction_type: "single_choice" as const,
    prompt: "Which answer is correct?",
    purpose: "knowledge" as const,
    visibility: "after_reveal" as const,
    options: ["Option A", "Option B"],
    response: {
      allow_change: true,
      multiple_selection: false,
      submission_limit: 3,
      allow_duplicate: true,
    },
  };

  it("allows complete interaction drafts to auto-save", () => {
    expect(interactionDraftValid(draft)).toBe(true);
    expect(interactionDraftValid({ ...draft, interaction_type: "word_cloud", options: [] }))
      .toBe(true);
  });

  it("waits while required prompt or choice values are incomplete", () => {
    expect(interactionDraftValid({ ...draft, prompt: " " })).toBe(false);
    expect(interactionDraftValid({ ...draft, options: ["Option A", ""] })).toBe(false);
    expect(interactionDraftValid({ ...draft, options: ["Only one"] })).toBe(false);
    expect(interactionDraftValid({ ...draft, options: Array.from({ length: 7 }, (_, index) => `Option ${index}`) }))
      .toBe(false);
  });
});

describe("interaction response settings", () => {
  it("reads type-specific creation settings from the form", () => {
    const choice = new FormData();
    choice.set("multiple_selection", "on");
    expect(responseSettingsFromForm("single_choice", choice)).toMatchObject({
      multiple_selection: true,
      allow_change: false,
    });

    const wordCloud = new FormData();
    wordCloud.set("submission_limit", "7");
    expect(responseSettingsFromForm("word_cloud", wordCloud)).toMatchObject({
      submission_limit: 7,
      allow_duplicate: false,
    });
  });

  it("loads saved values and keeps backward-compatible defaults", () => {
    expect(responseSettingsFromInteraction()).toEqual({
      allow_change: true,
      multiple_selection: false,
      submission_limit: 3,
      allow_duplicate: true,
    });
    expect(responseSettingsFromInteraction({
      settings: { response: { allow_change: false, submission_limit: 8 } },
    } as never)).toMatchObject({ allow_change: false, submission_limit: 8 });
  });
});
