//! Versioned HTTP and WebSocket payloads shared by the Rust services.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Current wire protocol version.
pub const PROTOCOL_VERSION: u16 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HealthResponse {
    pub status: String,
    pub service: String,
    pub protocol_version: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReadinessResponse {
    pub status: String,
    pub database: bool,
    pub redis: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    Ping { request_id: String },
    Broadcast { topic: String, payload: Value },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    Connected { protocol_version: u16 },
    Pong { request_id: String },
    Broadcast { topic: String, payload: Value },
    Error { code: String },
}

#[cfg(test)]
mod tests {
    use super::{ClientMessage, PROTOCOL_VERSION, ServerMessage};
    use serde_json::json;

    #[test]
    fn websocket_messages_use_versioned_tagged_json() {
        let encoded = serde_json::to_value(ServerMessage::Connected {
            protocol_version: PROTOCOL_VERSION,
        })
        .expect("message should serialize");

        assert_eq!(encoded, json!({"type": "connected", "protocol_version": 1}));
    }

    #[test]
    fn client_broadcast_round_trips() {
        let message = ClientMessage::Broadcast {
            topic: "m0".to_owned(),
            payload: json!({"slide": 5}),
        };
        let encoded = serde_json::to_string(&message).expect("message should serialize");
        let decoded: ClientMessage =
            serde_json::from_str(&encoded).expect("message should deserialize");

        assert_eq!(decoded, message);
    }
}
