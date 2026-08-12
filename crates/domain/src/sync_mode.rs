use serde::{Deserialize, Serialize};

use crate::{StateMachineError, StateTransition, state_machine::apply_versioned};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncModeState {
    AutoConnected,
    AutoPaused,
    Manual,
    Disconnected,
    ResyncRequired,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncModeAction {
    PauseAuto,
    ResumeAuto,
    SwitchToManual,
    ExtensionDisconnected,
    ExtensionReconnected,
    ConfirmAutoResync,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct SyncModeMachine {
    state: SyncModeState,
    state_version: u64,
}

impl Default for SyncModeMachine {
    fn default() -> Self {
        Self::new_auto_connected()
    }
}

impl SyncModeMachine {
    #[must_use]
    pub const fn new_auto_connected() -> Self {
        Self {
            state: SyncModeState::AutoConnected,
            state_version: 0,
        }
    }

    #[must_use]
    pub const fn new_manual() -> Self {
        Self {
            state: SyncModeState::Manual,
            state_version: 0,
        }
    }

    #[must_use]
    pub const fn state(&self) -> SyncModeState {
        self.state
    }

    #[must_use]
    pub const fn state_version(&self) -> u64 {
        self.state_version
    }

    pub fn apply(
        &mut self,
        expected_version: u64,
        action: SyncModeAction,
    ) -> Result<StateTransition<SyncModeState>, StateMachineError> {
        apply_versioned(
            &mut self.state,
            &mut self.state_version,
            expected_version,
            |state| next_state(state, action),
        )
    }
}

fn next_state(
    state: SyncModeState,
    action: SyncModeAction,
) -> Result<SyncModeState, StateMachineError> {
    match (state, action) {
        (SyncModeState::AutoConnected, SyncModeAction::PauseAuto) => Ok(SyncModeState::AutoPaused),
        (SyncModeState::AutoPaused, SyncModeAction::ResumeAuto)
        | (SyncModeState::ResyncRequired, SyncModeAction::ConfirmAutoResync) => {
            Ok(SyncModeState::AutoConnected)
        }
        (
            SyncModeState::AutoConnected
            | SyncModeState::AutoPaused
            | SyncModeState::Disconnected
            | SyncModeState::ResyncRequired,
            SyncModeAction::SwitchToManual,
        ) => Ok(SyncModeState::Manual),
        (
            SyncModeState::AutoConnected | SyncModeState::AutoPaused,
            SyncModeAction::ExtensionDisconnected,
        ) => Ok(SyncModeState::Disconnected),
        (
            SyncModeState::Disconnected | SyncModeState::Manual,
            SyncModeAction::ExtensionReconnected,
        ) => Ok(SyncModeState::ResyncRequired),
        _ => Err(StateMachineError::InvalidTransition {
            machine: "sync_mode",
            state: state.as_str(),
            action: action.as_str(),
        }),
    }
}

impl SyncModeState {
    const fn as_str(self) -> &'static str {
        match self {
            Self::AutoConnected => "auto_connected",
            Self::AutoPaused => "auto_paused",
            Self::Manual => "manual",
            Self::Disconnected => "disconnected",
            Self::ResyncRequired => "resync_required",
        }
    }
}

impl SyncModeAction {
    const fn as_str(self) -> &'static str {
        match self {
            Self::PauseAuto => "pause_auto",
            Self::ResumeAuto => "resume_auto",
            Self::SwitchToManual => "switch_to_manual",
            Self::ExtensionDisconnected => "extension_disconnected",
            Self::ExtensionReconnected => "extension_reconnected",
            Self::ConfirmAutoResync => "confirm_auto_resync",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{SyncModeAction, SyncModeMachine, SyncModeState};
    use crate::StateMachineError;

    #[test]
    fn auto_mode_can_pause_and_resume() {
        let mut sync = SyncModeMachine::new_auto_connected();

        assert_eq!(
            sync.apply(0, SyncModeAction::PauseAuto).unwrap().current,
            SyncModeState::AutoPaused
        );
        assert_eq!(
            sync.apply(1, SyncModeAction::ResumeAuto).unwrap().current,
            SyncModeState::AutoConnected
        );
    }

    #[test]
    fn disconnect_can_switch_to_manual_without_losing_position_authority() {
        let mut sync = SyncModeMachine::new_auto_connected();
        sync.apply(0, SyncModeAction::ExtensionDisconnected)
            .unwrap();

        assert_eq!(
            sync.apply(1, SyncModeAction::SwitchToManual)
                .unwrap()
                .current,
            SyncModeState::Manual
        );
    }

    #[test]
    fn reconnect_requires_presenter_confirmation_before_auto_resumes() {
        let mut sync = SyncModeMachine::new_auto_connected();
        sync.apply(0, SyncModeAction::ExtensionDisconnected)
            .unwrap();
        sync.apply(1, SyncModeAction::SwitchToManual).unwrap();

        assert_eq!(
            sync.apply(2, SyncModeAction::ExtensionReconnected)
                .unwrap()
                .current,
            SyncModeState::ResyncRequired
        );
        assert_eq!(
            sync.apply(3, SyncModeAction::ConfirmAutoResync)
                .unwrap()
                .current,
            SyncModeState::AutoConnected
        );
    }

    #[test]
    fn resync_can_explicitly_remain_manual() {
        let mut sync = SyncModeMachine::new_manual();
        sync.apply(0, SyncModeAction::ExtensionReconnected).unwrap();

        assert_eq!(
            sync.apply(1, SyncModeAction::SwitchToManual)
                .unwrap()
                .current,
            SyncModeState::Manual
        );
    }

    #[test]
    fn invalid_transition_does_not_change_authority() {
        let mut sync = SyncModeMachine::new_manual();

        assert!(matches!(
            sync.apply(0, SyncModeAction::PauseAuto),
            Err(StateMachineError::InvalidTransition { .. })
        ));
        assert_eq!(sync.state(), SyncModeState::Manual);
        assert_eq!(sync.state_version(), 0);
    }
}
