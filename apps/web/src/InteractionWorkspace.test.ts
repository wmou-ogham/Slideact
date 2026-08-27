import { describe, expect, it } from "vitest";

import { liveVisibilityFromForm } from "./InteractionWorkspace";

describe("liveVisibilityFromForm", () => {
  it("maps the checked checkbox value to live visibility", () => {
    expect(liveVisibilityFromForm("on")).toBe("live");
  });

  it("keeps results gated when the checkbox is absent", () => {
    expect(liveVisibilityFromForm(null)).toBe("after_reveal");
    expect(liveVisibilityFromForm("unexpected")).toBe("after_reveal");
  });
});
