use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::api_error::ApiError;
use crate::result_visibility::results_are_public;

use super::persistence_error;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SessionSnapshot {
    pub(super) session_id: Uuid,
    pub(super) project_id: Uuid,
    pub(super) join_code: Option<String>,
    pub(super) status: String,
    pub(super) locale: String,
    pub(super) sync_mode: String,
    pub(super) state_version: u64,
    #[serde(default = "default_presentation_view")]
    pub(super) presentation_view: String,
    pub(super) current_cue_run: Option<CueRunSnapshot>,
}

fn default_presentation_view() -> String {
    "cue".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct CueRunSnapshot {
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
                    && results_are_public(&interaction.settings, &cue_run.state)
            })
        })
    }
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

pub(super) async fn load_snapshot(
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
