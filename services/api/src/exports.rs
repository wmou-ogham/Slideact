use axum::{
    Json, Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, Response, header},
    routing::get,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use tracing::warn;
use uuid::Uuid;

use crate::{
    AppState, api_error::ApiError, auth::authenticated_user_id, authorization::require_session_read,
};

type ResponseRow = (String, String, String, Uuid, String, String);
type QuestionRow = (String, String, Uuid, String, String, i64, String);

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/sessions/{session_id}/export.csv",
            get(export_session_csv),
        )
        .route("/api/sessions/{session_id}/results", get(session_results))
}

#[derive(Debug, Serialize)]
struct SessionResults {
    session_id: Uuid,
    status: String,
    join_code: Option<String>,
    created_at: String,
    started_at: Option<String>,
    ended_at: Option<String>,
    audience_count: i64,
    cue_runs: Vec<CueRunResult>,
}

#[derive(Debug, Serialize)]
struct CueRunResult {
    id: Uuid,
    cue_id: Uuid,
    cue_name: String,
    anchor_value: Option<String>,
    run_number: i32,
    state: String,
    created_at: String,
    opened_at: Option<String>,
    closed_at: Option<String>,
    revealed_at: Option<String>,
    interactions: Vec<InteractionResult>,
    questions: Vec<QuestionResult>,
}

#[derive(Debug, Serialize)]
struct InteractionResult {
    id: Uuid,
    interaction_type: String,
    prompt: String,
    aggregate: Option<Value>,
}

#[derive(Debug, Serialize)]
struct QuestionResult {
    id: Uuid,
    interaction_id: Uuid,
    body: String,
    display_name: Option<String>,
    status: String,
    votes: i64,
    created_at: String,
}

async fn session_results(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<SessionResults>, ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_session_read(&state.database, session_id, user_id).await?;
    let session = sqlx::query_as::<
        _,
        (
            String,
            Option<String>,
            String,
            Option<String>,
            Option<String>,
        ),
    >(
        r#"
        SELECT status, RTRIM(join_code), created_at::TEXT, started_at::TEXT, ended_at::TEXT
        FROM live_sessions WHERE id = $1
        "#,
    )
    .bind(session_id)
    .fetch_one(&state.database)
    .await
    .map_err(persistence_error)?;
    let audience_count =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM participants WHERE session_id = $1")
            .bind(session_id)
            .fetch_one(&state.database)
            .await
            .map_err(persistence_error)?;
    let run_rows = sqlx::query_as::<
        _,
        (
            Uuid,
            Uuid,
            String,
            Option<String>,
            i32,
            String,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
        ),
    >(
        r#"
        SELECT cue_runs.id, cue_runs.cue_id, cues.name, cues.anchor_value,
               cue_runs.run_number, cue_runs.state, cue_runs.created_at::TEXT,
               cue_runs.opened_at::TEXT, cue_runs.closed_at::TEXT, cue_runs.revealed_at::TEXT
        FROM cue_runs JOIN cues ON cues.id = cue_runs.cue_id
        WHERE cue_runs.session_id = $1
        ORDER BY cue_runs.created_at, cue_runs.id
        "#,
    )
    .bind(session_id)
    .fetch_all(&state.database)
    .await
    .map_err(persistence_error)?;
    let interaction_rows = sqlx::query_as::<_, (Uuid, Uuid, String, String, Option<Value>)>(
        r#"
        SELECT cue_runs.id, interactions.id, interactions.interaction_type,
               interactions.prompt, response_aggregates.aggregate
        FROM cue_runs
        JOIN interactions ON interactions.cue_id = cue_runs.cue_id
        LEFT JOIN response_aggregates
          ON response_aggregates.cue_run_id = cue_runs.id
         AND response_aggregates.interaction_id = interactions.id
        WHERE cue_runs.session_id = $1
        ORDER BY cue_runs.created_at, interactions.position, interactions.id
        "#,
    )
    .bind(session_id)
    .fetch_all(&state.database)
    .await
    .map_err(persistence_error)?;
    let question_rows = sqlx::query_as::<
        _,
        (
            Uuid,
            Uuid,
            Uuid,
            String,
            Option<String>,
            String,
            i64,
            String,
        ),
    >(
        r#"
        SELECT questions.cue_run_id, questions.id, questions.interaction_id,
               questions.body, participants.display_name,
               questions.status,
               COUNT(question_votes.participant_id), questions.created_at::TEXT
        FROM questions
        JOIN cue_runs ON cue_runs.id = questions.cue_run_id
        JOIN participants ON participants.id = questions.participant_id
        LEFT JOIN question_votes ON question_votes.question_id = questions.id
        WHERE cue_runs.session_id = $1
        GROUP BY questions.id, participants.display_name
        ORDER BY questions.created_at, questions.id
        "#,
    )
    .bind(session_id)
    .fetch_all(&state.database)
    .await
    .map_err(persistence_error)?;
    let mut interactions: HashMap<Uuid, Vec<InteractionResult>> = HashMap::new();
    for row in interaction_rows {
        interactions
            .entry(row.0)
            .or_default()
            .push(InteractionResult {
                id: row.1,
                interaction_type: row.2,
                prompt: row.3,
                aggregate: row.4,
            });
    }
    let mut questions: HashMap<Uuid, Vec<QuestionResult>> = HashMap::new();
    for row in question_rows {
        questions.entry(row.0).or_default().push(QuestionResult {
            id: row.1,
            interaction_id: row.2,
            body: row.3,
            display_name: row.4,
            status: row.5,
            votes: row.6,
            created_at: row.7,
        });
    }
    let cue_runs = run_rows
        .into_iter()
        .map(|row| CueRunResult {
            id: row.0,
            cue_id: row.1,
            cue_name: row.2,
            anchor_value: row.3,
            run_number: row.4,
            state: row.5,
            created_at: row.6,
            opened_at: row.7,
            closed_at: row.8,
            revealed_at: row.9,
            interactions: interactions.remove(&row.0).unwrap_or_default(),
            questions: questions.remove(&row.0).unwrap_or_default(),
        })
        .collect();
    Ok(Json(SessionResults {
        session_id,
        status: session.0,
        join_code: session.1,
        created_at: session.2,
        started_at: session.3,
        ended_at: session.4,
        audience_count,
        cue_runs,
    }))
}

async fn export_session_csv(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Response<Body>, ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_session_read(&state.database, session_id, user_id).await?;

    let responses = sqlx::query_as::<_, ResponseRow>(
        r#"
        SELECT cues.name, interactions.interaction_type, interactions.prompt,
               responses.participant_id, responses.payload::TEXT, responses.submitted_at::TEXT
        FROM responses
        JOIN cue_runs ON cue_runs.id = responses.cue_run_id
        JOIN cues ON cues.id = cue_runs.cue_id
        JOIN interactions ON interactions.id = responses.interaction_id
        WHERE cue_runs.session_id = $1
        ORDER BY responses.submitted_at, responses.id
        "#,
    )
    .bind(session_id)
    .fetch_all(&state.database)
    .await
    .map_err(persistence_error)?;

    let questions = sqlx::query_as::<_, QuestionRow>(
        r#"
        SELECT cues.name, interactions.interaction_type, questions.participant_id,
               questions.body, questions.status,
               COUNT(question_votes.participant_id), questions.created_at::TEXT
        FROM questions
        JOIN cue_runs ON cue_runs.id = questions.cue_run_id
        JOIN cues ON cues.id = cue_runs.cue_id
        JOIN interactions ON interactions.id = questions.interaction_id
        LEFT JOIN question_votes ON question_votes.question_id = questions.id
        WHERE cue_runs.session_id = $1
        GROUP BY questions.id, cues.name, interactions.interaction_type
        ORDER BY questions.created_at, questions.id
        "#,
    )
    .bind(session_id)
    .fetch_all(&state.database)
    .await
    .map_err(persistence_error)?;

    let csv = build_csv(session_id, responses, questions);
    Response::builder()
        .header(header::CONTENT_TYPE, "text/csv; charset=utf-8")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"slideact-{session_id}.csv\""),
        )
        .body(Body::from(csv))
        .map_err(|_| ApiError::internal("csv_response_failed"))
}

fn build_csv(session_id: Uuid, responses: Vec<ResponseRow>, questions: Vec<QuestionRow>) -> String {
    let mut csv = String::from(
        "\u{feff}record_type,session_id,cue_name,interaction_type,prompt,participant_id,response,submitted_at,status,votes\r\n",
    );
    for row in responses {
        append_row(
            &mut csv,
            &[
                "response".to_owned(),
                session_id.to_string(),
                row.0,
                row.1,
                row.2,
                row.3.to_string(),
                row.4,
                row.5,
                String::new(),
                String::new(),
            ],
        );
    }
    for row in questions {
        append_row(
            &mut csv,
            &[
                "question".to_owned(),
                session_id.to_string(),
                row.0,
                row.1,
                String::new(),
                row.2.to_string(),
                row.3,
                row.6,
                row.4,
                row.5.to_string(),
            ],
        );
    }
    csv
}

fn append_row(csv: &mut String, fields: &[String]) {
    for (index, field) in fields.iter().enumerate() {
        if index > 0 {
            csv.push(',');
        }
        csv.push('"');
        csv.push_str(&field.replace('"', "\"\""));
        csv.push('"');
    }
    csv.push_str("\r\n");
}

fn persistence_error(error: sqlx::Error) -> ApiError {
    warn!(%error, "CSV export persistence operation failed");
    ApiError::internal("csv_export_failed")
}

#[cfg(test)]
mod tests {
    use super::{append_row, build_csv};
    use uuid::Uuid;

    #[test]
    fn csv_fields_escape_quotes_commas_and_newlines() {
        let mut csv = String::new();
        append_row(
            &mut csv,
            &["comma,value".to_owned(), "say \"hello\"\nnext".to_owned()],
        );
        assert_eq!(csv, "\"comma,value\",\"say \"\"hello\"\"\nnext\"\r\n");
    }

    #[test]
    fn empty_export_has_utf8_bom_and_header() {
        let csv = build_csv(Uuid::nil(), Vec::new(), Vec::new());
        assert!(csv.starts_with('\u{feff}'));
        assert!(csv.contains("record_type,session_id"));
    }
}
