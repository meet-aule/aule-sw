//! Work that happens outside a request, in the worker process: the review of
//! a finished session and the housekeeping that keeps data from outliving its
//! purpose. Jobs live in Postgres, so they commit together with the change
//! that caused them and no broker is needed.

use std::time::Duration;

use sea_orm::ActiveValue::Set;
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, DbErr, EntityTrait, Statement};
use serde_json::Value;
use uuid::Uuid;

use crate::entity::job;
use crate::state::AppState;
use crate::{events, sessions};

pub const REVIEW_SESSION: &str = "review_session";
/// Queued by a review: the plan for the child's next session (see `ahead`).
pub const PLAN_AHEAD: &str = "plan_ahead";
const MAX_ATTEMPTS: i32 = 5;
/// Hours a transcript survives a session whose review keeps failing, when the
/// guardian did not agree to keep transcripts.
const UNREVIEWED_TRANSCRIPT_HOURS: i32 = 2;
/// Hours after which a session that never reported its end is closed.
pub const STALE_SESSION_HOURS: i32 = 3;

/// Queues a job, in the caller's transaction.
pub async fn enqueue(db: &impl ConnectionTrait, kind: &str, payload: &Value) -> Result<(), sea_orm::DbErr> {
    job::Entity::insert(job::ActiveModel {
        kind: Set(kind.to_string()),
        payload: Set(payload.clone()),
        ..Default::default()
    })
    .exec_without_returning(db)
    .await?;
    Ok(())
}

/// Takes the next due job, hiding it from other workers for five minutes.
async fn claim(db: &DatabaseConnection) -> Result<Option<(i64, String, Value, i32)>, DbErr> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "update jobs set locked_until = now() + interval '5 minutes', attempts = attempts + 1
             where id = (
                 select id from jobs
                 where done_at is null and run_at <= now() and attempts < $1
                   and (locked_until is null or locked_until < now())
                 order by run_at for update skip locked limit 1
             )
             returning id, kind, payload, attempts",
            [MAX_ATTEMPTS.into()],
        ))
        .await?;
    row.map(|row| {
        Ok((
            row.try_get("", "id")?,
            row.try_get("", "kind")?,
            row.try_get("", "payload")?,
            row.try_get("", "attempts")?,
        ))
    })
    .transpose()
}

async fn run(state: &AppState, kind: &str, payload: &Value) -> Result<(), String> {
    let session_id = || -> Result<Uuid, String> {
        payload["session_id"]
            .as_str()
            .and_then(|id| id.parse().ok())
            .ok_or_else(|| format!("{kind} needs session_id"))
    };
    let done = match kind {
        REVIEW_SESSION => sessions::review_session(state, session_id()?).await,
        PLAN_AHEAD => sessions::plan_ahead(state, session_id()?).await,
        other => return Err(format!("unknown job kind {other}")),
    };
    done.map_err(|error| match error {
        crate::error::ApiError::Internal(detail) => detail,
        other => other.to_string(),
    })
}

/// Runs one job if one is due. Returns whether there was one.
pub async fn work_once(state: &AppState) -> Result<bool, DbErr> {
    let Some((id, kind, payload, attempts)) = claim(&state.db).await? else { return Ok(false) };
    match run(state, &kind, &payload).await {
        Ok(()) => {
            state
                .db
                .execute_raw(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "update jobs set done_at = now(), locked_until = null, last_error = null where id = $1",
                    [id.into()],
                ))
                .await?;
        }
        Err(error) => {
            tracing::warn!(job = id, %kind, attempts, %error, "job failed");
            // Wait longer after each failure: 1, 4, 9, 16 minutes.
            state
                .db
                .execute_raw(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "update jobs set locked_until = null, last_error = $2,
                       run_at = now() + make_interval(mins => $3) where id = $1",
                    [
                        id.into(),
                        error.chars().take(500).collect::<String>().into(),
                        (attempts * attempts).into(),
                    ],
                ))
                .await?;
        }
    }
    Ok(true)
}

/// Deletes what has outlived its purpose and closes what was left open.
pub async fn housekeeping(state: &AppState) -> Result<(), DbErr> {
    let db = &state.db;
    let stale = db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select id from sessions where status <> 'ended' and created_at < now() - make_interval(hours => $1)",
            [STALE_SESSION_HOURS.into()],
        ))
        .await?;
    for row in stale {
        let session_id: Uuid = row.try_get("", "id")?;
        sessions::end_session(db, session_id, None, "device_offline").await?;
    }

    // What the student said, the turns and what went into the session engine,
    // goes after its time.
    for table in ["session_turns", "session_engine_inputs"] {
        let deleted = db
            .execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                format!(
                    "delete from {table} using sessions
                     where {table}.session_id = sessions.id and sessions.status = 'ended'
                       and sessions.ended_at < now() - make_interval(hours =>
                           case when sessions.keep_transcript then $1 else $2 end)"
                ),
                [(state.config.transcript_hours as i32).into(), UNREVIEWED_TRANSCRIPT_HOURS.into()],
            ))
            .await?
            .rows_affected();
        if table == "session_turns" && deleted > 0 {
            tracing::info!(turns = deleted, "transcripts past their time were deleted");
        }
    }

    for expired in [
        "delete from session_guidance using sessions
         where session_guidance.session_id = sessions.id and sessions.reviewed_at < now() - interval '1 day'",
        "delete from jobs where done_at < now() - interval '7 days'",
        "delete from outbox where delivered_at < now() - interval '30 days'",
        "delete from login_codes where expires_at < now() - interval '1 hour'",
        "delete from guardian_sessions where expires_at < now()",
        "delete from device_claims where expires_at < now()",
    ] {
        db.execute_raw(Statement::from_string(DbBackend::Postgres, expired)).await?;
    }
    Ok(())
}

pub async fn run_worker(state: AppState) {
    let mut last_housekeeping = tokio::time::Instant::now() - Duration::from_secs(3600);
    loop {
        if last_housekeeping.elapsed() >= Duration::from_secs(60) {
            if let Err(error) = housekeeping(&state).await {
                tracing::error!(%error, "housekeeping failed");
            }
            last_housekeeping = tokio::time::Instant::now();
        }
        let worked = match (work_once(&state).await, events::deliver_once(&state).await) {
            (Ok(job), Ok(event)) => Ok(job || event),
            (Err(error), _) | (_, Err(error)) => Err(error),
        };
        match worked {
            Ok(true) => {}
            Ok(false) => tokio::time::sleep(Duration::from_secs(2)).await,
            Err(error) => {
                tracing::error!(%error, "the worker could not reach the database");
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
        }
    }
}
