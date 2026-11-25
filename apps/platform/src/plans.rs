//! What a family may use, and how much of it is left.
//!
//! A new family has a trial: seven days from its first session, one session a
//! day. After that it needs a plan, paid every month or granted by the team for
//! as long as the team says, which gives three sessions in any seven days. A
//! session counts once the tutor has started it, unless it ended within two
//! minutes: a slip of the finger costs nothing. The families of Aule's team
//! (`AULE_ADMIN_EMAILS`) are not counted: they use Aule to try it.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use chrono::{DateTime, Duration, NaiveTime, Utc};
use sea_orm::ActiveValue::Set;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbBackend, DbErr, EntityTrait, QueryFilter, QueryOrder, QueryResult,
    QuerySelect, Statement,
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::auth::{Guardian, Input, Staff};
use crate::entity::{family, guardian, subscription};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::team::{self, Cursor};

pub const TRIAL_DAYS: i64 = 7;
pub const TRIAL_PER_DAY: i64 = 1;
pub const PLAN_PER_WEEK: i64 = 3;
/// The paid plan's price, in céntimos.
pub const PRICE_CENTS: i64 = 5900;
pub const CURRENCY: &str = "PEN";
/// A session shorter than this does not count.
pub const SHORT_MINUTES: i32 = 2;
const MAX_GRANT_DAYS: i64 = 366;
/// The families one request looks at, at most: the list's page when no plan
/// is asked for, and how far a search by plan goes before it answers.
const FAMILIES_PAGE: i64 = 300;
/// The link codes the list names, the most used first.
const MAX_SOURCES: i64 = 100;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Plan {
    Trial,
    Paid,
    Granted,
    /// The trial is over and there is no plan.
    None,
    /// A family of Aule's team: no limit.
    Team,
    /// Temporary free access, without changing the family's stored plan.
    Free,
}

impl Plan {
    /// Every plan, as the team filters the families by it.
    pub const ALL: [Self; 6] = [Self::Trial, Self::Paid, Self::Granted, Self::None, Self::Team, Self::Free];

    pub fn name(self) -> &'static str {
        match self {
            Self::Trial => "trial",
            Self::Paid => "paid",
            Self::Granted => "granted",
            Self::None => "none",
            Self::Team => "team",
            Self::Free => "free",
        }
    }
}

#[derive(Debug)]
pub struct Standing {
    pub plan: Plan,
    /// When the plan or the trial ends; a trial not yet started has none.
    pub ends_at: Option<DateTime<Utc>>,
    pub used: i64,
    pub allowed: i64,
    /// `day` for the trial, `week` (any seven days) for a plan.
    pub period: &'static str,
}

impl Standing {
    pub fn left(&self) -> i64 {
        (self.allowed - self.used).max(0)
    }

    pub fn json(&self) -> Value {
        let unlimited = matches!(self.plan, Plan::Team | Plan::Free);
        json!({
            "plan": self.plan.name(),
            "ends_at": self.ends_at,
            "used": self.used,
            "allowed": (!unlimited).then_some(self.allowed),
            "left": (!unlimited).then_some(self.left()),
            "period": self.period,
            "price": { "amount_cents": PRICE_CENTS, "currency": CURRENCY, "sessions_per_week": PLAN_PER_WEEK },
        })
    }

    /// Why no session can start now, for the page to say; none while one can.
    fn limit(&self) -> Option<&'static str> {
        if matches!(self.plan, Plan::Team | Plan::Free) {
            return None;
        }
        (self.left() == 0).then_some(match self.plan {
            Plan::Trial => "trial_day_used",
            Plan::None => "trial_over",
            Plan::Paid | Plan::Granted | Plan::Team | Plan::Free => "week_used",
        })
    }
}

/// The start of today where the family lives, as an instant.
pub fn start_of_day(now: DateTime<Utc>, offset_minutes: i32) -> DateTime<Utc> {
    let offset = Duration::minutes(offset_minutes.into());
    (now + offset).date_naive().and_time(NaiveTime::MIN).and_utc() - offset
}

/// The family's sessions that count, started since `since`.
async fn counted(db: &impl ConnectionTrait, family_id: Uuid, since: DateTime<Utc>) -> ApiResult<i64> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select count(*) as counted from sessions join children on children.id = sessions.child_id
             where children.family_id = $1 and sessions.started_at >= $2
               and (sessions.ended_at is null or sessions.ended_at - sessions.started_at >= make_interval(mins => $3))",
            [family_id.into(), since.into(), SHORT_MINUTES.into()],
        ))
        .await?;
    Ok(row.map(|row| row.try_get::<i64>("", "counted")).transpose()?.unwrap_or(0))
}

/// When the family's first session that counts started: the trial's first day.
pub(crate) async fn first_session(
    db: &impl ConnectionTrait,
    family_id: Uuid,
) -> ApiResult<Option<DateTime<Utc>>> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select min(sessions.started_at) as first from sessions join children on children.id = sessions.child_id
             where children.family_id = $1 and sessions.started_at is not null
               and (sessions.ended_at is null or sessions.ended_at - sessions.started_at >= make_interval(mins => $2))",
            [family_id.into(), SHORT_MINUTES.into()],
        ))
        .await?;
    Ok(row.map(|row| row.try_get::<Option<DateTime<Utc>>>("", "first")).transpose()?.flatten())
}

/// Whether one of the family's guardians is on Aule's team.
async fn is_team(db: &impl ConnectionTrait, family_id: Uuid, team: &[String]) -> ApiResult<bool> {
    if team.is_empty() {
        return Ok(false);
    }
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            // The addresses were checked at start: none has a comma.
            "select exists(select 1 from guardians
               where family_id = $1 and email = any(string_to_array($2, ','))) as team",
            [family_id.into(), team.join(",").into()],
        ))
        .await?;
    Ok(row.map(|row| row.try_get::<bool>("", "team")).transpose()?.unwrap_or(false))
}

pub async fn standing(state: &AppState, family_id: Uuid, now: DateTime<Utc>) -> ApiResult<Standing> {
    let db = &state.db;
    if is_team(db, family_id, &state.config.admin_emails).await? {
        return Ok(Standing {
            plan: Plan::Team,
            ends_at: None,
            used: counted(db, family_id, now - Duration::days(7)).await?,
            allowed: 0,
            period: "week",
        });
    }
    let offset_minutes = state.config.timezone_offset_minutes;
    if state.config.free_access {
        return Ok(Standing {
            plan: Plan::Free,
            ends_at: None,
            used: counted(db, family_id, now - Duration::days(7)).await?,
            allowed: 0,
            period: "week",
        });
    }
    // A plan that holds now; with two, the one that lasts longer.
    let plan = subscription::Entity::find()
        .filter(subscription::Column::FamilyId.eq(family_id))
        .filter(subscription::Column::StartsAt.lte(now))
        .filter(subscription::Column::EndsAt.gt(now))
        .order_by_desc(subscription::Column::EndsAt)
        .one(db)
        .await?;
    if let Some(plan) = plan {
        return Ok(Standing {
            plan: if plan.plan == "paid" { Plan::Paid } else { Plan::Granted },
            ends_at: Some(plan.ends_at),
            used: counted(db, family_id, now - Duration::days(7)).await?,
            allowed: PLAN_PER_WEEK,
            period: "week",
        });
    }
    let trial_ends = first_session(db, family_id).await?.map(|first| first + Duration::days(TRIAL_DAYS));
    if trial_ends.is_none_or(|ends| now < ends) {
        return Ok(Standing {
            plan: Plan::Trial,
            ends_at: trial_ends,
            used: counted(db, family_id, start_of_day(now, offset_minutes)).await?,
            allowed: TRIAL_PER_DAY,
            period: "day",
        });
    }
    Ok(Standing { plan: Plan::None, ends_at: trial_ends, used: 0, allowed: 0, period: "week" })
}

/// Whether the family may start a session now. A refusal says which limit.
pub async fn admit(state: &AppState, family_id: Uuid) -> ApiResult<()> {
    let standing = standing(state, family_id, Utc::now()).await?;
    match standing.limit() {
        None => Ok(()),
        Some(reason) => Err(ApiError::PlanLimit(reason)),
    }
}

/// The signed-in family's plan and what is left of it, and whether the person
/// is on Aule's team (the page then shows the way to the team's console).
pub async fn mine(guardian: Guardian, State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let standing = standing(&state, guardian.family_id, Utc::now()).await?;
    let email: Option<String> = guardian::Entity::find_by_id(guardian.id)
        .select_only()
        .column(guardian::Column::Email)
        .into_tuple()
        .one(&state.db)
        .await?;
    let mut answer = standing.json();
    answer["team"] = json!(email.is_some_and(|email| state.config.admin_emails.contains(&email)));
    Ok(Json(answer))
}

#[derive(Deserialize)]
pub struct FamiliesQuery {
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    limit: Option<String>,
}

/// The families a search and a link ask for: `$1` a pattern found in the
/// family's name or in a guardian's address, `$2` the link it came from. A
/// null asks for every family.
const FAMILIES_MATCHING: &str = r"($1::text is null or families.name ilike $1 escape '\'
       or exists (select 1 from guardians where guardians.family_id = families.id
                    and guardians.email::text ilike $1 escape '\'))
   and ($2::text is null or families.source = $2)";

/// Every family, newest first, with its plan, the link it signed up from and
/// how much it uses Aule: what the team needs to look after the families, and
/// nothing a child said. `q` finds a family by its name or by a guardian's
/// address, `source` by the link it came from and `status` by the plan it has
/// now; `before` and `limit` page through them. With none of them, it is the
/// newest 300.
pub async fn families(
    _: Staff,
    State(state): State<AppState>,
    Query(query): Query<FamiliesQuery>,
) -> ApiResult<Json<Value>> {
    let search = team::given(&query.q).map(team::search_pattern).transpose()?;
    let source = match team::given(&query.source) {
        None => None,
        Some(code) => Some(
            crate::signin::source_code(Some(code))
                .ok_or_else(|| ApiError::bad_request("source is not a link code"))?,
        ),
    };
    let status = match team::given(&query.status) {
        None => None,
        Some(name) => Some(Plan::ALL.into_iter().find(|plan| plan.name() == name).ok_or_else(|| {
            let names: Vec<&str> = Plan::ALL.iter().map(|plan| plan.name()).collect();
            ApiError::bad_request(format!("status must be one of: {}", names.join(", ")))
        })?),
    };
    let before = team::given(&query.before).map(Cursor::read).transpose()?;
    let limit = team::page_size(team::given(&query.limit), FAMILIES_PAGE, FAMILIES_PAGE)?;
    // A plan is known only once `standing` has worked it out, family by
    // family: a search by plan looks at up to a page of them, and `next` goes
    // on from the last one it looked at.
    let scan = if status.is_some() { FAMILIES_PAGE } else { limit };
    let rows = state
        .db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            format!(
                "with page as (
                   select families.id, families.name, families.created_at, families.source
                   from families
                   where {FAMILIES_MATCHING}
                     and ($3::timestamptz is null or (families.created_at, families.id) < ($3, $4::uuid))
                   order by families.created_at desc, families.id desc
                   limit $5
                 ), used as (
                   select children.family_id,
                          count(*) filter (where sessions.started_at > now() - interval '7 days') as sessions_7d,
                          count(*) filter (where sessions.started_at > now() - interval '30 days') as sessions_30d,
                          coalesce(sum(extract(epoch from (coalesce(sessions.ended_at, now()) - sessions.started_at)))
                            filter (where sessions.started_at > now() - interval '30 days'), 0)::float8 / 60 as minutes_30d,
                          max(sessions.started_at) as last_session
                   from sessions join children on children.id = sessions.child_id
                   where sessions.started_at is not null and children.family_id in (select id from page)
                   group by children.family_id
                 )
                 select page.id, page.name, page.created_at, page.source,
                        (select string_agg(guardians.email, ', ' order by guardians.created_at)
                           from guardians where guardians.family_id = page.id) as emails,
                        (select count(*) from children where children.family_id = page.id) as children,
                        coalesce(used.sessions_7d, 0) as sessions_7d, coalesce(used.sessions_30d, 0) as sessions_30d,
                        coalesce(used.minutes_30d, 0) as minutes_30d, used.last_session
                 from page left join used on used.family_id = page.id
                 order by page.created_at desc, page.id desc"
            ),
            [
                search.clone().into(),
                source.clone().into(),
                before.map(|cursor| cursor.at).into(),
                before.map(|cursor| cursor.id).into(),
                (scan + 1).into(),
            ],
        ))
        .await?;
    let now = Utc::now();
    let looked_at = rows.len().min(usize::try_from(scan).unwrap_or(usize::MAX));
    let mut families = Vec::new();
    let mut next = None;
    for (index, row) in rows.iter().enumerate().take(looked_at) {
        let id: Uuid = row.try_get("", "id")?;
        let standing = standing(&state, id, now).await?;
        if status.is_some_and(|plan| plan != standing.plan) {
            continue;
        }
        families.push(family_row(row, id, &standing)?);
        if families.len() == usize::try_from(limit).unwrap_or(usize::MAX) {
            if index + 1 < rows.len() {
                next = Some(cursor_of(row)?);
            }
            break;
        }
    }
    // Every row it may look at was looked at and more are left: a search by
    // plan goes on from the last one, even with a page short of its limit.
    if next.is_none() && rows.len() > looked_at && looked_at > 0 {
        next = Some(cursor_of(&rows[looked_at - 1])?);
    }
    // How many there are is known without a plan asked for; with one, it
    // would take the plan of every family.
    let total = match status {
        Some(_) => None,
        None => {
            let row = state
                .db
                .query_one_raw(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    format!("select count(*) as total from families where {FAMILIES_MATCHING}"),
                    [search.into(), source.into()],
                ))
                .await?;
            Some(row.map(|row| row.try_get::<i64>("", "total")).transpose()?.unwrap_or(0))
        }
    };
    let sources: Vec<Value> = state
        .db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select source, count(*) as families from families where source is not null
             group by source order by count(*) desc, source limit $1",
            [MAX_SOURCES.into()],
        ))
        .await?
        .iter()
        .map(|row| {
            Ok(json!({
                "source": row.try_get::<String>("", "source")?,
                "families": row.try_get::<i64>("", "families")?,
            }))
        })
        .collect::<Result<_, DbErr>>()?;
    Ok(Json(json!({ "families": families, "next": next, "total": total, "sources": sources })))
}

/// Where the families list goes on after this row.
fn cursor_of(row: &QueryResult) -> Result<String, DbErr> {
    Ok(Cursor::write(row.try_get("", "created_at")?, row.try_get("", "id")?))
}

/// A family as the team's list shows it.
fn family_row(row: &QueryResult, id: Uuid, standing: &Standing) -> Result<Value, DbErr> {
    Ok(json!({
        "id": id,
        "name": row.try_get::<String>("", "name")?,
        "created_at": row.try_get::<DateTime<Utc>>("", "created_at")?,
        "source": row.try_get::<Option<String>>("", "source")?,
        "emails": row.try_get::<Option<String>>("", "emails")?,
        "children": row.try_get::<i64>("", "children")?,
        "sessions_7d": row.try_get::<i64>("", "sessions_7d")?,
        "sessions_30d": row.try_get::<i64>("", "sessions_30d")?,
        "minutes_30d": (row.try_get::<f64>("", "minutes_30d")? * 10.0).round() / 10.0,
        "last_session": row.try_get::<Option<DateTime<Utc>>>("", "last_session")?,
        "standing": standing.json(),
    }))
}

#[derive(Deserialize)]
pub struct GrantInput {
    /// How many days from now the plan is granted for.
    days: i64,
    #[serde(default)]
    note: Option<String>,
}

/// The team gives a family the plan for free, for a while: the pilot's
/// families, a scholarship, the team's own.
pub async fn grant(
    staff: Staff,
    State(state): State<AppState>,
    Path(family_id): Path<Uuid>,
    Input(body): Input<GrantInput>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    if !(1..=MAX_GRANT_DAYS).contains(&body.days) {
        return Err(ApiError::bad_request(format!("days must be from 1 to {MAX_GRANT_DAYS}")));
    }
    let note = body.note.map(|note| note.trim().to_string()).filter(|note| !note.is_empty());
    if note.as_ref().is_some_and(|note| note.chars().count() > 500) {
        return Err(ApiError::bad_request("note must have at most 500 characters"));
    }
    family::Entity::find_by_id(family_id).one(&state.db).await?.ok_or(ApiError::NotFound("family"))?;
    let now = Utc::now();
    let ends_at = now + Duration::days(body.days);
    subscription::Entity::insert(subscription::ActiveModel {
        id: Set(Uuid::now_v7()),
        family_id: Set(family_id),
        plan: Set("granted".into()),
        starts_at: Set(now),
        ends_at: Set(ends_at),
        granted_by: Set(staff.email.clone()),
        note: Set(note),
        ..Default::default()
    })
    .exec_without_returning(&state.db)
    .await?;
    tracing::info!(%family_id, days = body.days, by = staff.email.as_deref().unwrap_or("operator"), "a plan was granted");
    let standing = standing(&state, family_id, now).await?;
    Ok((StatusCode::CREATED, Json(standing.json())))
}

/// Ends what the team granted a family, from now. A paid plan is not touched.
pub async fn ungrant(
    staff: Staff,
    State(state): State<AppState>,
    Path(family_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let now = Utc::now();
    subscription::Entity::update_many()
        .col_expr(subscription::Column::EndsAt, sea_orm::sea_query::Expr::value(now))
        .filter(subscription::Column::FamilyId.eq(family_id))
        .filter(subscription::Column::Plan.eq("granted"))
        .filter(subscription::Column::EndsAt.gt(now))
        .filter(subscription::Column::StartsAt.lt(now))
        .exec(&state.db)
        .await?;
    tracing::info!(%family_id, by = staff.email.as_deref().unwrap_or("operator"), "a granted plan was ended");
    let standing = standing(&state, family_id, now).await?;
    Ok(Json(standing.json()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn today_starts_at_midnight_where_the_family_lives() {
        // 03:00 UTC is still the day before in Lima (UTC-5).
        let now = "2026-11-21T03:00:00Z".parse::<DateTime<Utc>>().unwrap();
        assert_eq!(start_of_day(now, -300).to_rfc3339(), "2026-11-20T05:00:00+00:00");
        assert_eq!(start_of_day(now, 0).to_rfc3339(), "2026-11-21T00:00:00+00:00");
    }

    #[test]
    fn the_limit_is_said_only_when_nothing_is_left() {
        let standing = |plan, used, allowed| Standing { plan, ends_at: None, used, allowed, period: "day" };
        assert_eq!(standing(Plan::Trial, 0, 1).limit(), None);
        assert_eq!(standing(Plan::Trial, 1, 1).limit(), Some("trial_day_used"));
        assert_eq!(standing(Plan::Granted, 3, 3).limit(), Some("week_used"));
        assert_eq!(standing(Plan::None, 0, 0).limit(), Some("trial_over"));
        assert_eq!(standing(Plan::Team, 9, 0).limit(), None);
        assert_eq!(standing(Plan::Free, 99, 0).limit(), None);
        let free = standing(Plan::Free, 99, 0).json();
        assert_eq!(free["left"], Value::Null);
        assert_eq!(free["allowed"], Value::Null);
        assert_eq!(standing(Plan::Paid, 5, 3).left(), 0);
    }
}
