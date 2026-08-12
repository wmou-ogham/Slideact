import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const baseUrl = process.env.API_BASE_URL ?? "http://api:8080";
const websocketUrl = process.env.WS_URL ?? "ws://api:8080/api/ws";
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://slide_helper:slide_helper_dev_only@postgres:5432/slide_helper";
const sessionId = "a5000000-0000-0000-0000-000000000001";
const ownerCookie = "slide_helper_session=ci-owner-session";
const realtimeEventId = "af000000-0000-0000-0000-000000000001";
const outboxEventId = "af100000-0000-0000-0000-000000000001";

const readiness = await fetch(`${baseUrl}/health/ready`);
assert.equal(readiness.status, 200);
assert.deepEqual(await readiness.json(), {
  status: "ready",
  database: true,
  redis: true,
});

const anonymousMe = await fetch(`${baseUrl}/api/auth/me`);
assert.equal(anonymousMe.status, 401);
assert.deepEqual(await anonymousMe.json(), { code: "authentication_required" });

const authStart = await fetch(`${baseUrl}/api/auth/google/start`, {
  redirect: "manual",
});
assert.equal(authStart.status, 503);
assert.deepEqual(await authStart.json(), { code: "auth_not_configured" });

const strangerIssue = await issueToken(
  "presenter",
  "slide_helper_session=ci-stranger-session",
);
assert.equal(strangerIssue.response.status, 404);
assert.deepEqual(strangerIssue.body, { code: "session_not_found" });

const presenterIssue = await issueToken("presenter", ownerCookie);
assert.equal(presenterIssue.response.status, 201);
assert.equal(presenterIssue.body.role, "presenter");
assert.equal(presenterIssue.body.session_id, sessionId);
assert.equal(presenterIssue.body.topic, `session:${sessionId}:presenter`);
assert.match(presenterIssue.body.token, /^[A-Za-z0-9_-]{43}$/);

const audienceIssue = await issueToken("audience", ownerCookie);
assert.equal(audienceIssue.response.status, 201);
assert.equal(audienceIssue.body.topic, `session:${sessionId}:audience`);

const presenter = await connect(
  `${websocketUrl}?token=${presenterIssue.body.token}`,
);
const audience = await connect(`${websocketUrl}?token=${audienceIssue.body.token}`);

const pong = waitForMessage(presenter, (message) => message.type === "pong");
presenter.send(JSON.stringify({ type: "ping", request_id: "smoke-ping" }));
assert.deepEqual(await pong, { type: "pong", request_id: "smoke-ping" });

const presenterSubscribed = waitForMessage(
  presenter,
  (message) => message.type === "subscribed",
);
presenter.send(
  JSON.stringify({
    type: "subscribe",
    topic: `session:${sessionId}:presenter`,
  }),
);
assert.deepEqual(await presenterSubscribed, {
  type: "subscribed",
  topic: `session:${sessionId}:presenter`,
});

const forbidden = waitForMessage(
  audience,
  (message) => message.type === "error",
);
audience.send(
  JSON.stringify({
    type: "subscribe",
    topic: `session:${sessionId}:presenter`,
  }),
);
assert.deepEqual(await forbidden, {
  type: "error",
  code: "realtime_topic_forbidden",
});

const audienceSubscribed = waitForMessage(
  audience,
  (message) => message.type === "subscribed",
);
audience.send(
  JSON.stringify({
    type: "subscribe",
    topic: `session:${sessionId}:audience`,
  }),
);
assert.deepEqual(await audienceSubscribed, {
  type: "subscribed",
  topic: `session:${sessionId}:audience`,
});

const liveEvent = waitForMessage(
  audience,
  (message) =>
    message.type === "event" && message.event.event_id === realtimeEventId,
  8000,
);
enqueueAudienceCountEvent();
assertRealtimeEvent(await liveEvent);
await waitForOutboxPublished();

const replayAudience = await connect(
  `${websocketUrl}?token=${audienceIssue.body.token}`,
);
const replaySubscribed = waitForMessage(
  replayAudience,
  (message) => message.type === "subscribed",
);
const replayEvent = waitForMessage(
  replayAudience,
  (message) =>
    message.type === "event" && message.event.event_id === realtimeEventId,
);
replayAudience.send(
  JSON.stringify({
    type: "subscribe",
    topic: `session:${sessionId}:audience`,
    after_sequence: 0,
  }),
);
assert.deepEqual(await replaySubscribed, {
  type: "subscribed",
  topic: `session:${sessionId}:audience`,
});
assertRealtimeEvent(await replayEvent);
replayAudience.close();

const broadcastRejected = waitForMessage(
  presenter,
  (message) => message.type === "error",
);
presenter.send(
  JSON.stringify({
    type: "broadcast",
    topic: `session:${sessionId}:presenter`,
    payload: { slide: 5 },
  }),
);
assert.deepEqual(await broadcastRejected, {
  type: "error",
  code: "client_broadcast_forbidden",
});

const revokedSocket = waitForMessage(
  audience,
  (message) => message.type === "error" && message.code === "session_token_invalid",
  8000,
);
const revoke = await fetch(
  `${baseUrl}/api/sessions/${sessionId}/tokens/${audienceIssue.body.id}`,
  { method: "DELETE", headers: { cookie: ownerCookie } },
);
assert.equal(revoke.status, 204);
assert.deepEqual(await revokedSocket, {
  type: "error",
  code: "session_token_invalid",
});
await assert.rejects(
  connect(`${websocketUrl}?token=${audienceIssue.body.token}`),
  /WebSocket/,
);

presenter.close();
audience.close();
console.log("API and WebSocket smoke test passed");

async function issueToken(role, cookie) {
  const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ role }),
  });
  return { response, body: await response.json() };
}

function enqueueAudienceCountEvent() {
  const sql = `
    SELECT enqueue_session_event(
      '${realtimeEventId}',
      '${outboxEventId}',
      '${sessionId}',
      1,
      1,
      'session:${sessionId}:audience',
      '{"event_type":"audience.count_updated","count":42}'::jsonb
    );
  `;
  execFileSync("psql", [
    databaseUrl,
    "--no-psqlrc",
    "--set=ON_ERROR_STOP=1",
    "--quiet",
    "--command",
    sql,
  ]);
}

function assertRealtimeEvent(message) {
  assert.equal(message.type, "event");
  assert.equal(message.topic, `session:${sessionId}:audience`);
  assert.equal(message.event.schema_version, 1);
  assert.equal(message.event.event_id, realtimeEventId);
  assert.equal(message.event.session_id, sessionId);
  assert.equal(message.event.sequence, 1);
  assert.equal(message.event.state_version, 1);
  assert.equal(message.event.event_type, "audience.count_updated");
  assert.match(message.event.occurred_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(message.event.event, {
    event_type: "audience.count_updated",
    count: 42,
  });
}

async function waitForOutboxPublished() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const published = execFileSync(
      "psql",
      [
        databaseUrl,
        "--no-psqlrc",
        "--set=ON_ERROR_STOP=1",
        "--tuples-only",
        "--no-align",
        "--command",
        `SELECT published_at IS NOT NULL FROM outbox_events WHERE id = '${outboxEventId}';`,
      ],
      { encoding: "utf8" },
    ).trim();
    if (published === "t") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("outbox event was not marked as published");
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error("WebSocket connect timeout")), 5000);

    socket.addEventListener("message", function onMessage(event) {
      const message = JSON.parse(event.data);
      if (message.type === "connected") {
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        resolve(socket);
      }
    });
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("WebSocket error"));
      },
      { once: true },
    );
  });
}

function waitForMessage(socket, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("WebSocket message timeout")),
      timeoutMs,
    );

    function onMessage(event) {
      const message = JSON.parse(event.data);
      if (predicate(message)) {
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        resolve(message);
      }
    }

    socket.addEventListener("message", onMessage);
  });
}
