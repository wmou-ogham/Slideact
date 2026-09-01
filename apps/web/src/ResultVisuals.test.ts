import { describe, expect, it } from "vitest";

import {
  type PositionedWordCloudGlyph,
  questionCardLayout,
  reflowWordCloudAroundPinned,
  restoreMissingWordCloudWords,
  visibleProjectionQuestions,
  wordCloudDensityScale,
  wordCloudFloatingTexts,
  wordCloudLayoutSignature,
  wordCloudWordsOverlap,
} from "./ResultVisuals";
import type { Question } from "./types";

function question(body: string, status: Question["status"] = "visible"): Question {
  return {
    id: `${status}-${body}`,
    cue_run_id: "run-1",
    body,
    display_name: null,
    status,
    votes: 0,
    voted_by_me: false,
    created_at: "2026-09-01T00:00:00Z",
  };
}

describe("question projection layout", () => {
  it("shrinks long questions before promoting them to a two-column card", () => {
    expect(questionCardLayout("短問題")).toBe("regular");
    expect(questionCardLayout("中".repeat(27))).toBe("condensed");
    expect(questionCardLayout("長".repeat(49))).toBe("compact");
    expect(questionCardLayout("超".repeat(85))).toBe("wide");
  });

  it("keeps hidden questions out of the projection while retaining moderated states", () => {
    const visible = question("Visible");
    const answered = question("Answered", "answered");
    const hidden = question("Hidden", "hidden");
    expect(visibleProjectionQuestions([visible, hidden, answered])).toEqual([visible, answered]);
  });
});

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

  it("does not include pin state in the layout revision", () => {
    const entries = [{ text: "highlight me", count: 3 }];
    const beforePin = wordCloudLayoutSignature(entries);
    const pinned = new Set(["highlight me"]);

    expect(pinned.has("highlight me")).toBe(true);
    expect(wordCloudLayoutSignature(entries)).toBe(beforePin);
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

  it("keeps every word visible when a small canvas is saturated", () => {
    const result = restoreMissingWordCloudWords(
      [word("wide pinned answer", 0, 0, 48)],
      [word("another wide answer", 0, 0, 48), word("latest answer", 0, 0, 48)],
      120,
      60,
    );

    expect(result.map((item) => item.text)).toEqual([
      "wide pinned answer",
      "another wide answer",
      "latest answer",
    ]);
  });
});

describe("pinned word cloud layout", () => {
  it("keeps pinned words fixed and reflows other words around them", () => {
    const pinned = word("pinned answer", -170, -40, 42);
    const result = reflowWordCloudAroundPinned(
      [word("pinned answer", 170, 40, 70), word("nearby answer", 170, 40, 42)],
      [pinned],
    );
    const fixed = result.find((item) => item.text === pinned.text);
    const nearby = result.find((item) => item.text === "nearby answer");

    expect(fixed).toEqual(pinned);
    expect(nearby).toBeDefined();
    expect(wordCloudWordsOverlap(fixed!, nearby!)).toBe(false);
  });
});

describe("word cloud density", () => {
  it("keeps the original type scale while the cloud is below 70% occupancy", () => {
    const sparse = [
      { text: "互動", value: 2 },
      { text: "洞察", value: 1 },
      { text: "清晰", value: 1 },
    ];

    expect(wordCloudDensityScale(sparse, 1, 2)).toBe(1);
  });

  it("only shrinks the shared type scale after the cloud passes 70% occupancy", () => {
    const dense = Array.from({ length: 70 }, (_, index) => ({
      text: `audience-insight-${index}`,
      value: 1 + index % 5,
    }));

    const scale = wordCloudDensityScale(dense, 1, 5);
    expect(scale).toBeLessThan(1);
    expect(scale).toBeGreaterThan(0);
  });
});

describe("word cloud decorative motion", () => {
  it("limits perpetual floating to the six highest-value words", () => {
    const words = Array.from({ length: 12 }, (_, index) => ({
      text: `word-${index}`,
      value: index,
    }));

    const floating = wordCloudFloatingTexts(words);

    expect(floating.size).toBe(6);
    expect(floating.has("word-11")).toBe(true);
    expect(floating.has("word-6")).toBe(true);
    expect(floating.has("word-5")).toBe(false);
  });
});
