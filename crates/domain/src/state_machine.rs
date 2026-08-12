use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct StateTransition<S> {
    pub previous: S,
    pub current: S,
    pub state_version: u64,
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum StateMachineError {
    #[error("state version conflict: expected {expected_version}, actual {actual_version}")]
    VersionConflict {
        expected_version: u64,
        actual_version: u64,
    },
    #[error("invalid {machine} transition from {state} using {action}")]
    InvalidTransition {
        machine: &'static str,
        state: &'static str,
        action: &'static str,
    },
    #[error("a revealed cue cannot reopen in place; create a new cue run")]
    NewCueRunRequired,
    #[error("state version overflow")]
    VersionOverflow,
}

pub(crate) fn apply_versioned<S: Copy>(
    state: &mut S,
    state_version: &mut u64,
    expected_version: u64,
    next: impl FnOnce(S) -> Result<S, StateMachineError>,
) -> Result<StateTransition<S>, StateMachineError> {
    if expected_version != *state_version {
        return Err(StateMachineError::VersionConflict {
            expected_version,
            actual_version: *state_version,
        });
    }

    let previous = *state;
    let current = next(previous)?;
    let next_version = state_version
        .checked_add(1)
        .ok_or(StateMachineError::VersionOverflow)?;

    *state = current;
    *state_version = next_version;

    Ok(StateTransition {
        previous,
        current,
        state_version: next_version,
    })
}

#[cfg(test)]
mod tests {
    use super::{StateMachineError, apply_versioned};

    #[test]
    fn version_conflict_does_not_evaluate_or_mutate_transition() {
        let mut state = 1_u8;
        let mut version = 3_u64;
        let result = apply_versioned(&mut state, &mut version, 2, |_| -> Result<u8, _> {
            panic!("transition must not run for stale commands")
        });

        assert_eq!(
            result,
            Err(StateMachineError::VersionConflict {
                expected_version: 2,
                actual_version: 3,
            })
        );
        assert_eq!(state, 1);
        assert_eq!(version, 3);
    }

    #[test]
    fn overflow_does_not_mutate_state() {
        let mut state = 1_u8;
        let mut version = u64::MAX;
        let result = apply_versioned(&mut state, &mut version, u64::MAX, |_| Ok(2));

        assert_eq!(result, Err(StateMachineError::VersionOverflow));
        assert_eq!(state, 1);
        assert_eq!(version, u64::MAX);
    }
}
