import { describe, expect, it } from "vitest";

import type { LiveView } from "../types";
import {
  beginLiveRefresh,
  createLiveRefreshOrder,
  createLiveRefreshScheduler,
  rememberCueLive,
  scheduleLiveRefresh,
  shouldApplyLiveRefresh,
} from "./liveSession";

type CueRunState = NonNullable<LiveView["snapshot"]["current_cue_run"]>["state"];

function view(
  state: CueRunState,
  results: Record<string, unknown>,
  aggregates: LiveView["aggregates"] = [],
): LiveView {
  return {
    snapshot: {
      session_id: "session-1",
      project_id: "project-1",
      join_code: "123456",
      status: "live",
      locale: "en",
      sync_mode: "manual",
      interface_theme: "lively",
      state_version: 1,
      presentation_view: "cue",
      presentation_follows_cue: true,
      current_cue_run: {
        id: "run-1",
        cue_id: "cue-1",
        cue_name: "Check",
        run_number: 1,
        state,
        state_version: 1,
        interactions: [{
          id: "interaction-1",
          interaction_type: "single_choice",
          prompt: "Check",
          description: null,
          settings: { results },
          options: [],
        }],
      },
    },
    audience_count: 1,
    aggregates,
    questions: [],
    my_responses: [],
  };
}

const aggregate = {
  cue_run_id: "run-1",
  interaction_id: "interaction-1",
  aggregate: { interaction_type: "single_choice", total_responses: 1 },
};

describe("rememberCueLive", () => {
  it("keeps a revealed aggregate through a transient empty refresh", () => {
    const cache: Record<string, LiveView> = {};
    rememberCueLive(cache, view("revealed", { background_question: false, publish_results: true }, [aggregate]));
    const refreshed = rememberCueLive(cache, view("revealed", { background_question: false, publish_results: true }));
    expect(refreshed.aggregates).toEqual([aggregate]);
  });

  it("does not restore results after publication is disabled", () => {
    const cache: Record<string, LiveView> = {};
    rememberCueLive(cache, view("revealed", { background_question: false, publish_results: true }, [aggregate]));
    const refreshed = rememberCueLive(cache, view("revealed", { background_question: false, publish_results: false }));
    expect(refreshed.aggregates).toEqual([]);
  });

  it("does not restore revealed results while a cue is collecting responses", () => {
    const cache: Record<string, LiveView> = {};
    rememberCueLive(cache, view("revealed", { background_question: false, publish_results: true }, [aggregate]));
    const refreshed = rememberCueLive(cache, view("open", { background_question: false, publish_results: true }));
    expect(refreshed.aggregates).toEqual([]);
  });

  it("does not restore an aggregate after the interaction definition changes", () => {
    const cache: Record<string, LiveView> = {};
    rememberCueLive(cache, view("revealed", { background_question: false, publish_results: true }, [aggregate]));
    const refreshed = view("revealed", { background_question: false, publish_results: true });
    const interaction = refreshed.snapshot.current_cue_run?.interactions[0];
    if (interaction) interaction.prompt = "Updated prompt";
    expect(rememberCueLive(cache, refreshed).aggregates).toEqual([]);
  });

  it("does not revive a question after moderation hides the final visible card", () => {
    const cache: Record<string, LiveView> = {};
    const populated = view("revealed", { background_question: false, publish_results: true });
    populated.questions = [{
      id: "question-1",
      cue_run_id: "run-1",
      interaction_id: "interaction-1",
      body: "Please explain this",
      display_name: null,
      status: "visible",
      votes: 1,
      voted_by_me: false,
      created_at: "2026-09-01T00:00:00Z",
    }];
    rememberCueLive(cache, populated);

    const moderated = rememberCueLive(
      cache,
      view("revealed", { background_question: false, publish_results: true }),
    );

    expect(moderated.questions).toEqual([]);
  });
});

describe("live refresh ordering", () => {
  it("ignores an older request that completes after a newer request", () => {
    const order = createLiveRefreshOrder();
    const earlier = beginLiveRefresh(order);
    const later = beginLiveRefresh(order);
    expect(shouldApplyLiveRefresh(order, later)).toBe(true);
    expect(shouldApplyLiveRefresh(order, earlier)).toBe(false);
  });

  it("applies requests that complete in their original order", () => {
    const order = createLiveRefreshOrder();
    const earlier = beginLiveRefresh(order);
    const later = beginLiveRefresh(order);
    expect(shouldApplyLiveRefresh(order, earlier)).toBe(true);
    expect(shouldApplyLiveRefresh(order, later)).toBe(true);
  });
});

describe("live refresh scheduling", () => {
  it("coalesces overlapping triggers into one trailing refresh", async () => {
    const scheduler = createLiveRefreshScheduler();
    let releaseFirst: () => void = () => undefined;
    const firstRequest = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let requestCount = 0;
    const refresh = () => scheduleLiveRefresh(scheduler, "session-1", async () => {
      requestCount += 1;
      if (requestCount === 1) await firstRequest;
    });

    const first = refresh();
    const second = refresh();
    const third = refresh();

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(requestCount).toBe(1);
    releaseFirst();
    await first;
    expect(requestCount).toBe(2);
  });
});
