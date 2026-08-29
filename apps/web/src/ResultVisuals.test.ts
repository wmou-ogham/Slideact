import { describe, expect, it } from "vitest";

import { wordCloudLayoutSignature } from "./ResultVisuals";

describe("word cloud layout revisions", () => {
  it("changes the layout revision when a repeated submission adds a word", () => {
    const first = wordCloudLayoutSignature([{ text: "first", count: 1 }]);
    const next = wordCloudLayoutSignature([
      { text: "first", count: 1 },
      { text: "second", count: 1 },
    ]);

    expect(next).not.toBe(first);
  });

  it("changes the layout revision when the count of an existing word changes", () => {
    expect(wordCloudLayoutSignature([{ text: "same", count: 2 }]))
      .not.toBe(wordCloudLayoutSignature([{ text: "same", count: 1 }]));
  });

  it("keeps equivalent aggregate entries on the same revision", () => {
    expect(wordCloudLayoutSignature([{ text: "stable", count: 1 }]))
      .toBe(wordCloudLayoutSignature([{ text: "stable", count: 1 }]));
  });
});
