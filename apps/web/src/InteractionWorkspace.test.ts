import { describe, expect, it } from "vitest";

import { interactionDraftValid, liveVisibilityFromForm } from "./InteractionWorkspace";

describe("liveVisibilityFromForm", () => {
  it("maps the checked checkbox value to live visibility", () => {
    expect(liveVisibilityFromForm("on")).toBe("live");
  });

  it("keeps results gated when the checkbox is absent", () => {
    expect(liveVisibilityFromForm(null)).toBe("after_reveal");
    expect(liveVisibilityFromForm("unexpected")).toBe("after_reveal");
  });
});

describe("interactionDraftValid", () => {
  const draft = {
    interaction_type: "single_choice" as const,
    prompt: "Which answer is correct?",
    purpose: "knowledge" as const,
    visibility: "after_reveal" as const,
    options: ["Option A", "Option B"],
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
