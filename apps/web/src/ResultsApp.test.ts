import { describe, expect, it } from "vitest";

import { uniqueCueRuns } from "./uniqueCueRuns";
import type { SessionResults } from "./types";

function run(
  overrides: Partial<SessionResults["cue_runs"][number]> & Pick<SessionResults["cue_runs"][number], "id" | "cue_id" | "run_number">,
): SessionResults["cue_runs"][number] {
  return {
    cue_name: "Check understanding",
    anchor_value: "3",
    state: "revealed",
    created_at: "2026-08-14T08:00:00.000Z",
    opened_at: "2026-08-14T08:01:00.000Z",
    closed_at: "2026-08-14T08:02:00.000Z",
    revealed_at: "2026-08-14T08:02:00.000Z",
    interactions: [],
    questions: [],
    ...overrides,
  };
}

describe("uniqueCueRuns", () => {
  it("keeps one page per cue and prefers the run with responses", () => {
    const empty = run({
      id: "run-empty",
      cue_id: "cue-1",
      run_number: 1,
      interactions: [{ id: "i1", interaction_type: "understanding", prompt: "Clear?", aggregate: null }],
    });
    const filled = run({
      id: "run-filled",
      cue_id: "cue-1",
      run_number: 2,
      interactions: [{
        id: "i1",
        interaction_type: "understanding",
        prompt: "Clear?",
        aggregate: { interaction_type: "understanding", total_responses: 12, green: 8, yellow: 3, red: 1 },
      }],
    });
    const later = run({
      id: "run-later",
      cue_id: "cue-2",
      run_number: 1,
      cue_name: "Quiz",
      anchor_value: "5",
      interactions: [{ id: "i2", interaction_type: "single_choice", prompt: "Which?", aggregate: null }],
    });

    const merged = uniqueCueRuns([empty, later, filled]);

    expect(merged.map((item) => item.cue_id)).toEqual(["cue-1", "cue-2"]);
    expect(merged[0]?.id).toBe("run-filled");
    expect(merged[0]?.interactions[0]?.aggregate?.total_responses).toBe(12);
  });

  it("merges questions from duplicate runs of the same page", () => {
    const first = run({
      id: "run-a",
      cue_id: "cue-1",
      run_number: 1,
      questions: [{ id: "q1", body: "First", status: "visible", votes: 2, created_at: "2026-08-14T08:03:00.000Z" }],
    });
    const second = run({
      id: "run-b",
      cue_id: "cue-1",
      run_number: 2,
      questions: [
        { id: "q1", body: "First", status: "visible", votes: 2, created_at: "2026-08-14T08:03:00.000Z" },
        { id: "q2", body: "Second", status: "visible", votes: 1, created_at: "2026-08-14T08:04:00.000Z" },
      ],
    });

    expect(uniqueCueRuns([first, second])[0]?.questions.map((item) => item.id)).toEqual(["q1", "q2"]);
  });
});
