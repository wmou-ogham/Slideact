//! Core business rules for Slide Helper.

mod cue_run;
mod live_session;
mod slide_anchor;
mod state_machine;
mod sync_mode;

pub use cue_run::{CueRunAction, CueRunMachine, CueRunState};
pub use live_session::{LiveSessionAction, LiveSessionMachine, LiveSessionState};
pub use slide_anchor::{cue_matches_position, normalize_slide_anchor, position_match_keys};
pub use state_machine::{StateMachineError, StateTransition};
pub use sync_mode::{SyncModeAction, SyncModeMachine, SyncModeState};

/// Identifies the current development milestone.
pub const CURRENT_MILESTONE: &str = "M1";
