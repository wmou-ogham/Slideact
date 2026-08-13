import assert from "node:assert/strict";

const baseUrl = process.env.API_BASE_URL ?? "http://api:8080";
const participantCount = Number(process.env.LOAD_PARTICIPANTS ?? 100);
const relaxedP95Ms = Number(process.env.LOAD_RELAXED_P95_MS ?? 5000);

const guest = await fetch(`${baseUrl}/api/auth/guest`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ locale: "en" }),
});
assert.equal(guest.status, 201);
const cookie = guest.headers.get("set-cookie").split(";", 1)[0];

const project = await request("/api/projects", {
  method: "POST",
  cookie,
  body: { title: "100-person benchmark", default_locale: "en" },
});
const cue = await request(`/api/projects/${project.id}/cues`, {
  method: "POST",
  cookie,
  body: {
    name: "Load understanding check",
    anchor_type: "manual",
    anchor_value: null,
    trigger_mode: "presenter_confirm",
    delay_seconds: 0,
  },
});
const interaction = await request(
  `/api/projects/${project.id}/cues/${cue.id}/interactions`,
  {
    method: "POST",
    cookie,
    body: {
      interaction_type: "understanding",
      prompt: "Does the benchmark make sense?",
      description: null,
      settings: {
        schema_version: 1,
        results: { audience_visibility: "live" },
      },
      options: [],
    },
  },
);
const session = await request(`/api/projects/${project.id}/sessions`, {
  method: "POST",
  cookie,
  body: { locale: "en" },
});
let snapshot = await command(session.id, cookie, 0, "load:open-lobby", { type: "open_lobby" });
const joinCode = snapshot.join_code;
snapshot = await command(session.id, cookie, 1, "load:start", { type: "start" });
snapshot = await command(session.id, cookie, 2, "load:prepare", { type: "prepare_cue", cue_id: cue.id });
snapshot = await command(session.id, cookie, 3, "load:open", { type: "open_cue" });
const cueRunId = snapshot.current_cue_run.id;

const joinStarted = performance.now();
const joined = await Promise.all(
  Array.from({ length: participantCount }, async (_, index) => {
    const started = performance.now();
    const body = await request("/api/audience/join", {
      method: "POST",
      body: { join_code: joinCode, locale: index % 2 ? "en" : "zh-TW", participant_key: null },
    });
    return { ...body, duration: performance.now() - started };
  }),
);
const joinTotalMs = performance.now() - joinStarted;

const responseStarted = performance.now();
const submitted = await Promise.all(
  joined.map(async (participant, index) => {
    const started = performance.now();
    await request(`/api/audience/interactions/${interaction.id}/responses`, {
      method: "POST",
      token: participant.token,
      body: {
        cue_run_id: cueRunId,
        idempotency_key: `load:understanding:${index}`,
        payload: { understood: index % 5 !== 0 },
      },
    });
    return performance.now() - started;
  }),
);
const responseTotalMs = performance.now() - responseStarted;

const live = await request(`/api/live/sessions/${session.id}`, { token: joined[0].token });
assert.equal(live.audience_count, participantCount);
assert.equal(live.aggregates.length, 1);
assert.equal(live.aggregates[0].aggregate.total_responses, participantCount);

const joinP95Ms = percentile(joined.map((value) => value.duration), 0.95);
const responseP95Ms = percentile(submitted, 0.95);
assert.ok(joinP95Ms < relaxedP95Ms, `join p95 ${joinP95Ms}ms exceeded ${relaxedP95Ms}ms`);
assert.ok(responseP95Ms < relaxedP95Ms, `response p95 ${responseP95Ms}ms exceeded ${relaxedP95Ms}ms`);
console.log(JSON.stringify({
  benchmark: "audience-100",
  participants: participantCount,
  join_total_ms: Math.round(joinTotalMs),
  join_p95_ms: Math.round(joinP95Ms),
  response_total_ms: Math.round(responseTotalMs),
  response_p95_ms: Math.round(responseP95Ms),
  aggregate_total: live.aggregates[0].aggregate.total_responses,
}));
console.log("100-person audience benchmark passed");

async function request(path, { method = "GET", cookie, token, body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  assert.ok(response.ok, `${method} ${path} failed: ${response.status} ${JSON.stringify(result)}`);
  return result;
}

async function command(sessionId, cookie, expectedVersion, idempotencyKey, commandBody) {
  const result = await request(`/api/sessions/${sessionId}/commands`, {
    method: "POST",
    cookie,
    body: { idempotency_key: idempotencyKey, expected_version: expectedVersion, command: commandBody },
  });
  return result.snapshot;
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}
