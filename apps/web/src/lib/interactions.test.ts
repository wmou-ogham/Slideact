import { describe, expect, it } from "vitest";

import {
  cueNavigationLabel,
  defaultResultSettings,
  interactionResultSettings,
  projectionInteractionIsVisible,
  projectionInteractionShowsResults,
  resultSettingsPayload,
} from "./interactions";

const translate = ((key: string, values?: Readonly<Record<string, string | number>>) => {
  if (key === "cue.slide") return `Slide ${values?.slide}`;
  if (key === "cue.slideId") return `Slide ID · ${values?.id}`;
  return key;
}) as import("../i18n").Translate;

describe("cue navigation labels", () => {
  it("uses the mapped slide instead of the custom cue name", () => {
    expect(cueNavigationLabel(translate, {
      id: "cue-1",
      project_id: "project-1",
      position: 0,
      name: "A custom cue name",
      anchor_type: "deck_slide",
      anchor_value: "8",
      trigger_mode: "immediate",
      delay_seconds: 0,
      interactions: [],
    })).toBe("Slide 8");
  });
});

describe("interaction result visibility", () => {
  it("defaults understanding checks to the background and other prompts to publish", () => {
    expect(defaultResultSettings("understanding")).toEqual({
      background_question: true,
      publish_results: false,
    });
    expect(defaultResultSettings("single_choice")).toEqual({
      background_question: false,
      publish_results: true,
    });
  });

  it("keeps interactions with missing persisted settings private until reveal", () => {
    expect(interactionResultSettings({}, "understanding")).toEqual({
      background_question: false,
      publish_results: false,
    });
    expect(projectionInteractionShowsResults({
      interaction_type: "qa",
      settings: {},
    }, "open")).toBe(false);
    expect(projectionInteractionShowsResults({
      interaction_type: "qa",
      settings: {},
    }, "revealed")).toBe(true);
  });

  it("keeps background and publish results independent", () => {
    expect(interactionResultSettings({
      results: { background_question: true, publish_results: true },
    }, "single_choice")).toEqual({
      background_question: true,
      publish_results: false,
    });
    expect(interactionResultSettings({
      results: { background_question: false, publish_results: false },
    }, "single_choice")).toEqual({
      background_question: false,
      publish_results: false,
    });
    expect(projectionInteractionIsVisible({
      interaction_type: "understanding",
      settings: { results: { background_question: true, publish_results: false } },
    })).toBe(false);
    expect(projectionInteractionIsVisible({
      interaction_type: "single_choice",
      settings: { results: { background_question: false, publish_results: false } },
    })).toBe(true);
    expect(projectionInteractionShowsResults({
      interaction_type: "single_choice",
      settings: { results: { background_question: false, publish_results: false } },
    }, "revealed")).toBe(true);
    expect(projectionInteractionShowsResults({
      interaction_type: "single_choice",
      settings: { results: { background_question: false, publish_results: false } },
    }, "open")).toBe(false);
    expect(projectionInteractionShowsResults({
      interaction_type: "single_choice",
      settings: { results: { background_question: false, publish_results: true } },
    }, "open")).toBe(true);
    expect(projectionInteractionShowsResults({
      interaction_type: "single_choice",
      settings: { results: { background_question: false, publish_results: true } },
    }, "revealed")).toBe(true);
    expect(projectionInteractionShowsResults({
      interaction_type: "single_choice",
      settings: { results: { background_question: true, publish_results: true } },
    }, "revealed")).toBe(false);
  });

  it("writes a legacy-compatible visibility value", () => {
    expect(resultSettingsPayload({ background_question: true, publish_results: true })).toMatchObject({
      background_question: true,
      publish_results: false,
      audience_visibility: "background",
    });
    expect(resultSettingsPayload({ background_question: false, publish_results: false })).toMatchObject({
      audience_visibility: "after_reveal",
    });
    expect(resultSettingsPayload({ background_question: false, publish_results: true })).toMatchObject({
      audience_visibility: "live",
    });
  });
});
