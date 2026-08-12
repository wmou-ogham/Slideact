import assert from "node:assert/strict";

const baseUrl = process.env.API_BASE_URL ?? "http://api:8080";
const websocketUrl = process.env.WS_URL ?? "ws://api:8080/api/ws";

const readiness = await fetch(`${baseUrl}/health/ready`);
assert.equal(readiness.status, 200);
assert.deepEqual(await readiness.json(), {
  status: "ready",
  database: true,
  redis: true,
});

const first = await connect(websocketUrl);
const second = await connect(websocketUrl);

const pong = waitForMessage(first, (message) => message.type === "pong");
first.send(JSON.stringify({ type: "ping", request_id: "smoke-ping" }));
assert.deepEqual(await pong, { type: "pong", request_id: "smoke-ping" });

const broadcast = waitForMessage(
  second,
  (message) => message.type === "broadcast" && message.topic === "m0",
);
first.send(
  JSON.stringify({
    type: "broadcast",
    topic: "m0",
    payload: { slide: 5 },
  }),
);
assert.deepEqual(await broadcast, {
  type: "broadcast",
  topic: "m0",
  payload: { slide: 5 },
});

first.close();
second.close();
console.log("API and WebSocket smoke test passed");

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
    socket.addEventListener("error", () => reject(new Error("WebSocket error")), {
      once: true,
    });
  });
}

function waitForMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket message timeout")), 5000);

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
