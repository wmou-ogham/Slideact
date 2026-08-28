import { describe, expect, it } from "vitest";

import {
  defaultVisibility,
  interactionResultVisibility,
  projectionInteractionIsVisible,
} from "./interactions";

describe("interaction result visibility", () => {
  it("defaults understanding checks to the background", () => {
    expect(defaultVisibility("understanding")).toBe("background");
    expect(defaultVisibility("single_choice")).toBe("after_reveal");
  });

  it("hides background interactions from public projection surfaces", () => {
    expect(interactionResultVisibility({ results: { audience_visibility: "background" } })).toBe("background");
    expect(projectionInteractionIsVisible({ settings: { results: { audience_visibility: "background" } } })).toBe(false);
    expect(projectionInteractionIsVisible({ settings: { results: { audience_visibility: "after_reveal" } } })).toBe(true);
  });
});
