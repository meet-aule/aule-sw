//! The HTTP API: routes, and the handlers small enough to live next to them.

use axum::extract::{DefaultBodyLimit, Path, Query, State};
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
use crate::{devices, engine, memory, notices, passkeys, practice, push, sessions, signin};

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
        .route("/v1/children/{child_id}/sessions", get(child_sessions))
        .route("/v1/skills", put(put_skills).get(get_skills))
        .route("/v1/sessions", post(sessions::create_session))
        .route("/v1/sessions/{session_id}", get(sessions::status))
        .route("/v1/sessions/{session_id}/end", post(sessions::end_by_caller))
        .route("/v1/sessions/{session_id}/supervisor", get(sessions::supervisor_view))
        // The page of a session the engine runs
        .route("/v1/sessions/{session_id}/step", get(engine::step))
        .route("/v1/sessions/{session_id}/answers", post(engine::typed))
        .route("/v1/metrics/daily", get(crate::metrics::daily))
        .route("/v1/metrics/weekly", get(crate::metrics::weekly))
        // Guardians: sign-in, their account, their notices
        .route("/v1/auth/start", post(signin::start))
        .route("/v1/auth/verify", post(signin::verify))
        // The team's console signs Aule's team in with codes of its own
        .route("/v1/auth/team/start", post(signin::team_start))
        .route("/v1/auth/team/verify", post(signin::team_verify))
        .route("/v1/auth/google", get(signin::google_client).post(signin::google))
        .route("/v1/auth/providers", get(signin::providers))
        .route("/v1/auth/github", post(signin::github))
        .route("/v1/auth/meta", post(signin::meta))
        .route("/v1/auth/apple", post(signin::apple))
        .route("/v1/auth/signout", post(signin::sign_out))
        .route("/v1/me", get(signin::me).put(signin::update_me).delete(signin::erase_family))
        .route("/v1/me/plan", get(crate::plans::mine))
        // Aule's team: the families, their plans, and who is in a session now
        .route("/v1/admin/families", get(crate::plans::families))
        .route("/v1/admin/families/{family_id}", get(crate::team::family))
        .route(
            "/v1/admin/families/{family_id}/grant",
            post(crate::plans::grant).delete(crate::plans::ungrant),
        )
        .route("/v1/admin/families/{family_id}/sessions", get(crate::team::family_sessions))
        .route("/v1/admin/families/{family_id}/notices", get(crate::team::family_notices))
        .route("/v1/admin/sessions/open", get(crate::team::open_sessions))
        // A team member's own passkeys for the console, from a session the
        // team's sign-in opened (auth::TeamMember)
        .route(
            "/v1/admin/passkeys",
            get(passkeys::list).post(passkeys::register).layer(DefaultBodyLimit::max(passkeys::BODY_BYTES)),
        )
        .route("/v1/admin/passkeys/options", post(passkeys::register_options))
        .route("/v1/admin/passkeys/{passkey_id}", delete(passkeys::delete))
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

/// Whether the platform can answer, and which build it is. It listens on
/// loopback only; the team's console shows the build to the team.
async fn health(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    state.db.ping().await?;
    Ok(Json(json!({
        "ok": true,
        "version": crate::VERSION,
        "commit": state.config.commit,
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
struct SessionsQuery {
    #[serde(default)]
    limit: Option<i64>,
}

/// The child's latest sessions, newest first, as facts a guardian can be shown:
/// when, how long, what for, the skills by their catalog name, the exercises
/// tried and got right, the breaks and how each ended. Never what was said: no
/// topic or date typed for it, no review, no transcript, no count of turns or
/// characters, and no id.
async fn child_sessions(
    caller: Caller,
    State(state): State<AppState>,
    Path(child_id): Path<Uuid>,
    Query(params): Query<SessionsQuery>,
) -> ApiResult<Json<Value>> {
    child_for(&state.db, &caller, child_id).await?;
    use sea_orm::{ConnectionTrait, DbBackend, DbErr, Statement};
    let limit = params.limit.unwrap_or(3).clamp(1, 10);
    let rows = state
        .db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select s.started_at, s.end_reason, s.breaks,
                    s.objective->>'kind' as kind, s.objective->>'subject' as subject,
                    -- One the housekeeping closed hours later has no known length.
                    case when s.ended_at < s.created_at + make_interval(hours => $3)
                         then extract(epoch from (s.ended_at - s.started_at))::float8 end as seconds,
                    -- The tutor's exercises are rows of session_exercises (their `tutor`
                    -- attempts would count them twice); the engine's are its attempts.
                    (select count(*) from session_exercises x
                      where x.session_id = s.id and x.status in ('correct', 'failed'))
                    + (select count(*) from attempts a
                      where a.child_id = $1 and a.session_id = s.id and a.source = 'engine') as tried,
                    (select count(*) from session_exercises x
                      where x.session_id = s.id and x.status = 'correct')
                    + (select count(*) from attempts a
                      where a.child_id = $1 and a.session_id = s.id and a.source = 'engine'
                        and a.correct) as right_ones,
                    -- From any attempt of the session, the review's too, but only by
                    -- catalog name: an id outside the catalog is left out.
                    coalesce((select jsonb_agg(k.name order by k.first) from (
                        select sk.name, min(src.at) as first
                        from (select skill_id, created_at as at from session_exercises
                               where session_id = s.id and skill_id is not null
                              union all
                              select skill_id, at from attempts where child_id = $1 and session_id = s.id) src
                        join skills sk on sk.id = src.skill_id
                        group by sk.name order by first limit 3) k), '[]'::jsonb) as skills
             from sessions s
             where s.child_id = $1 and s.audience = 'child' and s.status = 'ended'
               and s.started_at is not null and s.ended_at is not null
             order by s.started_at desc
             limit $2",
            [child_id.into(), limit.into(), crate::jobs::STALE_SESSION_HOURS.into()],
        ))
        .await?;
    let sessions: Vec<Value> = rows
        .iter()
        .map(|row| {
            let kind: Option<String> = row.try_get("", "kind")?;
            let subject: Option<String> = row.try_get("", "subject")?;
            Ok(json!({
                "started_at": row.try_get::<chrono::DateTime<Utc>>("", "started_at")?,
                "seconds": row.try_get::<Option<f64>>("", "seconds")?,
                "end_reason": row.try_get::<Option<String>>("", "end_reason")?,
                "breaks": row.try_get::<i32>("", "breaks")?,
                "objective": kind.map(|kind| json!({ "kind": kind, "subject": subject })),
                "exercises": {
                    "tried": row.try_get::<i64>("", "tried")?,
                    "right": row.try_get::<i64>("", "right_ones")?,
                },
                "skills": row.try_get::<Value>("", "skills")?,
            }))
        })
        .collect::<Result<_, DbErr>>()?;
    Ok(Json(json!({ "sessions": sessions })))
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
