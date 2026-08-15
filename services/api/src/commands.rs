use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, header},
    routing::{get, post},
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use slide_helper_domain::{
    CueRunAction, CueRunMachine, CueRunState, LiveSessionAction, LiveSessionMachine,
    LiveSessionState, StateMachineError, cue_matches_position,
};
use sqlx::{PgPool, Postgres, Transaction};
use tracing::warn;
use uuid::Uuid;

use crate::{
    AppState,
    api_error::ApiError,
    auth::authenticated_user_id,
    authorization::{
        authorize_presenter_access, authorize_presenter_command_access, require_session_read,
    },
    rate_limit::check as check_rate_limit,
};

const JOIN_CODE_ALPHABET: &[u8] = b"0123456789";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CommandRequest {
    idempotency_key: String,
    expected_version: u64,
    command: SessionCommand,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum SessionCommand {
    OpenLobby,
    Start,
    Pause,
    Resume,
    End,
    ReopenSession,
    ShowJoinQr,
    ShowCue,
    PrepareCue { cue_id: Uuid },
    OpenCue,
    CloseCue,
    ReopenCue,
    RevealCue,
    SkipCue,
}

impl SessionCommand {
    const fn command_type(&self) -> &'static str {
        match self {
            Self::OpenLobby => "open_lobby",
            Self::Start => "start",
            Self::Pause => "pause",
            Self::Resume => "resume",
            Self::End => "end",
            Self::ReopenSession => "reopen_session",
            Self::ShowJoinQr => "show_join_qr",
            Self::ShowCue => "show_cue",
            Self::PrepareCue { .. } => "prepare_cue",
            Self::OpenCue => "open_cue",
            Self::CloseCue => "close_cue",
            Self::ReopenCue => "reopen_cue",
            Self::RevealCue => "reveal_cue",
            Self::SkipCue => "skip_cue",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CommandResponse {
    idempotent: bool,
    snapshot: SessionSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SessionSnapshot {
    session_id: Uuid,
    project_id: Uuid,
    join_code: Option<String>,
    status: String,
    locale: String,
    sync_mode: String,
    state_version: u64,
    #[serde(default = "default_presentation_view")]
    presentation_view: String,
    current_cue_run: Option<CueRunSnapshot>,
}

fn default_presentation_view() -> String {
    "cue".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CueRunSnapshot {
    id: Uuid,
    cue_id: Uuid,
    cue_name: String,
    run_number: i32,
    state: String,
    state_version: u64,
    interactions: Vec<InteractionSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct InteractionSnapshot {
    id: Uuid,
    interaction_type: String,
    prompt: String,
    description: Option<String>,
    settings: Value,
    options: Vec<OptionSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OptionSnapshot {
    id: Uuid,
    label: String,
    is_correct: Option<bool>,
}

impl SessionSnapshot {
    pub(crate) fn redact_for_audience(mut self) -> Self {
        if let Some(cue_run) = &mut self.current_cue_run {
            for interaction in &mut cue_run.interactions {
                for option in &mut interaction.options {
                    option.is_correct = None;
                }
            }
        }
        self
    }

    pub(crate) fn current_qa_is_live(&self) -> bool {
        self.current_cue_run.as_ref().is_some_and(|cue_run| {
            cue_run.interactions.iter().any(|interaction| {
                interaction.interaction_type == "qa"
                    && interaction
                        .settings
                        .pointer("/results/audience_visibility")
                        .and_then(Value::as_str)
                        == Some("live")
            })
        })
    }
}

struct LockedSession {
    project_id: Uuid,
    status: LiveSessionState,
    state_version: u64,
    sync_mode: String,
    current_cue_run_id: Option<Uuid>,
    presentation_view: String,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/sessions/{session_id}/commands", post(command))
        .route("/api/sessions/{session_id}/snapshot", get(snapshot))
}

async fn command(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<CommandRequest>,
) -> Result<Json<CommandResponse>, ApiError> {
    let access = authorize_presenter_command_access(&state.database, &headers, session_id).await?;
    validate_idempotency_key(&request.idempotency_key)?;
    let actor_scope = access.actor_scope();
    check_rate_limit(
        &state.redis,
        "presenter-command",
        &format!("{session_id}:{actor_scope}"),
        120,
        60,
    )
    .await?;
    let mut transaction = state.database.begin().await.map_err(persistence_error)?;
    let mut locked = if let Some(user_id) = access.user_id() {
        lock_authorized_session(&mut transaction, session_id, user_id).await?
    } else {
        lock_session(&mut transaction, session_id).await?
    };

    if let Some(mut replay) =
        load_command_replay(&mut transaction, session_id, &actor_scope, &request).await?
    {
        replay.idempotent = true;
        transaction.commit().await.map_err(persistence_error)?;
        return Ok(Json(replay));
    }

    if locked.state_version != request.expected_version {
        return Err(ApiError::conflict("state_version_conflict"));
    }

    match &request.command {
        SessionCommand::OpenLobby
        | SessionCommand::Start
        | SessionCommand::Pause
        | SessionCommand::Resume
        | SessionCommand::End
        | SessionCommand::ReopenSession => {
            apply_session_command(
                &mut transaction,
                session_id,
                &mut locked,
                &request.command,
                &request.idempotency_key,
            )
            .await?;
        }
        SessionCommand::PrepareCue { cue_id } => {
            let prepared = prepare_cue(
                &mut transaction,
                session_id,
                &mut locked,
                *cue_id,
                &request.idempotency_key,
            )
            .await?;
            if prepared.should_auto_open(locked.status) {
                apply_cue_command(
                    &mut transaction,
                    session_id,
                    &mut locked,
                    &SessionCommand::OpenCue,
                    &format!("{}-open", request.idempotency_key),
                )
                .await?;
            }
        }
        SessionCommand::ShowJoinQr => {
            set_presentation_view(
                &mut transaction,
                session_id,
                &mut locked,
                "join_qr",
                &request.idempotency_key,
            )
            .await?;
        }
        SessionCommand::ShowCue => {
            set_presentation_view(
                &mut transaction,
                session_id,
                &mut locked,
                "cue",
                &request.idempotency_key,
            )
            .await?;
        }
        SessionCommand::OpenCue
        | SessionCommand::CloseCue
        | SessionCommand::ReopenCue
        | SessionCommand::RevealCue
        | SessionCommand::SkipCue => {
            apply_cue_command(
                &mut transaction,
                session_id,
                &mut locked,
                &request.command,
                &request.idempotency_key,
            )
            .await?;
        }
    }

    let response = CommandResponse {
        idempotent: false,
        snapshot: load_snapshot(&mut transaction, session_id).await?,
    };
    let receipt_result = json!({
        "command_type": request.command.command_type(),
        "response": response,
    });
    sqlx::query(
        r#"
        INSERT INTO command_receipts (
            id, session_id, actor_scope, idempotency_key,
            expected_version, resulting_version, result
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(session_id)
    .bind(actor_scope)
    .bind(&request.idempotency_key)
    .bind(
        i64::try_from(request.expected_version)
            .map_err(|_| ApiError::bad_request("state_version_invalid"))?,
    )
    .bind(i64::try_from(response.snapshot.state_version).expect("database state version fits i64"))
    .bind(receipt_result)
    .execute(&mut *transaction)
    .await
    .map_err(persistence_error)?;
    transaction.commit().await.map_err(persistence_error)?;
    Ok(Json(response))
}

async fn snapshot(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<SessionSnapshot>, ApiError> {
    let user_id = if headers.contains_key(header::AUTHORIZATION) {
        authorize_presenter_access(&state.database, &headers, session_id)
            .await?
            .user_id()
    } else {
        let user_id = authenticated_user_id(&state.database, &headers).await?;
        require_session_read(&state.database, session_id, user_id).await?;
        Some(user_id)
    };
    let mut transaction = state.database.begin().await.map_err(persistence_error)?;
    if let Some(user_id) = user_id {
        lock_authorized_session(&mut transaction, session_id, user_id).await?;
    } else {
        lock_session(&mut transaction, session_id).await?;
    }
    let snapshot = load_snapshot(&mut transaction, session_id).await?;
    transaction.commit().await.map_err(persistence_error)?;
    Ok(Json(snapshot))
}

pub(crate) async fn snapshot_for_session(
    database: &PgPool,
    session_id: Uuid,
) -> Result<SessionSnapshot, ApiError> {
    let mut transaction = database.begin().await.map_err(persistence_error)?;
    let snapshot = load_snapshot(&mut transaction, session_id).await?;
    transaction.commit().await.map_err(persistence_error)?;
    Ok(snapshot)
}

pub(crate) async fn apply_follow_position(
    database: &PgPool,
    session_id: Uuid,
    slide_id: Option<&str>,
    slide_index: Option<u32>,
    idempotency_key: &str,
) -> Result<(SessionSnapshot, Option<Uuid>), ApiError> {
    let mut transaction = database.begin().await.map_err(persistence_error)?;
    let row = sqlx::query_as::<_, (Uuid, String, i64, String, Option<Uuid>, String)>(
        r#"
        SELECT project_id, status, state_version, sync_mode, current_cue_run_id, presentation_view
        FROM live_sessions WHERE id = $1 FOR UPDATE
        "#,
    )
    .bind(session_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(persistence_error)?
    .ok_or_else(|| ApiError::not_found("session_not_found"))?;
    let mut locked = LockedSession {
        project_id: row.0,
        status: parse_session_state(&row.1)?,
        state_version: u64::try_from(row.2)
            .map_err(|_| ApiError::internal("state_version_invalid"))?,
        sync_mode: row.3,
        current_cue_run_id: row.4,
        presentation_view: row.5,
    };
    if !matches!(
        locked.status,
        LiveSessionState::Lobby | LiveSessionState::Live | LiveSessionState::Paused
    ) {
        return Err(ApiError::conflict("command_invalid_transition"));
    }

    let cues = sqlx::query_as::<_, (Uuid, String, Option<String>)>(
        r#"
        SELECT id, trigger_mode, anchor_value FROM cues
        WHERE project_id = $1 AND anchor_type = 'deck_slide'
        ORDER BY position, id
        "#,
    )
    .bind(locked.project_id)
    .fetch_all(&mut *transaction)
    .await
    .map_err(persistence_error)?;
    let cue = cues
        .into_iter()
        .find_map(|(id, trigger_mode, anchor_value)| {
            anchor_value
                .filter(|value| cue_matches_position(value, slide_id, slide_index))
                .map(|_| (id, trigger_mode))
        });

    let Some((cue_id, trigger_mode)) = cue else {
        let snapshot = load_snapshot(&mut transaction, session_id).await?;
        transaction.commit().await.map_err(persistence_error)?;
        return Ok((snapshot, None));
    };

    let current_cue_id = match locked.current_cue_run_id {
        Some(run_id) => sqlx::query_scalar::<_, Uuid>("SELECT cue_id FROM cue_runs WHERE id = $1")
            .bind(run_id)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(persistence_error)?,
        None => None,
    };
    if current_cue_id != Some(cue_id) {
        let prepared = prepare_cue(
            &mut transaction,
            session_id,
            &mut locked,
            cue_id,
            idempotency_key,
        )
        .await?;
        debug_assert_eq!(prepared.trigger_mode, trigger_mode);
        if prepared.should_auto_open(locked.status) {
            apply_cue_command(
                &mut transaction,
                session_id,
                &mut locked,
                &SessionCommand::OpenCue,
                &format!("{idempotency_key}-open"),
            )
            .await?;
        }
    } else if locked.presentation_view != "cue" {
        set_presentation_view(
            &mut transaction,
            session_id,
            &mut locked,
            "cue",
            idempotency_key,
        )
        .await?;
    }

    let snapshot = load_snapshot(&mut transaction, session_id).await?;
    transaction.commit().await.map_err(persistence_error)?;
    Ok((snapshot, Some(cue_id)))
}

async fn lock_authorized_session(
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

async fn lock_session(
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

async fn load_command_replay(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
    actor_scope: &str,
    request: &CommandRequest,
) -> Result<Option<CommandResponse>, ApiError> {
    let row = sqlx::query_as::<_, (i64, Value)>(
        r#"
        SELECT expected_version, result FROM command_receipts
        WHERE session_id = $1 AND actor_scope = $2 AND idempotency_key = $3
        "#,
    )
    .bind(session_id)
    .bind(actor_scope)
    .bind(&request.idempotency_key)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(persistence_error)?;
    let Some((expected_version, result)) = row else {
        return Ok(None);
    };
    let stored_type = result.get("command_type").and_then(Value::as_str);
    if expected_version != i64::try_from(request.expected_version).unwrap_or(-1)
        || stored_type != Some(request.command.command_type())
    {
        return Err(ApiError::conflict("idempotency_key_reused"));
    }
    let response = serde_json::from_value(
        result
            .get("response")
            .cloned()
            .ok_or_else(|| ApiError::internal("command_receipt_invalid"))?,
    )
    .map_err(|error| {
        warn!(%error, "stored command receipt is invalid");
        ApiError::internal("command_receipt_invalid")
    })?;
    Ok(Some(response))
}

async fn apply_session_command(
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

struct PreparedCue {
    trigger_mode: String,
    state: String,
}

impl PreparedCue {
    fn should_auto_open(&self, status: LiveSessionState) -> bool {
        self.trigger_mode == "immediate"
            && status == LiveSessionState::Live
            && self.state == "ready"
    }
}

async fn prepare_cue(
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

async fn set_presentation_view(
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

async fn apply_cue_command(
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

pub(crate) async fn emit_event_to_all(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
    state_version: u64,
    event: Value,
    idempotency_key: &str,
) -> Result<(), ApiError> {
    emit_event_to_topics(
        transaction,
        session_id,
        state_version,
        [
            ("presenter", event.clone()),
            ("audience", event.clone()),
            ("overlay", event),
        ],
        idempotency_key,
    )
    .await
}

pub(crate) async fn emit_event_to_topics(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
    state_version: u64,
    events: impl IntoIterator<Item = (&'static str, Value)>,
    idempotency_key: &str,
) -> Result<(), ApiError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::TEXT, 0))")
        .bind(session_id)
        .execute(&mut **transaction)
        .await
        .map_err(persistence_error)?;
    for (audience, event) in events {
        let event_type = event
            .get("event_type")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::internal("event_type_missing"))?;
        let sequence = sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM session_events WHERE session_id = $1",
        )
        .bind(session_id)
        .fetch_one(&mut **transaction)
        .await
        .map_err(persistence_error)?;
        let topic = format!("session:{session_id}:{audience}");
        let deduplication_key =
            format!("command:{session_id}:{idempotency_key}:{event_type}:{audience}");
        sqlx::query("SELECT enqueue_session_event($1, $2, $3, $4, $5, $6, $7, $8)")
            .bind(Uuid::new_v4())
            .bind(Uuid::new_v4())
            .bind(session_id)
            .bind(sequence)
            .bind(i64::try_from(state_version).expect("database state version fits i64"))
            .bind(topic)
            .bind(event)
            .bind(deduplication_key)
            .execute(&mut **transaction)
            .await
            .map_err(persistence_error)?;
    }
    Ok(())
}

async fn load_snapshot(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
) -> Result<SessionSnapshot, ApiError> {
    let row = sqlx::query_as::<
        _,
        (
            Uuid,
            Option<String>,
            String,
            String,
            String,
            i64,
            Option<Uuid>,
            String,
        ),
    >(
        r#"
        SELECT project_id, RTRIM(join_code), status, locale, sync_mode, state_version,
               current_cue_run_id, presentation_view
        FROM live_sessions WHERE id = $1
        "#,
    )
    .bind(session_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(persistence_error)?
    .ok_or_else(|| ApiError::not_found("session_not_found"))?;
    let current_cue_run = match row.6 {
        Some(cue_run_id) => Some(load_cue_snapshot(transaction, cue_run_id).await?),
        None => None,
    };
    Ok(SessionSnapshot {
        session_id,
        project_id: row.0,
        join_code: row.1,
        status: row.2,
        locale: row.3,
        sync_mode: row.4,
        state_version: u64::try_from(row.5)
            .map_err(|_| ApiError::internal("state_version_invalid"))?,
        presentation_view: row.7,
        current_cue_run,
    })
}

async fn load_cue_snapshot(
    transaction: &mut Transaction<'_, Postgres>,
    cue_run_id: Uuid,
) -> Result<CueRunSnapshot, ApiError> {
    let row = sqlx::query_as::<_, (Uuid, String, i32, String, i64)>(
        r#"
        SELECT cue_runs.cue_id, cues.name, cue_runs.run_number, cue_runs.state, cue_runs.state_version
        FROM cue_runs JOIN cues ON cues.id = cue_runs.cue_id WHERE cue_runs.id = $1
        "#,
    )
    .bind(cue_run_id)
    .fetch_one(&mut **transaction)
    .await
    .map_err(persistence_error)?;
    let interactions = sqlx::query_as::<_, (Uuid, String, String, Option<String>, Value)>(
        r#"
        SELECT id, interaction_type, prompt, description, settings
        FROM interactions WHERE cue_id = $1 ORDER BY position, id
        "#,
    )
    .bind(row.0)
    .fetch_all(&mut **transaction)
    .await
    .map_err(persistence_error)?;
    let mut snapshots = Vec::with_capacity(interactions.len());
    for interaction in interactions {
        let options = sqlx::query_as::<_, (Uuid, String, Option<bool>)>(
            "SELECT id, label, is_correct FROM interaction_options WHERE interaction_id = $1 ORDER BY position, id",
        )
        .bind(interaction.0)
        .fetch_all(&mut **transaction)
        .await
        .map_err(persistence_error)?
        .into_iter()
        .map(|option| OptionSnapshot { id: option.0, label: option.1, is_correct: option.2 })
        .collect();
        snapshots.push(InteractionSnapshot {
            id: interaction.0,
            interaction_type: interaction.1,
            prompt: interaction.2,
            description: interaction.3,
            settings: interaction.4,
            options,
        });
    }
    Ok(CueRunSnapshot {
        id: cue_run_id,
        cue_id: row.0,
        cue_name: row.1,
        run_number: row.2,
        state: row.3,
        state_version: u64::try_from(row.4)
            .map_err(|_| ApiError::internal("state_version_invalid"))?,
        interactions: snapshots,
    })
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

fn validate_idempotency_key(value: &str) -> Result<(), ApiError> {
    if value.len() < 8
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
    {
        return Err(ApiError::bad_request("idempotency_key_invalid"));
    }
    Ok(())
}

fn parse_session_state(value: &str) -> Result<LiveSessionState, ApiError> {
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

fn persistence_error(error: sqlx::Error) -> ApiError {
    if let sqlx::Error::Database(database_error) = &error
        && database_error.is_unique_violation()
    {
        return ApiError::conflict("command_conflict");
    }
    warn!(%error, "command persistence operation failed");
    ApiError::internal("command_persistence_failed")
}

#[cfg(test)]
mod tests {
    use super::{random_join_code, validate_idempotency_key};

    #[test]
    fn join_codes_are_six_numeric_characters() {
        for _ in 0..32 {
            let code = random_join_code();
            assert_eq!(code.len(), 6);
            assert!(code.bytes().all(|byte| byte.is_ascii_digit()));
        }
    }

    #[test]
    fn idempotency_keys_are_bounded_and_header_safe() {
        assert!(validate_idempotency_key("remote:command-001").is_ok());
        assert!(validate_idempotency_key("short").is_err());
        assert!(validate_idempotency_key("contains space").is_err());
    }
}
