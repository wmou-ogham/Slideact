import type { SessionResults } from "./types";

export function uniqueCueRuns(runs: SessionResults["cue_runs"]): SessionResults["cue_runs"] {
  const groups = new Map<string, SessionResults["cue_runs"]>();
  const order: string[] = [];
  for (const run of runs) {
    const group = groups.get(run.cue_id);
    if (group) group.push(run);
    else {
      groups.set(run.cue_id, [run]);
      order.push(run.cue_id);
    }
  }
  return order.map((cueId) => collapseCueRuns(groups.get(cueId) ?? []));
}

function collapseCueRuns(runs: SessionResults["cue_runs"]) {
  const [first, ...rest] = runs;
  if (!first) {
    throw new Error("uniqueCueRuns received an empty cue group");
  }
  const primary = rest.reduce((best, run) => {
    const bestScore = cueRunScore(best);
    const score = cueRunScore(run);
    if (score > bestScore) return run;
    if (score === bestScore && run.run_number > best.run_number) return run;
    return best;
  }, first);
  const questions: SessionResults["cue_runs"][number]["questions"] = [];
  const seen = new Set<string>();
  for (const run of runs) {
    for (const question of run.questions) {
      if (seen.has(question.id)) continue;
      seen.add(question.id);
      questions.push(question);
    }
  }
  questions.sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
  return {
    ...primary,
    interactions: primary.interactions.map((interaction) => {
      let aggregate = interaction.aggregate;
      for (const run of runs) {
        const candidate = run.interactions.find((item) => item.id === interaction.id)?.aggregate;
        if (candidate && (candidate.total_responses ?? 0) > (aggregate?.total_responses ?? 0)) {
          aggregate = candidate;
        }
      }
      return { ...interaction, aggregate };
    }),
    questions,
  };
}

function cueRunScore(run: SessionResults["cue_runs"][number]) {
  const responses = run.interactions.reduce((sum, item) => sum + (item.aggregate?.total_responses ?? 0), 0);
  return responses * 1000 + run.questions.length;
}
