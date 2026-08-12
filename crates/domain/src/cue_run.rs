use serde::{Deserialize, Serialize};

use crate::{StateMachineError, StateTransition, state_machine::apply_versioned};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CueRunState {
    Idle,
    Ready,
    Open,
    Closed,
    Revealed,
    Skipped,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CueRunAction {
    Prepare,
    Open,
    Close,
    Reopen,
    Reveal,
    Skip,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct CueRunMachine {
    state: CueRunState,
    state_version: u64,
}

impl Default for CueRunMachine {
    fn default() -> Self {
        Self::new()
    }
}

impl CueRunMachine {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            state: CueRunState::Idle,
            state_version: 0,
        }
    }

    #[must_use]
    pub const fn state(&self) -> CueRunState {
        self.state
    }

    #[must_use]
    pub const fn state_version(&self) -> u64 {
        self.state_version
    }

    pub fn apply(
        &mut self,
        expected_version: u64,
        action: CueRunAction,
    ) -> Result<StateTransition<CueRunState>, StateMachineError> {
        apply_versioned(
            &mut self.state,
            &mut self.state_version,
            expected_version,
            |state| next_state(state, action),
        )
    }
}

fn next_state(state: CueRunState, action: CueRunAction) -> Result<CueRunState, StateMachineError> {
    match (state, action) {
        (CueRunState::Idle, CueRunAction::Prepare) => Ok(CueRunState::Ready),
        (CueRunState::Ready, CueRunAction::Open) | (CueRunState::Closed, CueRunAction::Reopen) => {
            Ok(CueRunState::Open)
        }
        (CueRunState::Open, CueRunAction::Close) => Ok(CueRunState::Closed),
        (CueRunState::Closed, CueRunAction::Reveal) => Ok(CueRunState::Revealed),
        (CueRunState::Ready, CueRunAction::Skip) => Ok(CueRunState::Skipped),
        (CueRunState::Revealed, CueRunAction::Open | CueRunAction::Reopen) => {
            Err(StateMachineError::NewCueRunRequired)
        }
        _ => Err(StateMachineError::InvalidTransition {
            machine: "cue_run",
            state: state.as_str(),
            action: action.as_str(),
        }),
    }
}

impl CueRunState {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Ready => "ready",
            Self::Open => "open",
            Self::Closed => "closed",
            Self::Revealed => "revealed",
            Self::Skipped => "skipped",
        }
    }
}

impl CueRunAction {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Prepare => "prepare",
            Self::Open => "open",
            Self::Close => "close",
            Self::Reopen => "reopen",
            Self::Reveal => "reveal",
            Self::Skip => "skip",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{CueRunAction, CueRunMachine, CueRunState};
    use crate::StateMachineError;

    #[test]
    fn cue_run_can_close_reopen_and_reveal() {
        let mut cue = CueRunMachine::new();
        cue.apply(0, CueRunAction::Prepare).unwrap();
        cue.apply(1, CueRunAction::Open).unwrap();
        cue.apply(2, CueRunAction::Close).unwrap();

        assert_eq!(
            cue.apply(3, CueRunAction::Reopen).unwrap().current,
            CueRunState::Open
        );
        cue.apply(4, CueRunAction::Close).unwrap();
        assert_eq!(
            cue.apply(5, CueRunAction::Reveal).unwrap().current,
            CueRunState::Revealed
        );
    }

    #[test]
    fn prepared_cue_can_be_skipped() {
        let mut cue = CueRunMachine::new();
        cue.apply(0, CueRunAction::Prepare).unwrap();

        assert_eq!(
            cue.apply(1, CueRunAction::Skip).unwrap().current,
            CueRunState::Skipped
        );
    }

    #[test]
    fn revealed_cue_requires_a_new_run_to_reopen() {
        let mut cue = CueRunMachine::new();
        cue.apply(0, CueRunAction::Prepare).unwrap();
        cue.apply(1, CueRunAction::Open).unwrap();
        cue.apply(2, CueRunAction::Close).unwrap();
        cue.apply(3, CueRunAction::Reveal).unwrap();

        assert_eq!(
            cue.apply(4, CueRunAction::Reopen),
            Err(StateMachineError::NewCueRunRequired)
        );
        assert_eq!(cue.state(), CueRunState::Revealed);
        assert_eq!(cue.state_version(), 4);
    }

    #[test]
    fn invalid_transition_does_not_advance_version() {
        let mut cue = CueRunMachine::new();

        assert!(matches!(
            cue.apply(0, CueRunAction::Open),
            Err(StateMachineError::InvalidTransition { .. })
        ));
        assert_eq!(cue.state(), CueRunState::Idle);
        assert_eq!(cue.state_version(), 0);
    }
}
