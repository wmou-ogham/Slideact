import { afterEach, describe, expect, it, vi } from "vitest";

import { uuid } from "./api";

describe("uuid", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses a UUID v4 fallback when randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {
      getRandomValues(bytes: Uint8Array) {
        bytes.fill(0xab);
        return bytes;
      },
    });

    expect(uuid()).toBe("abababab-abab-4bab-abab-abababababab");
  });
});
