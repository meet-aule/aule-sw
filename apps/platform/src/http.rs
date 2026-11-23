//! The HTTP API: routes, and the handlers small enough to live next to them.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::auth::{Caller, Input, Operator};
use crate::error::{ApiError, ApiResult};
use crate::families::{self, child_for};
use crate::learning::{self, NewAttempt, Skill, is_slug};
use crate::state::AppState;
use crate::{devices, engine, memory, notices, practice, push, sessions, signin};

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(health))
        // Operator API
        .route("/v1/families", post(families::create_family))
        .route("/v1/families/{family_id}/children", post(families::create_child))
        .route(
            "/v1/children/{child_id}",
            get(families::get_child).put(families::update_child).delete(families::delete_child),
        )
        .route("/v1/children/{child_id}/consents", post(families::record_consent))
        .route("/v1/children/{child_id}/skills", get(child_skills))
        .route("/v1/children/{child_id}/attempts", post(record_attempts))
        .route("/v1/children/{child_id}/corrections", post(record_correction))
        .route("/v1/children/{child_id}/memories", get(child_memories))
        .route("/v1/children/{child_id}/memories/{memory_id}", delete(forget_memory))
        .route("/v1/children/{child_id}/reviews", get(child_reviews))
        .route("/v1/skills", put(put_skills).get(get_skills))
        .route("/v1/sessions", post(sessions::create_session))
        .route("/v1/sessions/{session_id}", get(sessions::status))
        .route("/v1/sessions/{session_id}/end", post(sessions::end_by_caller))
        .route("/v1/sessions/{session_id}/supervisor", get(sessions::supervisor_view))
        // The page of a session the engine runs
        .route("/v1/sessions/{session_id}/step", get(engine::step))
        .route("/v1/sessions/{session_id}/answers", post(engine::typed))
        .route("/v1/metrics/daily", get(crate::metrics::daily))
        // Guardians: sign-in, their account, their notices
        .route("/v1/auth/start", post(signin::start))
        .route("/v1/auth/verify", post(signin::verify))
        .route("/v1/auth/google", get(signin::google_client).post(signin::google))
        .route("/v1/auth/providers", get(signin::providers))
        .route("/v1/auth/github", post(signin::github))
        .route("/v1/auth/meta", post(signin::meta))
        .route("/v1/auth/apple", post(signin::apple))
        .route("/v1/auth/signout", post(signin::sign_out))
        .route("/v1/me", get(signin::me).put(signin::update_me).delete(signin::erase_family))
        .route("/v1/me/plan", get(crate::plans::mine))
        // Aule's team: the families and their plans
        .route("/v1/admin/families", get(crate::plans::families))
        .route(
            "/v1/admin/families/{family_id}/grant",
            post(crate::plans::grant).delete(crate::plans::ungrant),
        )
        .route("/v1/notices", get(notices::list))
        .route("/v1/notices/{notice_id}/read", post(notices::mark_read))
        .route("/v1/push/tokens", put(push::register).delete(push::unregister))
        // Devices: made by the operator, claimed by a guardian
        .route("/v1/devices", post(devices::register).get(devices::list))
        .route("/v1/devices/claim", post(devices::claim))
        .route("/v1/devices/{device_id}", put(devices::assign).delete(devices::release))
        .route("/v1/firmware", post(devices::publish_firmware))
        // What a device itself calls: it proves who it is by signing
        .route("/ota/", post(devices::check_in))
        .route("/ota/activate", post(devices::activate))
        .route("/ota/session", post(devices::start_session))
        // Agent API, one session per token
        .route("/v1/agent/session/flags", post(sessions::agent_flag))
        .route("/v1/agent/session", get(sessions::agent_start))
        .route("/v1/agent/session/turns", post(sessions::agent_turns))
        .route("/v1/agent/session/end", post(sessions::agent_end))
        .route("/v1/agent/session/exercises", post(practice::pose))
        .route("/v1/agent/session/answers", post(practice::answer))
        .route("/v1/agent/session/said", post(engine::said))
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    state.db.ping().await?;
    Ok(Json(json!({
        "ok": true,
        "supervisor": state.llm.is_some(),
        "embeddings": state.embedder.is_some(),
        "livekit": state.config.livekit.is_some(),
    })))
}

/// What the child knows now and what the learner model would work on next.
async fn child_skills(
    caller: Caller,
    State(state): State<AppState>,
    Path(child_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let child = child_for(&state.db, &caller, child_id).await?;
    let now = Utc::now();
    let trace = learning::trace_child(&state.db, child_id, now).await?;
    let catalog = learning::catalog(&state.db).await?;
    let next = learning::candidates(&trace.skills, &catalog, child.grade.as_deref(), now);
    Ok(Json(json!({ "ability": trace.ability, "skills": trace.skills, "next": next })))
}

#[derive(Deserialize)]
struct AttemptsInput {
    attempts: Vec<NewAttempt>,
    /// "guardian" for answers a guardian reports, "import" for past records.
    source: String,
}

async fn record_attempts(
    caller: Caller,
    State(state): State<AppState>,
    Path(child_id): Path<Uuid>,
    Input(body): Input<AttemptsInput>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    // Only the operator can import past records.
    let source = if caller.guardian_id().is_some() { "guardian" } else { body.source.as_str() };
    if !["guardian", "import"].contains(&source) {
        return Err(ApiError::bad_request("source must be guardian or import"));
    }
    if body.attempts.is_empty() || body.attempts.len() > 500 {
        return Err(ApiError::bad_request("send 1 to 500 attempts"));
    }
    child_for(&state.db, &caller, child_id).await?;
    let recorded = learning::record(&state.db, child_id, None, source, &body.attempts, Utc::now()).await?;
    Ok((StatusCode::CREATED, Json(json!({ "recorded": recorded }))))
}

#[derive(Deserialize)]
struct CorrectionInput {
    skill_id: String,
    /// Chance, from 0 to 1, that the child gets an average question right.
    level: f64,
}

/// A guardian or teacher overrides the model: "they already know this".
async fn record_correction(
    caller: Caller,
    State(state): State<AppState>,
    Path(child_id): Path<Uuid>,
    Input(body): Input<CorrectionInput>,
) -> ApiResult<StatusCode> {
    if !is_slug(&body.skill_id) || !(0.0..=1.0).contains(&body.level) {
        return Err(ApiError::bad_request("skill_id must be a valid id and level a number from 0 to 1"));
    }
    child_for(&state.db, &caller, child_id).await?;
    <crate::entity::correction::Entity as sea_orm::EntityTrait>::insert(
        crate::entity::correction::ActiveModel {
            id: sea_orm::ActiveValue::Set(Uuid::now_v7()),
            child_id: sea_orm::ActiveValue::Set(child_id),
            skill_id: sea_orm::ActiveValue::Set(body.skill_id.clone()),
            level: sea_orm::ActiveValue::Set(body.level),
            at: sea_orm::ActiveValue::Set(Utc::now()),
            ..Default::default()
        },
    )
    .exec_without_returning(&state.db)
    .await?;
    Ok(StatusCode::CREATED)
}

#[derive(Deserialize)]
struct MemoryQuery {
    #[serde(default)]
    query: String,
    #[serde(default)]
    limit: Option<i64>,
}

/// What is remembered about the child: the closest to `query`, or the latest.
async fn child_memories(
    caller: Caller,
    State(state): State<AppState>,
    Path(child_id): Path<Uuid>,
    Query(params): Query<MemoryQuery>,
) -> ApiResult<Json<Value>> {
    child_for(&state.db, &caller, child_id).await?;
    let limit = params.limit.unwrap_or(20).clamp(1, 100);
    let memories =
        memory::recall(&state.db, state.embedder.as_deref(), child_id, &params.query, limit).await?;
    Ok(Json(json!({ "memories": memories })))
}

async fn forget_memory(
    caller: Caller,
    State(state): State<AppState>,
    Path((child_id, memory_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    child_for(&state.db, &caller, child_id).await?;
    if memory::forget(&state.db, child_id, memory_id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound("memory"))
    }
}

#[derive(serde::Serialize)]
struct ReviewRow {
    session_id: Uuid,
    summary: String,
    next_step: Option<String>,
    flags: Vec<String>,
    created_at: chrono::DateTime<Utc>,
}

async fn child_reviews(
    caller: Caller,
    State(state): State<AppState>,
    Path(child_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    child_for(&state.db, &caller, child_id).await?;
    use crate::entity::session_review;
    use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
    let reviews: Vec<ReviewRow> = session_review::Entity::find()
        .filter(session_review::Column::ChildId.eq(child_id))
        .order_by_desc(session_review::Column::CreatedAt)
        .limit(20)
        .all(&state.db)
        .await?
        .into_iter()
        .map(|row| ReviewRow {
            session_id: row.session_id,
            summary: row.guardian_summary,
            next_step: row.next_step,
            flags: row.flags,
            created_at: row.created_at,
        })
        .collect();
    Ok(Json(json!({ "reviews": reviews })))
}

#[derive(Deserialize)]
struct SkillsInput {
    skills: Vec<Skill>,
}

async fn put_skills(
    _: Operator,
    State(state): State<AppState>,
    Input(body): Input<SkillsInput>,
) -> ApiResult<Json<Value>> {
    if body.skills.len() > 2000 {
        return Err(ApiError::bad_request("at most 2000 skills per request"));
    }
    Ok(Json(json!({ "stored": learning::upsert_skills(&state.db, &body.skills).await? })))
}

async fn get_skills(_: Caller, State(state): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(json!({ "skills": learning::catalog(&state.db).await? })))
}
