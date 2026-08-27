use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, header},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use slide_helper_domain::{LiveSessionState, cue_matches_position};
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

use super::{
    persistence_error,
    snapshot::{SessionSnapshot, load_snapshot},
    transitions::{
        LockedSession, apply_cue_command, apply_session_command, lock_authorized_session,
        lock_session, parse_session_state, prepare_cue, set_presentation_view,
    },
};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CommandRequest {
    idempotency_key: String,
    expected_version: u64,
    command: SessionCommand,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum SessionCommand {
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
pub(super) struct CommandResponse {
    idempotent: bool,
    snapshot: SessionSnapshot,
}

pub(super) async fn command(
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

pub(super) async fn snapshot(
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

#[cfg(test)]
mod tests {
    use super::validate_idempotency_key;

    #[test]
    fn idempotency_keys_are_bounded_and_header_safe() {
        assert!(validate_idempotency_key("remote:command-001").is_ok());
        assert!(validate_idempotency_key("short").is_err());
        assert!(validate_idempotency_key("contains space").is_err());
    }
}
