import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type JsonValue,
  type RealtimeEventEnvelope,
  type ServerMessage,
} from "./index";

describe("generated protocol", () => {
  it("exports the Rust protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(2);
  });

  it("models tagged WebSocket messages and JSON payloads", () => {
    const payload = { slide: 5, understood: true } satisfies JsonValue;
    const outbound = {
      type: "broadcast",
      topic: "position",
      payload,
    } satisfies ClientMessage;
    const inbound = {
      type: "connected",
      protocol_version: PROTOCOL_VERSION,
    } satisfies ServerMessage;

    expect(outbound.type).toBe("broadcast");
    expect(inbound.protocol_version).toBe(PROTOCOL_VERSION);
  });

  it("models typed, sequenced realtime events", () => {
    const event = {
      schema_version: 1,
      event_id: "event-1",
      session_id: "session-1",
      sequence: 7,
      state_version: 9,
      occurred_at: "2026-08-13T00:00:00Z",
      event_type: "audience.count_updated",
      event: {
        event_type: "audience.count_updated",
        count: 42,
      },
    } satisfies RealtimeEventEnvelope;
    const inbound = {
      type: "event",
      topic: "session:session-1:audience",
      event,
    } satisfies ServerMessage;

    expect(inbound.event.sequence).toBe(7);
    expect(inbound.event.event.event_type).toBe("audience.count_updated");
  });
});
