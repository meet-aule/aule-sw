//! What a family is told, in the app, by email and with a push to their phone: a summary after each
//! session, and a short note when a safety gate saw something a guardian
//! should know about. Notices are made from events, so they survive a crash
//! and are never sent twice for the same session.
//!
//! An attention note uses fixed text. It says that something came up, never
//! what the child said.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::auth::Guardian;
use crate::entity::{child, guardian, notice, session_review};
use crate::error::{ApiError, ApiResult};
use crate::events::{SAFETY_FLAGGED, SESSION_REVIEWED, SESSION_STOPPED};
use crate::state::AppState;

/// The gates that listen to the child, and the outcomes a guardian is told about.
const CHILD_GATES: [&str; 2] = ["moderation_input", "physical_safety"];

/// Title and body of an attention note, by what the gate did.
fn attention_text(action: &str, language: &str, nickname: &str) -> Option<(String, String)> {
    let (title, body) = match (action, language) {
        ("support", "en") => (
            format!("{nickname} may need you"),
            format!(
                "During a session, {nickname} said something that made the tutor suggest talking with a trusted adult. The tutor did not continue that topic. It may be nothing, but a calm conversation with {nickname} today is a good idea."
            ),
        ),
        ("support", _) => (
            format!("{nickname} puede necesitarte"),
            format!(
                "Durante una sesión, {nickname} dijo algo que hizo que el tutor le sugiriera conversar con un adulto de confianza. El tutor no siguió con ese tema. Puede no ser nada, pero conviene conversar con {nickname} hoy, con calma."
            ),
        ),
        ("adult_help", "en") => (
            format!("{nickname} asked about something that needs an adult"),
            format!(
                "During a session, {nickname} talked about doing something that could be physically risky. The tutor did not explain how and asked {nickname} to find an adult nearby."
            ),
        ),
        ("adult_help", _) => (
            format!("{nickname} preguntó por algo que necesita a un adulto"),
            format!(
                "Durante una sesión, {nickname} habló de hacer algo que podía ser físicamente riesgoso. El tutor no explicó cómo hacerlo y le pidió buscar a un adulto cercano."
            ),
        ),
        _ => return None,
    };
    Some((title, body))
}

/// What the family reads when a session was closed early because the student
/// was not working. It says what happened, never what the student said.
fn stopped_text(language: &str, nickname: &str) -> (String, String) {
    match language {
        "en" => (
            format!("{nickname}'s session ended early"),
            format!(
                "Aule closed today's session before its time: {nickname} was not working on the activity, and kept going after a reminder. Nothing is wrong. Another session can start whenever {nickname} is ready to work."
            ),
        ),
        _ => (
            format!("La sesión de {nickname} terminó antes de tiempo"),
            format!(
                "Aule cerró la sesión de hoy antes de tiempo: {nickname} no estaba trabajando en la actividad y siguió así después de un aviso. No pasó nada malo. Pueden empezar otra sesión cuando {nickname} tenga ganas de trabajar."
            ),
        ),
    }
}

fn summary_title(language: &str, nickname: &str) -> String {
    match language {
        "en" => format!("{nickname}'s session"),
        _ => format!("La sesión de {nickname}"),
    }
}

/// The platform's own consumer of events. Safe to run twice for one event.
pub async fn on_event(state: &AppState, event: &Value) -> Result<(), DbErr> {
    let data = &event["data"];
    let ids = |field: &str| data[field].as_str().and_then(|id| id.parse::<Uuid>().ok());
    let (Some(session_id), Some(child_id)) = (ids("session_id"), ids("child_id")) else { return Ok(()) };

    let child: Option<(Uuid, String)> = child::Entity::find_by_id(child_id)
        .select_only()
        .column(child::Column::FamilyId)
        .column(child::Column::Nickname)
        .into_tuple()
        .one(&state.db)
        .await?;
    // The child was erased between the event and now: nothing to tell anyone.
    let Some((family_id, nickname)) = child else { return Ok(()) };
    let language: String = guardian::Entity::find()
        .filter(guardian::Column::FamilyId.eq(family_id))
        .order_by_asc(guardian::Column::CreatedAt)
        .select_only()
        .column(guardian::Column::Language)
        .into_tuple()
        .one(&state.db)
        .await?
        .unwrap_or_else(|| "es".to_string());

    let (kind, title, body) = match event["type"].as_str() {
        Some(SESSION_REVIEWED) => {
            let summary: Option<String> = session_review::Entity::find_by_id(session_id)
                .select_only()
                .column(session_review::Column::GuardianSummary)
                .into_tuple()
                .one(&state.db)
                .await?;
            let Some(summary) = summary else { return Ok(()) };
            ("session_summary", summary_title(&language, &nickname), summary)
        }
        Some(SAFETY_FLAGGED) => {
            let gate = data["gate"].as_str().unwrap_or_default();
            let text = attention_text(data["action"].as_str().unwrap_or_default(), &language, &nickname);
            match (CHILD_GATES.contains(&gate), text) {
                (true, Some((title, body))) => ("attention", title, body),
                _ => return Ok(()),
            }
        }
        Some(SESSION_STOPPED) => {
            let (title, body) = stopped_text(&language, &nickname);
            ("session_stopped", title, body)
        }
        _ => return Ok(()),
    };

    let notice_id = Uuid::now_v7();
    let inserted = notice::Entity::insert(notice::ActiveModel {
        id: Set(notice_id),
        family_id: Set(family_id),
        child_id: Set(Some(child_id)),
        session_id: Set(Some(session_id)),
        kind: Set(kind.to_string()),
        title: Set(title.clone()),
        body: Set(body.clone()),
        ..Default::default()
    })
    .on_conflict(
        OnConflict::columns([notice::Column::SessionId, notice::Column::Kind]).do_nothing().to_owned(),
    )
    .exec_without_returning(&state.db)
    .await?;
    // Already told about this session in this way: the event came twice.
    let created = (inserted > 0).then_some(notice_id);

    if let (Some(notice_id), Some(pusher)) = (created, &state.pusher)
        && crate::push::announce(&state.db, pusher.as_ref(), family_id, notice_id, kind).await?
    {
        notice::Entity::update_many()
            .col_expr(notice::Column::PushedAt, Expr::current_timestamp())
            .filter(notice::Column::Id.eq(notice_id))
            .exec(&state.db)
            .await?;
    }
    if let (Some(notice_id), Some(mailer)) = (created, &state.mailer) {
        let recipients: Vec<(Uuid, String, String)> = guardian::Entity::find()
            .filter(guardian::Column::FamilyId.eq(family_id))
            .filter(guardian::Column::NoticesByEmail.eq(true))
            .select_only()
            .column(guardian::Column::Id)
            .column(guardian::Column::Email)
            .column(guardian::Column::Language)
            .into_tuple()
            .all(&state.db)
            .await?;
        let mut sent = false;
        for (id, email, language) in recipients {
            let result = if let Some(settings) = &state.config.mail {
                let token = crate::unsubscribe::token(
                    &state.config.admin_token,
                    id,
                    &language,
                    chrono::Utc::now().timestamp(),
                );
                let links = crate::mail::NoticeLinks {
                    language,
                    app: format!("{}/", settings.public_url),
                    unsubscribe: format!("{}/unsubscribe?token={token}", settings.public_url),
                };
                mailer.send_notice(&email, &title, &body, &links).await
            } else {
                mailer.send(&email, &title, &body).await
            };
            match result {
                Ok(()) => sent = true,
                // The notice is still in the app; the email is not retried.
                Err(error) => tracing::warn!(%notice_id, %error, "a notice was not emailed"),
            }
        }
        if sent {
            notice::Entity::update_many()
                .col_expr(notice::Column::EmailedAt, Expr::current_timestamp())
                .filter(notice::Column::Id.eq(notice_id))
                .exec(&state.db)
                .await?;
        }
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct Notice {
    id: Uuid,
    child_id: Option<Uuid>,
    session_id: Option<Uuid>,
    kind: String,
    title: String,
    body: String,
    created_at: chrono::DateTime<chrono::Utc>,
    read_at: Option<chrono::DateTime<chrono::Utc>>,
}

pub async fn list(guardian: Guardian, State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let notices: Vec<Notice> = notice::Entity::find()
        .filter(notice::Column::FamilyId.eq(guardian.family_id))
        .order_by_desc(notice::Column::CreatedAt)
        .limit(50)
        .all(&state.db)
        .await?
        .into_iter()
        .map(|row| Notice {
            id: row.id,
            child_id: row.child_id,
            session_id: row.session_id,
            kind: row.kind,
            title: row.title,
            body: row.body,
            created_at: row.created_at,
            read_at: row.read_at,
        })
        .collect();
    Ok(Json(json!({ "notices": notices })))
}

pub async fn mark_read(
    guardian: Guardian,
    State(state): State<AppState>,
    Path(notice_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let updated = notice::Entity::update_many()
        .col_expr(notice::Column::ReadAt, Expr::cust("coalesce(read_at, now())"))
        .filter(notice::Column::Id.eq(notice_id))
        .filter(notice::Column::FamilyId.eq(guardian.family_id))
        .exec(&state.db)
        .await?;
    if updated.rows_affected == 0 {
        return Err(ApiError::NotFound("notice"));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_outcomes_a_guardian_should_hear_about_have_text() {
        for action in ["support", "adult_help"] {
            for language in ["es", "en"] {
                let (title, body) = attention_text(action, language, "Mateo").unwrap();
                assert!(title.contains("Mateo") && body.contains("Mateo"));
            }
        }
        for action in ["redirect", "clarify", "unavailable", "cooldown", ""] {
            assert!(attention_text(action, "es", "Mateo").is_none(), "{action}");
        }
    }

    #[test]
    fn a_stopped_session_is_told_in_both_languages() {
        for language in ["es", "en"] {
            let (title, body) = stopped_text(language, "Mateo");
            assert!(title.contains("Mateo") && body.contains("Mateo"));
        }
    }
}
