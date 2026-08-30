import { describe, expect, it } from "vitest";

import { audienceResponseSettings, labelFromPayload } from "./AudienceApp";

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
