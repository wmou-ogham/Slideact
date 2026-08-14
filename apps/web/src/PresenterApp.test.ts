import { describe, expect, it } from "vitest";

import { normalizeSlideAnchor, parseVaultCredential } from "./PresenterApp";

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
