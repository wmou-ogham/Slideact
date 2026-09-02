//! Versioned HTTP and WebSocket payloads shared by the Rust services.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::{Config, TS};

/// Current wire protocol version.
pub const PROTOCOL_VERSION: u16 = 2;

/// Current persisted realtime event envelope version.
pub const EVENT_SCHEMA_VERSION: u16 = 1;

/// Redis channel used by workers to fan persisted events out to API instances.
pub const REALTIME_REDIS_CHANNEL: &str = "slide-helper:realtime:v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct HealthResponse {
    pub status: String,
    pub service: String,
    pub protocol_version: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct ReadinessResponse {
    pub status: String,
    pub database: bool,
    pub redis: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    Ping {
        request_id: String,
    },
    Subscribe {
        topic: String,
        #[serde(default)]
        #[ts(optional, type = "number")]
        after_sequence: Option<u64>,
    },
    Broadcast {
        topic: String,
        #[ts(type = "JsonValue")]
        payload: Value,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
pub struct RealtimeEventEnvelope {
    pub schema_version: u16,
    pub event_id: String,
    pub session_id: String,
    #[ts(type = "number")]
    pub sequence: u64,
    #[ts(type = "number")]
    pub state_version: u64,
    pub occurred_at: String,
    pub event_type: String,
    pub event: RealtimeEvent,
}

impl RealtimeEventEnvelope {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.schema_version != EVENT_SCHEMA_VERSION {
            return Err("unsupported event schema version");
        }
        if self.sequence == 0 {
            return Err("event sequence must be positive");
        }
        if self.event_type != self.event.event_type() {
            return Err("event type does not match payload");
        }
        if self.event_id.trim().is_empty()
            || self.session_id.trim().is_empty()
            || self.occurred_at.trim().is_empty()
        {
            return Err("event envelope identifiers and timestamp are required");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(tag = "event_type")]
pub enum RealtimeEvent {
    #[serde(rename = "session.state_changed")]
    SessionStateChanged {
        status: String,
        sync_mode: String,
        current_cue_run_id: Option<String>,
    },
    #[serde(rename = "session.interface_theme_changed")]
    SessionInterfaceThemeChanged { interface_theme: String },
    #[serde(rename = "cue.state_changed")]
    CueStateChanged { cue_run_id: String, state: String },
    #[serde(rename = "presentation.position_changed")]
    PresentationPositionChanged {
        provider: String,
        deck_external_id: String,
        slide_external_id: Option<String>,
        slide_index: u32,
        sync_mode: String,
    },
    #[serde(rename = "interaction.state_changed")]
    InteractionStateChanged {
        cue_run_id: String,
        interaction_id: String,
        state: String,
    },
    #[serde(rename = "response.aggregate_updated")]
    ResponseAggregateUpdated {
        cue_run_id: String,
        interaction_id: String,
        #[ts(type = "JsonValue")]
        aggregate: Value,
    },
    #[serde(rename = "response.updated")]
    ResponseUpdated {
        cue_run_id: String,
        interaction_id: String,
    },
    #[serde(rename = "audience.count_updated")]
    AudienceCountUpdated { count: u32 },
    #[serde(rename = "question.updated")]
    QuestionUpdated {
        question_id: String,
        status: String,
        vote_count: u32,
    },
}

impl RealtimeEvent {
    #[must_use]
    pub const fn event_type(&self) -> &'static str {
        match self {
            Self::SessionStateChanged { .. } => "session.state_changed",
            Self::SessionInterfaceThemeChanged { .. } => "session.interface_theme_changed",
            Self::CueStateChanged { .. } => "cue.state_changed",
            Self::PresentationPositionChanged { .. } => "presentation.position_changed",
            Self::InteractionStateChanged { .. } => "interaction.state_changed",
            Self::ResponseAggregateUpdated { .. } => "response.aggregate_updated",
            Self::ResponseUpdated { .. } => "response.updated",
            Self::AudienceCountUpdated { .. } => "audience.count_updated",
            Self::QuestionUpdated { .. } => "question.updated",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RealtimePublication {
    pub topic: String,
    pub event: RealtimeEventEnvelope,
}

impl RealtimePublication {
    pub fn validate(&self) -> Result<(), &'static str> {
        self.event.validate()?;
        let valid_topics = [
            format!("session:{}:presenter", self.event.session_id),
            format!("session:{}:audience", self.event.session_id),
            format!("session:{}:overlay", self.event.session_id),
        ];
        if !valid_topics.iter().any(|topic| topic == &self.topic) {
            return Err("publication topic does not belong to event session");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    Connected {
        protocol_version: u16,
    },
    Pong {
        request_id: String,
    },
    Subscribed {
        topic: String,
    },
    Event {
        topic: String,
        event: RealtimeEventEnvelope,
    },
    /// Transitional compatibility payload; new server code emits `Event`.
    Broadcast {
        topic: String,
        #[ts(type = "JsonValue")]
        payload: Value,
    },
    Error {
        code: String,
    },
}

/// Generate the committed TypeScript wire contract from the Rust source of truth.
#[must_use]
pub fn typescript_bindings() -> String {
    let config = Config::new();
    let declarations = [
        HealthResponse::decl(&config),
        ReadinessResponse::decl(&config),
        ClientMessage::decl(&config),
        RealtimeEvent::decl(&config),
        RealtimeEventEnvelope::decl(&config),
        ServerMessage::decl(&config),
    ];
    let mut output = format!(
        "// @generated by `cargo run -p slide-helper-protocol --bin export-types`.\n// Do not edit this file by hand.\n\nexport const PROTOCOL_VERSION = {PROTOCOL_VERSION} as const;\n\nexport type JsonPrimitive = null | boolean | number | string;\nexport type JsonValue =\n  | JsonPrimitive\n  | JsonValue[]\n  | {{ [key: string]: JsonValue }};\n\n"
    );

    for declaration in declarations {
        output.push_str("export ");
        output.push_str(&declaration);
        output.push_str("\n\n");
    }

    output
}

#[cfg(test)]
mod tests {
    use super::{
        ClientMessage, EVENT_SCHEMA_VERSION, PROTOCOL_VERSION, RealtimeEvent,
        RealtimeEventEnvelope, RealtimePublication, ServerMessage, typescript_bindings,
    };
    use serde_json::json;

    #[test]
    fn websocket_messages_use_versioned_tagged_json() {
        let encoded = serde_json::to_value(ServerMessage::Connected {
            protocol_version: PROTOCOL_VERSION,
        })
        .expect("message should serialize");

        assert_eq!(encoded, json!({"type": "connected", "protocol_version": 2}));
    }

    #[test]
    fn typed_realtime_event_round_trips_and_validates() {
        let envelope = RealtimeEventEnvelope {
            schema_version: EVENT_SCHEMA_VERSION,
            event_id: "event-1".to_owned(),
            session_id: "session-1".to_owned(),
            sequence: 7,
            state_version: 9,
            occurred_at: "2026-08-13T00:00:00Z".to_owned(),
            event_type: "audience.count_updated".to_owned(),
            event: RealtimeEvent::AudienceCountUpdated { count: 42 },
        };

        assert_eq!(envelope.validate(), Ok(()));
        let encoded = serde_json::to_value(&envelope).expect("event should serialize");
        assert_eq!(
            encoded["event"],
            json!({"event_type": "audience.count_updated", "count": 42})
        );
        let decoded: RealtimeEventEnvelope =
            serde_json::from_value(encoded).expect("event should deserialize");
        assert_eq!(decoded, envelope);
    }

    #[test]
    fn mismatched_event_type_is_rejected() {
        let envelope = RealtimeEventEnvelope {
            schema_version: EVENT_SCHEMA_VERSION,
            event_id: "event-1".to_owned(),
            session_id: "session-1".to_owned(),
            sequence: 1,
            state_version: 1,
            occurred_at: "2026-08-13T00:00:00Z".to_owned(),
            event_type: "question.updated".to_owned(),
            event: RealtimeEvent::AudienceCountUpdated { count: 42 },
        };

        assert_eq!(
            envelope.validate(),
            Err("event type does not match payload")
        );
    }

    #[test]
    fn publication_rejects_cross_session_topic() {
        let publication = RealtimePublication {
            topic: "session:other:audience".to_owned(),
            event: RealtimeEventEnvelope {
                schema_version: EVENT_SCHEMA_VERSION,
                event_id: "event-1".to_owned(),
                session_id: "session-1".to_owned(),
                sequence: 1,
                state_version: 1,
                occurred_at: "2026-08-13T00:00:00Z".to_owned(),
                event_type: "audience.count_updated".to_owned(),
                event: RealtimeEvent::AudienceCountUpdated { count: 42 },
            },
        };

        assert_eq!(
            publication.validate(),
            Err("publication topic does not belong to event session")
        );
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

    #[test]
    fn typescript_contract_contains_version_and_tagged_unions() {
        let bindings = typescript_bindings();

        assert!(bindings.contains("export const PROTOCOL_VERSION = 2 as const"));
        assert!(bindings.contains("export type ClientMessage"));
        assert!(bindings.contains("\"type\": \"ping\""));
        assert!(bindings.contains("\"type\": \"subscribe\""));
        assert!(bindings.contains("\"type\": \"broadcast\""));
        assert!(bindings.contains("after_sequence?: number"));
        assert!(bindings.contains("payload: JsonValue"));
        assert!(bindings.contains("export type RealtimeEvent"));
        assert!(bindings.contains("\"event_type\": \"audience.count_updated\""));
        assert!(bindings.contains("export type RealtimeEventEnvelope"));
        assert!(bindings.contains("export type ServerMessage"));
    }
}
