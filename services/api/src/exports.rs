use axum::{
    Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, Response, header},
    routing::get,
};
use tracing::warn;
use uuid::Uuid;

use crate::{
    AppState, api_error::ApiError, auth::authenticated_user_id,
    authorization::require_session_owner,
};

type ResponseRow = (String, String, String, Uuid, String, String);
type QuestionRow = (String, Uuid, String, String, i64, String);

pub(crate) fn router() -> Router<AppState> {
    Router::new().route(
        "/api/sessions/{session_id}/export.csv",
        get(export_session_csv),
    )
}

async fn export_session_csv(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Response<Body>, ApiError> {
    let user_id = authenticated_user_id(&state.database, &headers).await?;
    require_session_owner(&state.database, session_id, user_id).await?;

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
        SELECT cues.name, questions.participant_id, questions.body, questions.status,
               COUNT(question_votes.participant_id), questions.created_at::TEXT
        FROM questions
        JOIN cue_runs ON cue_runs.id = questions.cue_run_id
        JOIN cues ON cues.id = cue_runs.cue_id
        LEFT JOIN question_votes ON question_votes.question_id = questions.id
        WHERE cue_runs.session_id = $1
        GROUP BY questions.id, cues.name
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
                "qa".to_owned(),
                String::new(),
                row.1.to_string(),
                row.2,
                row.5,
                row.3,
                row.4.to_string(),
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
