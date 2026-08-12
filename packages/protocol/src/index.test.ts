import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type JsonValue,
  type ServerMessage,
} from "./index";

describe("generated protocol", () => {
  it("exports the Rust protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(1);
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
});
