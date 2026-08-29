import { describe, expect, it } from "vitest";

import {
  avoidPinnedWordCollisions,
  type PositionedWordCloudGlyph,
  restoreMissingWordCloudWords,
  wordCloudLayoutSignature,
  wordCloudWordsOverlap,
} from "./ResultVisuals";

function word(text: string, x: number, y: number, size = 40): PositionedWordCloudGlyph {
  return { text, x, y, size, rotate: 0 };
}

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

  it("does not collide when submitted text contains the old delimiters", () => {
    expect(wordCloudLayoutSignature([{ text: "a\t1\nb", count: 2 }]))
      .not.toBe(wordCloudLayoutSignature([
        { text: "a", count: 1 },
        { text: "b", count: 2 },
      ]));
  });
});

describe("pinned word collision avoidance", () => {
  it("keeps a pinned word fixed and relocates a colliding new word", () => {
    const fixed = word("pinned", 0, 0, 52);
    const incoming = word("incoming", 0, 0, 32);
    const result = avoidPinnedWordCollisions([fixed, incoming], new Set(["pinned"]));
    const pinned = result.find((item) => item.text === "pinned");
    const moved = result.find((item) => item.text === "incoming");

    expect(pinned).toMatchObject({ x: 0, y: 0, rotate: 0 });
    expect(moved).toBeDefined();
    expect(wordCloudWordsOverlap(pinned!, moved!)).toBe(false);
  });

  it("leaves an already collision-free layout unchanged", () => {
    const words = [word("pinned", -120, 0), word("clear", 120, 0)];
    expect(avoidPinnedWordCollisions(words, new Set(["pinned"]))).toEqual(words);
  });

  it("separates multiple new words that collide with the same pinned word", () => {
    const fixed = word("pinned", 0, 0, 52);
    const result = avoidPinnedWordCollisions(
      [fixed, word("first", 0, 0, 32), word("second", 0, 0, 32)],
      new Set(["pinned"]),
    );
    const pinned = result.find((item) => item.text === "pinned");
    const first = result.find((item) => item.text === "first");
    const second = result.find((item) => item.text === "second");

    expect(pinned).toMatchObject({ x: 0, y: 0, rotate: 0 });
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(wordCloudWordsOverlap(pinned!, first!)).toBe(false);
    expect(wordCloudWordsOverlap(pinned!, second!)).toBe(false);
    expect(wordCloudWordsOverlap(first!, second!)).toBe(false);
  });

  it("omits an incoming word when no non-overlapping position fits", () => {
    const fixed = word("wide pinned answer", 0, 0, 48);
    const incoming = word("another wide answer", 0, 0, 48);
    const result = avoidPinnedWordCollisions(
      [fixed, incoming],
      new Set(["wide pinned answer"]),
      120,
      60,
    );
    expect(result.map((item) => item.text)).toEqual(["wide pinned answer"]);
  });
});

describe("word cloud layout recovery", () => {
  it("restores every aggregate entry omitted by the cloud layout", () => {
    const latest = word("latest", 0, 0, 52);
    const result = restoreMissingWordCloudWords(
      [latest],
      [word("first", 0, 0, 40), word("second", 0, 0, 40)],
    );

    expect(result.map((item) => item.text)).toEqual(["latest", "first", "second"]);
    expect(result[0]).toEqual(latest);
    for (let left = 0; left < result.length; left += 1) {
      for (let right = left + 1; right < result.length; right += 1) {
        expect(wordCloudWordsOverlap(result[left]!, result[right]!)).toBe(false);
      }
    }
  });

  it("does not alter a complete layout", () => {
    const placed = [word("first", -80, 0), word("second", 80, 0)];
    expect(restoreMissingWordCloudWords(placed, [])).toBe(placed);
  });
});
