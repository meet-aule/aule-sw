//! Plans written ahead.
//!
//! At a session's start the tutor does not wait for the supervisor's plan,
//! which takes several seconds to write, so a plan written then arrives after
//! the first exchange. Once a session has been reviewed, the plan for the
//! child's next one is therefore written at once, and kept with that review.
//!
//! A kept plan answers one question, told by its key
//! ([`crate::supervisor::PlanInputs::key`]): the student, the family's
//! objective, the skills the learner model offers and why, what is remembered
//! and the step the last review suggested. A session that would ask the
//! supervisor the same question takes the plan; any other has its plan
//! written at its start, as before.
//!
//! One plan is kept for a child, the one that follows the latest review. It
//! goes when the guardian takes back the consent for memories or deletes one
//! of them, since they may be in it.

use chrono::{DateTime, Duration, Utc};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::entity::{child, session_review};
use crate::families::current_consent;
use crate::supervisor::Brief;

/// Days a kept plan may wait for its session. The learner model's numbers
/// move with the days, and after this long the plan is better written again.
const DAYS: i64 = 7;

/// What `session_reviews.next_brief` holds.
#[derive(Serialize, Deserialize)]
struct Kept {
    key: String,
    brief: Brief,
    written_at: DateTime<Utc>,
}

/// The plan kept for the child, if it answers the question with this key.
pub async fn find(
    db: &DatabaseConnection,
    child_id: Uuid,
    key: &str,
    now: DateTime<Utc>,
) -> Result<Option<Brief>, DbErr> {
    let kept: Option<Value> = session_review::Entity::find()
        .filter(session_review::Column::ChildId.eq(child_id))
        .filter(session_review::Column::NextBrief.is_not_null())
        .order_by_desc(session_review::Column::CreatedAt)
        .select_only()
        .column(session_review::Column::NextBrief)
        .into_tuple::<Option<Value>>()
        .one(db)
        .await?
        .flatten();
    // One that no longer parses is treated as none.
    let kept: Option<Kept> = kept.and_then(|kept| serde_json::from_value(kept).ok());
    Ok(kept
        .filter(|kept| kept.key == key && now - kept.written_at < Duration::days(DAYS))
        .map(|kept| kept.brief))
}

/// Keeps the plan that follows a session's review, in place of any other of
/// the child's. `with_memory` says whether the child's memories were read to
/// write it: the plan is kept only if that is still what the guardian allows.
/// The check is made under the child's lock, as memory writes are, so taking
/// the consent back either removes the plan or stops it from being kept.
pub async fn keep(
    db: &DatabaseConnection,
    child_id: Uuid,
    session_id: Uuid,
    key: String,
    brief: Brief,
    with_memory: bool,
    now: DateTime<Utc>,
) -> Result<(), DbErr> {
    let kept = serde_json::to_value(Kept { key, brief, written_at: now })
        .map_err(|error| DbErr::Custom(error.to_string()))?;
    let txn = db.begin().await?;
    let child = child::Entity::find_by_id(child_id)
        .select_only()
        .column(child::Column::Id)
        .lock_exclusive()
        .into_tuple::<Uuid>()
        .one(&txn)
        .await?;
    if child.is_none() || current_consent(&txn, child_id).await?["memory"] != with_memory {
        return Ok(());
    }
    forget(&txn, child_id).await?;
    session_review::Entity::update_many()
        .col_expr(session_review::Column::NextBrief, Expr::value(kept))
        .filter(session_review::Column::SessionId.eq(session_id))
        .exec(&txn)
        .await?;
    txn.commit().await
}

/// Forgets the plan kept for the child, if there is one.
pub async fn forget(db: &impl ConnectionTrait, child_id: Uuid) -> Result<(), DbErr> {
    session_review::Entity::update_many()
        .col_expr(session_review::Column::NextBrief, Expr::value(None::<Value>))
        .filter(session_review::Column::ChildId.eq(child_id))
        .filter(session_review::Column::NextBrief.is_not_null())
        .exec(db)
        .await?;
    Ok(())
}
