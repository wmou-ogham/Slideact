import assert from "node:assert/strict";

const baseUrl = process.env.API_BASE_URL ?? "http://api:8080";
const websocketUrl = process.env.WS_URL ?? "ws://api:8080/api/ws";
const sessionId = "a5000000-0000-0000-0000-000000000001";
const ownerCookie = "slide_helper_session=ci-owner-session";

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
