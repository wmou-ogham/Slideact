use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    routing::{delete, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tracing::{info, warn};
use uuid::Uuid;

use crate::{
    AppState,
    api_error::ApiError,
    auth::{authenticated_user_id, hash_secret, random_token},
};

const TOKEN_SCOPE_VERSION: u16 = 1;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionRole {
    Owner,
    Presenter,
    Controller,
    Audience,
    Overlay,
    Extension,
}

impl SessionRole {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Presenter => "presenter",
            Self::Controller => "controller",
            Self::Audience => "audience",
            Self::Overlay => "overlay",
            Self::Extension => "extension",
        }
    }

    fn from_database(value: &str) -> Option<Self> {
        match value {
            "owner" => Some(Self::Owner),
            "presenter" => Some(Self::Presenter),
            "controller" => Some(Self::Controller),
            "audience" => Some(Self::Audience),
            "overlay" => Some(Self::Overlay),
            "extension" => Some(Self::Extension),
            _ => None,
        }
    }

    const fn lifetime_seconds(self) -> i64 {
        match self {
            Self::Owner | Self::Presenter | Self::Controller => 8 * 60 * 60,
            Self::Audience => 12 * 60 * 60,
            Self::Overlay => 60 * 60,
            Self::Extension => 24 * 60 * 60,
        }
    }

    const fn topic_suffix(self) -> &'static str {
        match self {
            Self::Owner | Self::Presenter | Self::Controller | Self::Extension => "presenter",
            Self::Audience => "audience",
            Self::Overlay => "overlay",
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct TokenResourceScope {
    schema_version: u16,
    topics: Vec<String>,
    #[serde(default)]
    participant_id: Option<Uuid>,
}

#[derive(Debug)]
pub(crate) struct SessionActor {
    pub(crate) token_id: Uuid,
    pub(crate) session_id: Uuid,
    pub(crate) role: SessionRole,
    pub(crate) participant_id: Option<Uuid>,
    scope: TokenResourceScope,
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum PresenterAccess {
    User(Uuid),
    ControllerToken(Uuid),
}

impl PresenterAccess {
    pub(crate) fn actor_scope(self) -> String {
        match self {
            Self::User(user_id) => format!("user:{user_id}"),
            Self::ControllerToken(token_id) => format!("controller:{token_id}"),
        }
    }

    pub(crate) const fn user_id(self) -> Option<Uuid> {
        match self {
            Self::User(user_id) => Some(user_id),
            Self::ControllerToken(_) => None,
        }
    }
}

pub(crate) fn bearer_token(headers: &HeaderMap) -> Result<&str, ApiError> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::unauthorized("session_token_required"))
}

impl SessionActor {
    pub(crate) fn authorize_topic(&self, topic: &str) -> Result<(), ApiError> {
        let expected = topic_for_role(self.session_id, self.role);
        if topic != expected || !self.scope.topics.iter().any(|allowed| allowed == topic) {
            return Err(ApiError::forbidden("realtime_topic_forbidden"));
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct IssueTokenRequest {
    role: SessionRole,
}

#[derive(Debug, Serialize)]
struct IssueTokenResponse {
    id: Uuid,
    session_id: Uuid,
    role: SessionRole,
    topic: String,
    token: String,
    expires_in_seconds: i64,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/sessions/{session_id}/tokens", post(issue_token))
        .route(
            "/api/sessions/{session_id}/tokens/{token_id}",
            delete(revoke_token),
        )
}

async fn issue_token(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<IssueTokenRequest>,
) -> Result<(StatusCode, Json<IssueTokenResponse>), ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_session_owner(&state.database, session_id, user_id).await?;

    let token = random_token();
    let token_id = Uuid::new_v4();
    let topic = topic_for_role(session_id, request.role);
    let expires_in_seconds = request.role.lifetime_seconds();
    let scope = json!({
        "schema_version": TOKEN_SCOPE_VERSION,
        "topics": [&topic],
    });

    sqlx::query(
        r#"
        INSERT INTO session_tokens (
            id,
            session_id,
            role,
            token_hash,
            resource_scope,
            expires_at
        )
        VALUES ($1, $2, $3, $4, $5, NOW() + ($6::BIGINT * INTERVAL '1 second'))
        "#,
    )
    .bind(token_id)
    .bind(session_id)
    .bind(request.role.as_str())
    .bind(hash_secret(&token))
    .bind(scope)
    .bind(expires_in_seconds)
    .execute(&state.database)
    .await
    .map_err(persistence_error)?;

    info!(%token_id, %session_id, role = request.role.as_str(), %user_id, "role-scoped session token issued");
    Ok((
        StatusCode::CREATED,
        Json(IssueTokenResponse {
            id: token_id,
            session_id,
            role: request.role,
            topic,
            token,
            expires_in_seconds,
        }),
    ))
}

async fn revoke_token(
    State(state): State<AppState>,
    Path((session_id, token_id)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_session_owner(&state.database, session_id, user_id).await?;

    let result = sqlx::query(
        r#"
        UPDATE session_tokens
        SET revoked_at = NOW()
        WHERE id = $1 AND session_id = $2 AND revoked_at IS NULL
        "#,
    )
    .bind(token_id)
    .bind(session_id)
    .execute(&state.database)
    .await
    .map_err(persistence_error)?;
    if result.rows_affected() == 0 {
        return Err(ApiError::not_found("session_token_not_found"));
    }

    info!(%token_id, %session_id, %user_id, "role-scoped session token revoked");
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn authenticate_session_token(
    database: &sqlx::PgPool,
    token: &str,
) -> Result<SessionActor, ApiError> {
    if token.len() != 43
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(ApiError::unauthorized("session_token_invalid"));
    }

    let record = sqlx::query_as::<_, (Uuid, Uuid, String, Value)>(
        r#"
        SELECT session_tokens.id,
               session_tokens.session_id,
               session_tokens.role,
               session_tokens.resource_scope
        FROM session_tokens
        JOIN live_sessions ON live_sessions.id = session_tokens.session_id
        WHERE session_tokens.token_hash = $1
          AND session_tokens.revoked_at IS NULL
          AND session_tokens.expires_at > NOW()
          AND live_sessions.status <> 'ended'
        "#,
    )
    .bind(hash_secret(token))
    .fetch_optional(database)
    .await
    .map_err(persistence_error)?
    .ok_or_else(|| ApiError::unauthorized("session_token_invalid"))?;

    let role = SessionRole::from_database(&record.2).ok_or_else(|| {
        warn!(
            role = record.2,
            "session token has an unknown database role"
        );
        ApiError::unauthorized("session_token_invalid")
    })?;
    let scope = serde_json::from_value::<TokenResourceScope>(record.3).map_err(|error| {
        warn!(%error, token_id = %record.0, "session token has an invalid resource scope");
        ApiError::unauthorized("session_token_invalid")
    })?;
    if scope.schema_version != TOKEN_SCOPE_VERSION {
        return Err(ApiError::unauthorized("session_token_invalid"));
    }

    Ok(SessionActor {
        token_id: record.0,
        session_id: record.1,
        role,
        participant_id: scope.participant_id,
        scope,
    })
}

pub(crate) async fn session_actor_is_active(
    database: &sqlx::PgPool,
    actor: &SessionActor,
) -> Result<bool, ApiError> {
    sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM session_tokens
            JOIN live_sessions ON live_sessions.id = session_tokens.session_id
            WHERE session_tokens.id = $1
              AND session_tokens.session_id = $2
              AND session_tokens.role = $3
              AND session_tokens.revoked_at IS NULL
              AND session_tokens.expires_at > NOW()
              AND live_sessions.status <> 'ended'
        )
        "#,
    )
    .bind(actor.token_id)
    .bind(actor.session_id)
    .bind(actor.role.as_str())
    .fetch_one(database)
    .await
    .map_err(persistence_error)
}

pub(crate) async fn require_session_owner(
    database: &sqlx::PgPool,
    session_id: Uuid,
    user_id: Uuid,
) -> Result<(), ApiError> {
    let session_status = session_owner_status(database, session_id, user_id).await?;
    if session_status == "ended" {
        return Err(ApiError::bad_request("session_ended"));
    }
    Ok(())
}

pub(crate) async fn require_session_read(
    database: &sqlx::PgPool,
    session_id: Uuid,
    user_id: Uuid,
) -> Result<(), ApiError> {
    session_owner_status(database, session_id, user_id)
        .await
        .map(|_| ())
}

async fn session_owner_status(
    database: &sqlx::PgPool,
    session_id: Uuid,
    user_id: Uuid,
) -> Result<String, ApiError> {
    sqlx::query_scalar::<_, String>(
        r#"
        SELECT live_sessions.status
        FROM live_sessions
        JOIN projects ON projects.id = live_sessions.project_id
        LEFT JOIN project_members
          ON project_members.project_id = projects.id
         AND project_members.user_id = $2
         AND project_members.role = 'owner'
        WHERE live_sessions.id = $1
          AND (projects.owner_id = $2 OR project_members.user_id IS NOT NULL)
        "#,
    )
    .bind(session_id)
    .bind(user_id)
    .fetch_optional(database)
    .await
    .map_err(persistence_error)?
    .ok_or_else(|| ApiError::not_found("session_not_found"))
}

pub(crate) async fn authorize_presenter_access(
    database: &sqlx::PgPool,
    headers: &HeaderMap,
    session_id: Uuid,
) -> Result<PresenterAccess, ApiError> {
    if headers.contains_key(header::AUTHORIZATION) {
        let actor = authenticate_session_token(database, bearer_token(headers)?).await?;
        if actor.session_id != session_id || actor.role != SessionRole::Controller {
            return Err(ApiError::forbidden("controller_token_required"));
        }
        return Ok(PresenterAccess::ControllerToken(actor.token_id));
    }

    let user_id = authenticated_user_id(database, headers).await?;
    require_session_owner(database, session_id, user_id).await?;
    Ok(PresenterAccess::User(user_id))
}

fn topic_for_role(session_id: Uuid, role: SessionRole) -> String {
    format!("session:{session_id}:{}", role.topic_suffix())
}

fn persistence_error(error: sqlx::Error) -> ApiError {
    warn!(%error, "authorization persistence operation failed");
    ApiError::internal("authorization_persistence_failed")
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use uuid::Uuid;

    use super::{
        SessionActor, SessionRole, TOKEN_SCOPE_VERSION, TokenResourceScope, topic_for_role,
    };

    fn actor(role: SessionRole) -> SessionActor {
        let session_id = Uuid::nil();
        let topic = topic_for_role(session_id, role);
        SessionActor {
            token_id: Uuid::nil(),
            session_id,
            role,
            participant_id: None,
            scope: TokenResourceScope {
                schema_version: TOKEN_SCOPE_VERSION,
                topics: vec![topic],
                participant_id: None,
            },
        }
    }

    #[test]
    fn presenter_side_roles_only_receive_presenter_topic() {
        let presenter_topic = format!("session:{}:presenter", Uuid::nil());
        for role in [
            SessionRole::Owner,
            SessionRole::Presenter,
            SessionRole::Controller,
            SessionRole::Extension,
        ] {
            let actor = actor(role);
            assert!(actor.authorize_topic(&presenter_topic).is_ok());
            assert!(
                actor
                    .authorize_topic(&format!("session:{}:audience", Uuid::nil()))
                    .is_err()
            );
        }
    }

    #[test]
    fn audience_and_overlay_topics_are_strictly_separated() {
        let audience = actor(SessionRole::Audience);
        let overlay = actor(SessionRole::Overlay);

        assert!(
            audience
                .authorize_topic(&format!("session:{}:audience", Uuid::nil()))
                .is_ok()
        );
        assert!(
            audience
                .authorize_topic(&format!("session:{}:presenter", Uuid::nil()))
                .is_err()
        );
        assert!(
            overlay
                .authorize_topic(&format!("session:{}:overlay", Uuid::nil()))
                .is_ok()
        );
        assert!(
            overlay
                .authorize_topic(&format!("session:{}:audience", Uuid::nil()))
                .is_err()
        );
    }

    #[test]
    fn database_scope_can_only_narrow_role_access() {
        let mut audience = actor(SessionRole::Audience);
        audience.scope.topics.clear();

        assert!(
            audience
                .authorize_topic(&format!("session:{}:audience", Uuid::nil()))
                .is_err()
        );
    }

    #[test]
    fn token_scope_rejects_unknown_fields() {
        let result = serde_json::from_value::<TokenResourceScope>(json!({
            "schema_version": 1,
            "topics": [],
            "permissions": ["admin"]
        }));

        assert!(result.is_err());
    }
}
