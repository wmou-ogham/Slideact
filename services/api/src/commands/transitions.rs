use rand::RngCore;
use serde_json::json;
use slide_helper_domain::{
    CueRunAction, CueRunMachine, CueRunState, LiveSessionAction, LiveSessionMachine,
    LiveSessionState, StateMachineError,
};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::api_error::ApiError;

use super::{events::emit_event_to_all, handlers::SessionCommand, persistence_error};

const JOIN_CODE_ALPHABET: &[u8] = b"0123456789";

pub(super) struct LockedSession {
    pub(super) project_id: Uuid,
    pub(super) status: LiveSessionState,
    pub(super) state_version: u64,
    pub(super) sync_mode: String,
    pub(super) current_cue_run_id: Option<Uuid>,
    pub(super) presentation_view: String,
}

pub(super) async fn lock_authorized_session(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
    user_id: Uuid,
) -> Result<LockedSession, ApiError> {
    let row = sqlx::query_as::<_, (Uuid, String, i64, String, Option<Uuid>, String)>(
        r#"
        SELECT live_sessions.project_id, live_sessions.status, live_sessions.state_version,
               live_sessions.sync_mode, live_sessions.current_cue_run_id,
               live_sessions.presentation_view
        FROM live_sessions
        JOIN projects ON projects.id = live_sessions.project_id
        LEFT JOIN project_members
          ON project_members.project_id = projects.id AND project_members.user_id = $2
        WHERE live_sessions.id = $1
          AND (projects.owner_id = $2 OR project_members.user_id IS NOT NULL)
        FOR UPDATE OF live_sessions
        "#,
    )
    .bind(session_id)
    .bind(user_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(persistence_error)?
    .ok_or_else(|| ApiError::not_found("session_not_found"))?;
    Ok(LockedSession {
        project_id: row.0,
        status: parse_session_state(&row.1)?,
        state_version: u64::try_from(row.2)
            .map_err(|_| ApiError::internal("state_version_invalid"))?,
        sync_mode: row.3,
        current_cue_run_id: row.4,
        presentation_view: row.5,
    })
}

pub(super) async fn lock_session(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
) -> Result<LockedSession, ApiError> {
    let row = sqlx::query_as::<_, (Uuid, String, i64, String, Option<Uuid>, String)>(
        r#"
        SELECT project_id, status, state_version, sync_mode, current_cue_run_id, presentation_view
        FROM live_sessions WHERE id = $1 FOR UPDATE
        "#,
    )
    .bind(session_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(persistence_error)?
    .ok_or_else(|| ApiError::not_found("session_not_found"))?;
    Ok(LockedSession {
        project_id: row.0,
        status: parse_session_state(&row.1)?,
        state_version: u64::try_from(row.2)
            .map_err(|_| ApiError::internal("state_version_invalid"))?,
        sync_mode: row.3,
        current_cue_run_id: row.4,
        presentation_view: row.5,
    })
}

pub(super) async fn apply_session_command(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
    locked: &mut LockedSession,
    command: &SessionCommand,
    idempotency_key: &str,
) -> Result<(), ApiError> {
    let action = match command {
        SessionCommand::OpenLobby => LiveSessionAction::OpenLobby,
        SessionCommand::Start => LiveSessionAction::Start,
        SessionCommand::Pause => LiveSessionAction::Pause,
        SessionCommand::Resume => LiveSessionAction::Resume,
        SessionCommand::End => LiveSessionAction::End,
        SessionCommand::ReopenSession => LiveSessionAction::Reopen,
        _ => return Err(ApiError::bad_request("session_command_invalid")),
    };
    if matches!(command, SessionCommand::ReopenSession) {
        let busy = sqlx::query_scalar::<_, bool>(
            r#"
            SELECT EXISTS (
                SELECT 1 FROM live_sessions
                WHERE project_id = $1 AND id <> $2 AND status IN ('lobby', 'live', 'paused')
            )
            "#,
        )
        .bind(locked.project_id)
        .bind(session_id)
        .fetch_one(&mut **transaction)
        .await
        .map_err(persistence_error)?;
        if busy {
            return Err(ApiError::conflict("active_session_exists"));
        }
    }
    let mut machine = LiveSessionMachine::from_parts(locked.status, locked.state_version);
    let transition = machine
        .apply(locked.state_version, action)
        .map_err(state_machine_error)?;
    let status = session_state_name(transition.current);
    let join_code = if matches!(command, SessionCommand::OpenLobby) {
        Some(generate_available_join_code(transaction).await?)
    } else if matches!(command, SessionCommand::ReopenSession) {
        Some(join_code_for_reopen(transaction, session_id).await?)
    } else {
        None
    };
    sqlx::query(
        r#"
        UPDATE live_sessions SET
            status = $2,
            state_version = $3,
            sync_mode = CASE
                WHEN $2 = 'paused' AND sync_mode = 'auto_connected' THEN 'auto_paused'
                WHEN $2 = 'live' AND sync_mode = 'auto_paused' THEN 'auto_connected'
                ELSE sync_mode
            END,
            join_code = COALESCE($4, join_code),
            started_at = CASE WHEN $2 = 'live' AND started_at IS NULL THEN NOW() ELSE started_at END,
            ended_at = CASE
                WHEN $2 = 'ended' THEN NOW()
                WHEN $2 IN ('lobby', 'live', 'paused') THEN NULL
                ELSE ended_at
            END
        WHERE id = $1
        "#,
    )
    .bind(session_id)
    .bind(status)
    .bind(i64::try_from(transition.state_version).expect("database state version fits i64"))
    .bind(join_code)
    .execute(&mut **transaction)
    .await
    .map_err(persistence_error)?;
    locked.status = transition.current;
    locked.state_version = transition.state_version;
    if status == "paused" && locked.sync_mode == "auto_connected" {
        locked.sync_mode = "auto_paused".to_owned();
    } else if status == "live" && locked.sync_mode == "auto_paused" {
        locked.sync_mode = "auto_connected".to_owned();
    }
    emit_event_to_all(
        transaction,
        session_id,
        locked.state_version,
        json!({
            "event_type": "session.state_changed",
            "status": status,
            "sync_mode": locked.sync_mode,
            "current_cue_run_id": locked.current_cue_run_id,
        }),
        idempotency_key,
    )
    .await
}

pub(super) struct PreparedCue {
    pub(super) trigger_mode: String,
    state: String,
}

impl PreparedCue {
    pub(super) fn should_auto_open(&self, status: LiveSessionState) -> bool {
        self.trigger_mode == "immediate"
            && status == LiveSessionState::Live
            && self.state == "ready"
    }
}

pub(super) async fn prepare_cue(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
    locked: &mut LockedSession,
    cue_id: Uuid,
    idempotency_key: &str,
) -> Result<PreparedCue, ApiError> {
    if !matches!(
        locked.status,
        LiveSessionState::Lobby | LiveSessionState::Live | LiveSessionState::Paused
    ) {
        return Err(ApiError::conflict("command_invalid_transition"));
    }
    let trigger_mode = sqlx::query_scalar::<_, String>(
        "SELECT trigger_mode FROM cues WHERE id = $1 AND project_id = $2",
    )
    .bind(cue_id)
    .bind(locked.project_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(persistence_error)?
    .ok_or_else(|| ApiError::not_found("cue_not_found"))?;
    let existing = sqlx::query_as::<_, (Uuid, String)>(
        r#"
        SELECT cue_runs.id, cue_runs.state FROM cue_runs
        WHERE cue_runs.session_id = $1 AND cue_runs.cue_id = $2 AND cue_runs.state <> 'skipped'
        ORDER BY
          CASE WHEN EXISTS (
            SELECT 1 FROM responses WHERE responses.cue_run_id = cue_runs.id
          ) OR EXISTS (
            SELECT 1 FROM questions WHERE questions.cue_run_id = cue_runs.id
          ) THEN 0 ELSE 1 END,
          cue_runs.run_number DESC,
          cue_runs.id DESC
        LIMIT 1
        "#,
    )
    .bind(session_id)
    .bind(cue_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(persistence_error)?;
    if let Some((cue_run_id, state)) = existing {
        activate_cue_run(
            transaction,
            session_id,
            locked,
            cue_run_id,
            &state,
            idempotency_key,
        )
        .await?;
        return Ok(PreparedCue {
            trigger_mode,
            state,
        });
    }
    let run_number = sqlx::query_scalar::<_, i32>(
        "SELECT COALESCE(MAX(run_number) + 1, 1)::INTEGER FROM cue_runs WHERE session_id = $1 AND cue_id = $2",
    )
    .bind(session_id)
    .bind(cue_id)
    .fetch_one(&mut **transaction)
    .await
    .map_err(persistence_error)?;
    let cue_run_id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO cue_runs (id, session_id, cue_id, run_number, state, state_version)
        VALUES ($1, $2, $3, $4, 'ready', 1)
        "#,
    )
    .bind(cue_run_id)
    .bind(session_id)
    .bind(cue_id)
    .bind(run_number)
    .execute(&mut **transaction)
    .await
    .map_err(persistence_error)?;
    activate_cue_run(
        transaction,
        session_id,
        locked,
        cue_run_id,
        "ready",
        idempotency_key,
    )
    .await?;
    Ok(PreparedCue {
        trigger_mode,
        state: "ready".to_owned(),
    })
}

async fn activate_cue_run(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
    locked: &mut LockedSession,
    cue_run_id: Uuid,
    state: &str,
    idempotency_key: &str,
) -> Result<(), ApiError> {
    locked.current_cue_run_id = Some(cue_run_id);
    locked.presentation_view = "cue".to_owned();
    increment_session_version(transaction, session_id, locked).await?;
    emit_event_to_all(
        transaction,
        session_id,
        locked.state_version,
        json!({
            "event_type": "cue.state_changed",
            "cue_run_id": cue_run_id,
            "state": state,
        }),
        idempotency_key,
    )
    .await
}

pub(super) async fn set_presentation_view(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
    locked: &mut LockedSession,
    view: &str,
    idempotency_key: &str,
) -> Result<(), ApiError> {
    if !matches!(
        locked.status,
        LiveSessionState::Lobby | LiveSessionState::Live | LiveSessionState::Paused
    ) {
        return Err(ApiError::conflict("command_invalid_transition"));
    }
    if view == "cue" && locked.current_cue_run_id.is_none() {
        return Err(ApiError::conflict("current_cue_missing"));
    }
    locked.presentation_view = view.to_owned();
    increment_session_version(transaction, session_id, locked).await?;
    emit_event_to_all(
        transaction,
        session_id,
        locked.state_version,
        json!({
            "event_type": "presentation.view_changed",
            "view": view,
        }),
        idempotency_key,
    )
    .await
}

pub(super) async fn apply_cue_command(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
    locked: &mut LockedSession,
    command: &SessionCommand,
    idempotency_key: &str,
) -> Result<(), ApiError> {
    let cue_run_id = locked
        .current_cue_run_id
        .ok_or_else(|| ApiError::conflict("current_cue_missing"))?;
    let row = sqlx::query_as::<_, (String, i64)>(
        "SELECT state, state_version FROM cue_runs WHERE id = $1 AND session_id = $2 FOR UPDATE",
    )
    .bind(cue_run_id)
    .bind(session_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(persistence_error)?
    .ok_or_else(|| ApiError::conflict("current_cue_missing"))?;
    let action = match command {
        SessionCommand::OpenCue => CueRunAction::Open,
        SessionCommand::CloseCue => CueRunAction::Close,
        SessionCommand::ReopenCue => CueRunAction::Reopen,
        SessionCommand::RevealCue => CueRunAction::Reveal,
        SessionCommand::SkipCue => CueRunAction::Skip,
        _ => return Err(ApiError::bad_request("cue_command_invalid")),
    };
    let cue_version =
        u64::try_from(row.1).map_err(|_| ApiError::internal("state_version_invalid"))?;
    let mut machine = CueRunMachine::from_parts(parse_cue_state(&row.0)?, cue_version);
    let transition = machine
        .apply(cue_version, action)
        .map_err(state_machine_error)?;
    let cue_state = cue_state_name(transition.current);
    sqlx::query(
        r#"
        UPDATE cue_runs SET state = $2, state_version = $3,
            opened_at = CASE WHEN $2 = 'open' THEN COALESCE(opened_at, NOW()) ELSE opened_at END,
            closed_at = CASE
                WHEN $2 = 'closed' THEN NOW()
                WHEN $2 = 'revealed' THEN COALESCE(closed_at, NOW())
                WHEN $2 = 'open' THEN NULL
                ELSE closed_at
            END,
            revealed_at = CASE
                WHEN $2 = 'revealed' THEN NOW()
                WHEN $2 = 'open' THEN NULL
                ELSE revealed_at
            END
        WHERE id = $1
        "#,
    )
    .bind(cue_run_id)
    .bind(cue_state)
    .bind(i64::try_from(transition.state_version).expect("database state version fits i64"))
    .execute(&mut **transaction)
    .await
    .map_err(persistence_error)?;
    increment_session_version(transaction, session_id, locked).await?;
    emit_event_to_all(
        transaction,
        session_id,
        locked.state_version,
        json!({
            "event_type": "cue.state_changed",
            "cue_run_id": cue_run_id,
            "state": cue_state,
        }),
        idempotency_key,
    )
    .await
}

async fn increment_session_version(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
    locked: &mut LockedSession,
) -> Result<(), ApiError> {
    locked.state_version = locked
        .state_version
        .checked_add(1)
        .ok_or_else(|| ApiError::conflict("state_version_overflow"))?;
    sqlx::query(
        "UPDATE live_sessions SET state_version = $2, current_cue_run_id = $3, presentation_view = $4 WHERE id = $1",
    )
    .bind(session_id)
    .bind(i64::try_from(locked.state_version).expect("database state version fits i64"))
    .bind(locked.current_cue_run_id)
    .bind(&locked.presentation_view)
    .execute(&mut **transaction)
    .await
    .map_err(persistence_error)?;
    Ok(())
}

async fn join_code_for_reopen(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
) -> Result<String, ApiError> {
    let existing = sqlx::query_scalar::<_, Option<String>>(
        "SELECT RTRIM(join_code) FROM live_sessions WHERE id = $1",
    )
    .bind(session_id)
    .fetch_one(&mut **transaction)
    .await
    .map_err(persistence_error)?;
    if let Some(code) = existing.filter(|value| !value.is_empty()) {
        let taken = sqlx::query_scalar::<_, bool>(
            r#"
            SELECT EXISTS (
                SELECT 1 FROM live_sessions
                WHERE join_code = $1 AND status IN ('lobby', 'live', 'paused') AND id <> $2
            )
            "#,
        )
        .bind(&code)
        .bind(session_id)
        .fetch_one(&mut **transaction)
        .await
        .map_err(persistence_error)?;
        if !taken {
            return Ok(code);
        }
    }
    generate_available_join_code(transaction).await
}

async fn generate_available_join_code(
    transaction: &mut Transaction<'_, Postgres>,
) -> Result<String, ApiError> {
    for _ in 0..16 {
        let code = random_join_code();
        let available = !sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS (SELECT 1 FROM live_sessions WHERE join_code = $1 AND status IN ('lobby', 'live', 'paused'))",
        )
        .bind(&code)
        .fetch_one(&mut **transaction)
        .await
        .map_err(persistence_error)?;
        if available {
            return Ok(code);
        }
    }
    Err(ApiError::unavailable("join_code_exhausted"))
}

fn random_join_code() -> String {
    let mut bytes = [0_u8; 6];
    rand::rng().fill_bytes(&mut bytes);
    bytes
        .into_iter()
        .map(|byte| JOIN_CODE_ALPHABET[usize::from(byte) % JOIN_CODE_ALPHABET.len()] as char)
        .collect()
}

pub(super) fn parse_session_state(value: &str) -> Result<LiveSessionState, ApiError> {
    match value {
        "draft" => Ok(LiveSessionState::Draft),
        "lobby" => Ok(LiveSessionState::Lobby),
        "live" => Ok(LiveSessionState::Live),
        "paused" => Ok(LiveSessionState::Paused),
        "ended" => Ok(LiveSessionState::Ended),
        _ => Err(ApiError::internal("session_state_invalid")),
    }
}

const fn session_state_name(value: LiveSessionState) -> &'static str {
    match value {
        LiveSessionState::Draft => "draft",
        LiveSessionState::Lobby => "lobby",
        LiveSessionState::Live => "live",
        LiveSessionState::Paused => "paused",
        LiveSessionState::Ended => "ended",
    }
}

fn parse_cue_state(value: &str) -> Result<CueRunState, ApiError> {
    match value {
        "idle" => Ok(CueRunState::Idle),
        "ready" => Ok(CueRunState::Ready),
        "open" => Ok(CueRunState::Open),
        "closed" => Ok(CueRunState::Closed),
        "revealed" => Ok(CueRunState::Revealed),
        "skipped" => Ok(CueRunState::Skipped),
        _ => Err(ApiError::internal("cue_state_invalid")),
    }
}

const fn cue_state_name(value: CueRunState) -> &'static str {
    match value {
        CueRunState::Idle => "idle",
        CueRunState::Ready => "ready",
        CueRunState::Open => "open",
        CueRunState::Closed => "closed",
        CueRunState::Revealed => "revealed",
        CueRunState::Skipped => "skipped",
    }
}

fn state_machine_error(error: StateMachineError) -> ApiError {
    match error {
        StateMachineError::VersionConflict { .. } => ApiError::conflict("state_version_conflict"),
        StateMachineError::InvalidTransition { .. } | StateMachineError::NewCueRunRequired => {
            ApiError::conflict("command_invalid_transition")
        }
        StateMachineError::VersionOverflow => ApiError::conflict("state_version_overflow"),
    }
}

#[cfg(test)]
mod tests {
    use super::random_join_code;

    #[test]
    fn join_codes_are_six_numeric_characters() {
        for _ in 0..32 {
            let code = random_join_code();
            assert_eq!(code.len(), 6);
            assert!(code.bytes().all(|byte| byte.is_ascii_digit()));
        }
    }
}
