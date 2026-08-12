use serde::{Deserialize, Serialize};

use crate::{StateMachineError, StateTransition, state_machine::apply_versioned};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LiveSessionState {
    Draft,
    Lobby,
    Live,
    Paused,
    Ended,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LiveSessionAction {
    OpenLobby,
    Start,
    Pause,
    Resume,
    End,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct LiveSessionMachine {
    state: LiveSessionState,
    state_version: u64,
}

impl Default for LiveSessionMachine {
    fn default() -> Self {
        Self::new()
    }
}

impl LiveSessionMachine {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            state: LiveSessionState::Draft,
            state_version: 0,
        }
    }

    #[must_use]
    pub const fn state(&self) -> LiveSessionState {
        self.state
    }

    #[must_use]
    pub const fn state_version(&self) -> u64 {
        self.state_version
    }

    pub fn apply(
        &mut self,
        expected_version: u64,
        action: LiveSessionAction,
    ) -> Result<StateTransition<LiveSessionState>, StateMachineError> {
        apply_versioned(
            &mut self.state,
            &mut self.state_version,
            expected_version,
            |state| next_state(state, action),
        )
    }
}

fn next_state(
    state: LiveSessionState,
    action: LiveSessionAction,
) -> Result<LiveSessionState, StateMachineError> {
    match (state, action) {
        (LiveSessionState::Draft, LiveSessionAction::OpenLobby) => Ok(LiveSessionState::Lobby),
        (LiveSessionState::Lobby, LiveSessionAction::Start)
        | (LiveSessionState::Paused, LiveSessionAction::Resume) => Ok(LiveSessionState::Live),
        (LiveSessionState::Live, LiveSessionAction::Pause) => Ok(LiveSessionState::Paused),
        (LiveSessionState::Live | LiveSessionState::Paused, LiveSessionAction::End) => {
            Ok(LiveSessionState::Ended)
        }
        _ => Err(StateMachineError::InvalidTransition {
            machine: "live_session",
            state: state.as_str(),
            action: action.as_str(),
        }),
    }
}

impl LiveSessionState {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Lobby => "lobby",
            Self::Live => "live",
            Self::Paused => "paused",
            Self::Ended => "ended",
        }
    }
}

impl LiveSessionAction {
    const fn as_str(self) -> &'static str {
        match self {
            Self::OpenLobby => "open_lobby",
            Self::Start => "start",
            Self::Pause => "pause",
            Self::Resume => "resume",
            Self::End => "end",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{LiveSessionAction, LiveSessionMachine, LiveSessionState};
    use crate::StateMachineError;

    #[test]
    fn session_moves_through_lobby_live_pause_resume_and_end() {
        let mut session = LiveSessionMachine::new();

        assert_eq!(
            session
                .apply(0, LiveSessionAction::OpenLobby)
                .unwrap()
                .current,
            LiveSessionState::Lobby
        );
        assert_eq!(
            session.apply(1, LiveSessionAction::Start).unwrap().current,
            LiveSessionState::Live
        );
        assert_eq!(
            session.apply(2, LiveSessionAction::Pause).unwrap().current,
            LiveSessionState::Paused
        );
        assert_eq!(
            session.apply(3, LiveSessionAction::Resume).unwrap().current,
            LiveSessionState::Live
        );
        assert_eq!(
            session.apply(4, LiveSessionAction::End).unwrap().current,
            LiveSessionState::Ended
        );
        assert_eq!(session.state_version(), 5);
    }

    #[test]
    fn paused_session_can_end_without_resuming() {
        let mut session = LiveSessionMachine::new();
        session.apply(0, LiveSessionAction::OpenLobby).unwrap();
        session.apply(1, LiveSessionAction::Start).unwrap();
        session.apply(2, LiveSessionAction::Pause).unwrap();

        assert_eq!(
            session.apply(3, LiveSessionAction::End).unwrap().current,
            LiveSessionState::Ended
        );
    }

    #[test]
    fn invalid_transition_does_not_change_state_or_version() {
        let mut session = LiveSessionMachine::new();
        let result = session.apply(0, LiveSessionAction::Start);

        assert!(matches!(
            result,
            Err(StateMachineError::InvalidTransition {
                machine: "live_session",
                state: "draft",
                action: "start",
            })
        ));
        assert_eq!(session.state(), LiveSessionState::Draft);
        assert_eq!(session.state_version(), 0);
    }

    #[test]
    fn stale_transition_is_rejected_before_business_rules() {
        let mut session = LiveSessionMachine::new();
        session.apply(0, LiveSessionAction::OpenLobby).unwrap();

        assert_eq!(
            session.apply(0, LiveSessionAction::Start),
            Err(StateMachineError::VersionConflict {
                expected_version: 0,
                actual_version: 1,
            })
        );
        assert_eq!(session.state(), LiveSessionState::Lobby);
    }
}
