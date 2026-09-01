import { describe, expect, it } from "vitest";

import { audienceResponseSettings, audienceStageMode, labelFromPayload } from "./AudienceApp";

describe("audience response settings", () => {
  it("uses safe defaults for existing interactions and reads explicit rules", () => {
    expect(audienceResponseSettings()).toEqual({
      allowChange: true,
      multipleSelection: false,
      submissionLimit: 3,
    });
    expect(audienceResponseSettings({
      settings: { response: { allow_change: false, multiple_selection: true, submission_limit: 7 } },
    })).toEqual({
      allowChange: false,
      multipleSelection: true,
      submissionLimit: 7,
    });
  });

  it("restores single and multiple choice selections from response payloads", () => {
    expect(labelFromPayload({ option_id: "option-a" })).toBe("option-a");
    expect(labelFromPayload({ option_ids: ["option-a", "option-c"] })).toBe("option-a,option-c");
    expect(labelFromPayload({ option_ids: ["option-a", 2] })).toBeUndefined();
  });
});

describe("audience stage visibility", () => {
  it("keeps stale cue runs hidden unless the session is live", () => {
    expect(audienceStageMode("lobby", "open")).toBe("waiting");
    expect(audienceStageMode("ended", "revealed")).toBe("waiting");
    expect(audienceStageMode("paused", "open")).toBe("waiting");
  });

  it("only opens responses for an open cue in a live session", () => {
    expect(audienceStageMode("live")).toBe("waiting");
    expect(audienceStageMode("live", "ready")).toBe("waiting");
    expect(audienceStageMode("live", "open")).toBe("open");
    expect(audienceStageMode("live", "closed")).toBe("results");
    expect(audienceStageMode("live", "revealed")).toBe("results");
  });
});
