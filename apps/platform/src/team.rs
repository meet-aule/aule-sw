//! What Aule's team reads about the families, and never what was said: who
//! is in a session now, and a family's page with its sessions and the notices
//! it was sent. Only the team calls these (`Staff`), from its console.
//!
//! The team's lists run newest first and are read a page at a time: a page
//! ends with a cursor, and the next one starts after it. What a session was
//! for, what was said in it, its review, a notice's words, a child's notes
//! and a card's token are never read here: one-table reads name their
//! columns, and joins select theirs.

use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, Query, State};
use chrono::{DateTime, Duration, Utc};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbBackend, DbErr, DerivePartialModel, EntityTrait, QueryFilter, QueryOrder,
    QueryResult, QuerySelect, Statement,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::auth::Staff;
use crate::entity::{child, family, guardian, subscription};
use crate::error::{ApiError, ApiResult};
use crate::families::{PURPOSES, age};
use crate::jobs::STALE_SESSION_HOURS;
use crate::plans::{self, TRIAL_DAYS};
use crate::state::AppState;

/// The most characters a search may have.
const MAX_SEARCH_CHARS: usize = 100;
/// Minutes past a session's length after which an open session is more
/// likely stuck than running: the deploy scripts wait as long for one.
const STUCK_AFTER_MINUTES: u32 = 50;
/// The open sessions listed, at most; the counts take in every one.
const MAX_OPEN: i64 = 100;
/// A family's guardians, children and plans, at most: more than a family has.
const MAX_GUARDIANS: u64 = 10;
const MAX_CHILDREN: u64 = 20;
const MAX_PLANS: u64 = 50;
/// A family's sessions and notices, a page at a time.
const PAGE: i64 = 20;
const MAX_PAGE: i64 = 50;

/// Where a list goes on: the creation time and the id of the last row the
/// page before held, written `<microseconds since 1970>_<id>`. Postgres keeps
/// microseconds, so the time comes back exactly, and the id settles a tie.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cursor {
    pub at: DateTime<Utc>,
    pub id: Uuid,
}

impl Cursor {
    pub fn write(at: DateTime<Utc>, id: Uuid) -> String {
        format!("{}_{}", at.timestamp_micros(), id.hyphenated())
    }

    /// A cursor as `write` makes it, and nothing else.
    pub fn read(text: &str) -> ApiResult<Self> {
        let refused = || ApiError::bad_request("before is not a cursor");
        let (micros, id) = text.split_once('_').ok_or_else(refused)?;
        if micros.is_empty() || micros.len() > 18 || !micros.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(refused());
        }
        let at = micros.parse().ok().and_then(DateTime::from_timestamp_micros).ok_or_else(refused)?;
        let id = Uuid::try_parse(id).map_err(|_| refused())?;
        // Only the form `write` gives: hyphenated and lower case.
        if id.hyphenated().to_string() != text[micros.len() + 1..] {
            return Err(refused());
        }
        Ok(Self { at, id })
    }
}

/// A query's value, with an empty one taken as not given: a form sends its
/// empty fields too.
pub fn given(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|value| !value.is_empty())
}

/// How many rows a page holds: `default` when not asked for, otherwise the
/// number asked for, kept from 1 to `most`.
pub fn page_size(asked: Option<&str>, default: i64, most: i64) -> ApiResult<i64> {
    let Some(asked) = asked else { return Ok(default) };
    let asked: i64 = asked.parse().map_err(|_| ApiError::bad_request("limit must be a whole number"))?;
    Ok(asked.clamp(1, most))
}

/// What the team typed, as a pattern for `ilike` that finds it anywhere, with
/// `\`, `%` and `_` standing for themselves.
pub fn search_pattern(typed: &str) -> ApiResult<String> {
    if typed.chars().count() > MAX_SEARCH_CHARS || typed.chars().any(char::is_control) {
        return Err(ApiError::bad_request(format!(
            "q must have at most {MAX_SEARCH_CHARS} characters, on one line"
        )));
    }
    let mut pattern = String::with_capacity(typed.len() + 2);
    pattern.push('%');
    for c in typed.chars() {
        if matches!(c, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    pattern.push('%');
    Ok(pattern)
}

/// The page a query asks for: where it starts and how many rows it holds.
#[derive(Deserialize)]
pub struct PageQuery {
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    limit: Option<String>,
}

impl PageQuery {
    fn read(&self) -> ApiResult<(Option<Cursor>, i64)> {
        let before = given(&self.before).map(Cursor::read).transpose()?;
        Ok((before, page_size(given(&self.limit), PAGE, MAX_PAGE)?))
    }
}

/// A page's rows and where the list goes on, from rows read one past the
/// page's size: the extra one says there are more.
fn paged(mut rows: Vec<QueryResult>, limit: i64) -> Result<(Vec<QueryResult>, Option<String>), DbErr> {
    let size = usize::try_from(limit).unwrap_or(usize::MAX);
    if rows.len() <= size {
        return Ok((rows, None));
    }
    rows.truncate(size);
    let next = match rows.last() {
        Some(last) => Some(Cursor::write(last.try_get("", "created_at")?, last.try_get("", "id")?)),
        None => None,
    };
    Ok((rows, next))
}

/// 404 unless the family is there.
async fn known_family(db: &impl ConnectionTrait, family_id: Uuid) -> ApiResult<()> {
    let found: Option<Uuid> = family::Entity::find_by_id(family_id)
        .select_only()
        .column(family::Column::Id)
        .into_tuple()
        .one(db)
        .await?;
    found.map(|_| ()).ok_or(ApiError::NotFound("family"))
}

/// Who is in a session now, and how many are open: what the team looks at
/// before a deploy, which would end them. For each, the family and the
/// child's nickname, since when, whether the engine runs it, and whether it
/// came from the web or a device; never its id, room or token, what it is for
/// or anything said in it. The counts take in every open session, the team's
/// tests too; the list stops at 100. One open past the session's length and
/// 50 minutes more is `overdue`: more likely stuck than running, and closed
/// by the housekeeping after 3 hours.
pub async fn open_sessions(_: Staff, State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let overdue_after = state.config.session_minutes + STUCK_AFTER_MINUTES;
    let rows = state
        .db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            // The counts are window aggregates: worked out over every open
            // session before the limit, and read in the same statement.
            "select s.created_at, s.started_at, s.status, s.engine, s.audience,
                    s.device_id is not null as device,
                    s.created_at < now() - make_interval(mins => $1) as overdue,
                    c.nickname, c.family_id, f.name as family,
                    count(*) over () as open_count,
                    count(*) filter (where s.status = 'created') over () as starting_count,
                    count(*) filter (where s.created_at < now() - make_interval(mins => $1)) over () as overdue_count
             from sessions s
             left join children c on c.id = s.child_id
             left join families f on f.id = c.family_id
             where s.status <> 'ended'
             order by s.created_at desc, s.id desc
             limit $2",
            [i32::try_from(overdue_after).unwrap_or(i32::MAX).into(), MAX_OPEN.into()],
        ))
        .await?;
    // No row: no session is open.
    let count = |name: &str| -> Result<i64, DbErr> {
        Ok(rows.first().map(|row| row.try_get::<i64>("", name)).transpose()?.unwrap_or(0))
    };
    let open = count("open_count")?;
    let sessions: Vec<Value> = rows
        .iter()
        .map(|row| {
            Ok(json!({
                "family_id": row.try_get::<Option<Uuid>>("", "family_id")?,
                "family": row.try_get::<Option<String>>("", "family")?,
                "child": row.try_get::<Option<String>>("", "nickname")?,
                "audience": row.try_get::<String>("", "audience")?,
                "status": row.try_get::<String>("", "status")?,
                "created_at": row.try_get::<DateTime<Utc>>("", "created_at")?,
                "started_at": row.try_get::<Option<DateTime<Utc>>>("", "started_at")?,
                "engine": row.try_get::<bool>("", "engine")?,
                "via": if row.try_get::<bool>("", "device")? { "device" } else { "web" },
                "overdue": row.try_get::<bool>("", "overdue")?,
            }))
        })
        .collect::<Result<_, DbErr>>()?;
    Ok(Json(json!({
        "open": open,
        "starting": count("starting_count")?,
        "overdue": count("overdue_count")?,
        "overdue_after_minutes": overdue_after,
        "more": open > i64::try_from(sessions.len()).unwrap_or(i64::MAX),
        "sessions": sessions,
    })))
}

#[derive(DerivePartialModel)]
#[sea_orm(entity = "family::Entity")]
struct FamilyRow {
    name: String,
    source: Option<String>,
    created_at: DateTime<Utc>,
}

/// A guardian as the team sees them: no id, no sign-in.
#[derive(DerivePartialModel, Serialize)]
#[sea_orm(entity = "guardian::Entity")]
struct GuardianRow {
    name: String,
    email: String,
    language: String,
    created_at: DateTime<Utc>,
    notices_by_email: bool,
    notices_by_push: bool,
}

/// A child as the team sees them. The id is read to find their consents, and
/// never sent; their notes, interests and tutor are not read at all.
#[derive(DerivePartialModel)]
#[sea_orm(entity = "child::Entity")]
struct ChildRow {
    id: Uuid,
    nickname: String,
    birth_year: Option<i32>,
    grade: Option<String>,
    created_at: DateTime<Utc>,
}

/// A plan the family has had, paid or granted. A card's token and the
/// provider's charge are not read. An ungrant ends a grant by moving its
/// `ends_at`, so a grant shows the days it really ran.
#[derive(DerivePartialModel, Serialize)]
#[sea_orm(entity = "subscription::Entity")]
struct PlanRow {
    plan: String,
    starts_at: DateTime<Utc>,
    ends_at: DateTime<Utc>,
    note: Option<String>,
    /// Who on the team granted it; none for the operator's token or a paid plan.
    granted_by: Option<String>,
    created_at: DateTime<Utc>,
    cancelled_at: Option<DateTime<Utc>>,
}

/// One family's page: its guardians, its children with what each kind of
/// consent says now, the plan it has now with its trial and every plan it has
/// had, and how many sessions it started. Never a child's notes, interests or
/// tutor, the id of a guardian or a child, who recorded a consent, a card's
/// token, or anything said in a session.
pub async fn family(
    _: Staff,
    State(state): State<AppState>,
    Path(family_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let db = &state.db;
    let found = family::Entity::find_by_id(family_id).into_partial_model::<FamilyRow>().one(db).await?;
    let FamilyRow { name, source, created_at } = found.ok_or(ApiError::NotFound("family"))?;
    let guardians = guardian::Entity::find()
        .filter(guardian::Column::FamilyId.eq(family_id))
        .order_by_asc(guardian::Column::CreatedAt)
        .order_by_asc(guardian::Column::Id)
        .limit(MAX_GUARDIANS)
        .into_partial_model::<GuardianRow>()
        .all(db)
        .await?;
    let children = child::Entity::find()
        .filter(child::Column::FamilyId.eq(family_id))
        .order_by_asc(child::Column::CreatedAt)
        .order_by_asc(child::Column::Id)
        .limit(MAX_CHILDREN)
        .into_partial_model::<ChildRow>()
        .all(db)
        .await?;
    // What each kind of consent says now: the latest answer for it, as
    // `families::current_consent` reads it, for every child at once.
    let answers = db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select distinct on (child_id, purpose) child_id, purpose, granted, created_at, source
             from consent_records
             where child_id in (select id from children where family_id = $1)
             order by child_id, purpose, created_at desc, id desc",
            [family_id.into()],
        ))
        .await?;
    let mut consents: HashMap<(Uuid, String), Value> = HashMap::new();
    for row in &answers {
        let answer = json!({
            "granted": row.try_get::<bool>("", "granted")?,
            "at": row.try_get::<DateTime<Utc>>("", "created_at")?,
            "source": row.try_get::<String>("", "source")?,
        });
        consents.insert((row.try_get("", "child_id")?, row.try_get("", "purpose")?), answer);
    }
    let now = Utc::now();
    let children: Vec<Value> = children
        .into_iter()
        .map(|child| {
            // A purpose never answered is not granted.
            let consent: Map<String, Value> = PURPOSES
                .iter()
                .map(|purpose| {
                    let answer = consents.remove(&(child.id, (*purpose).to_string()));
                    (
                        purpose.to_string(),
                        answer.unwrap_or_else(|| json!({ "granted": false, "at": null, "source": null })),
                    )
                })
                .collect();
            json!({
                "nickname": child.nickname,
                "age": age(child.birth_year, now),
                "grade": child.grade,
                "created_at": child.created_at,
                "consent": consent,
            })
        })
        .collect();
    let plans = subscription::Entity::find()
        .filter(subscription::Column::FamilyId.eq(family_id))
        .order_by_desc(subscription::Column::CreatedAt)
        .order_by_desc(subscription::Column::Id)
        .limit(MAX_PLANS)
        .into_partial_model::<PlanRow>()
        .all(db)
        .await?;
    let sessions = db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select count(*) filter (where s.started_at is not null) as started,
                    max(s.started_at) as last_started_at,
                    count(*) filter (where s.status <> 'ended') as open
             from sessions s join children c on c.id = s.child_id
             where c.family_id = $1",
            [family_id.into()],
        ))
        .await?;
    let sessions = match sessions {
        Some(row) => json!({
            "started": row.try_get::<i64>("", "started")?,
            "last_started_at": row.try_get::<Option<DateTime<Utc>>>("", "last_started_at")?,
            "open": row.try_get::<i64>("", "open")?,
        }),
        None => json!({ "started": 0, "last_started_at": null, "open": 0 }),
    };
    // The trial runs from the first session that counts, whatever plan the
    // family has now.
    let trial_started = plans::first_session(db, family_id).await?;
    let standing = plans::standing(&state, family_id, now).await?;
    Ok(Json(json!({
        "id": family_id,
        "name": name,
        "source": source,
        "created_at": created_at,
        "guardians": guardians,
        "children": children,
        "standing": standing.json(),
        "trial": {
            "started_at": trial_started,
            "ends_at": trial_started.map(|first| first + Duration::days(TRIAL_DAYS)),
        },
        "plans": plans,
        "sessions": sessions,
    })))
}

/// A family's sessions, newest first, as facts: when, how long, how it ended,
/// whether the engine ran it, from the web or a device, and which child. Open
/// ones and ones that never started are there too: the list shows what was
/// tried, and why it ended. A session the housekeeping closed has no known
/// length. Never what was said or what it was for.
pub async fn family_sessions(
    _: Staff,
    State(state): State<AppState>,
    Path(family_id): Path<Uuid>,
    Query(query): Query<PageQuery>,
) -> ApiResult<Json<Value>> {
    let (before, limit) = query.read()?;
    known_family(&state.db, family_id).await?;
    let rows = state
        .db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select s.id, s.created_at, s.started_at, s.status, s.end_reason, s.engine, s.audience,
                    s.device_id is not null as device, c.nickname,
                    case when s.started_at is not null and s.ended_at is not null
                              and s.ended_at < s.created_at + make_interval(hours => $2)
                         then extract(epoch from (s.ended_at - s.started_at))::float8 end as seconds
             from sessions s join children c on c.id = s.child_id
             where c.family_id = $1
               and ($3::timestamptz is null or (s.created_at, s.id) < ($3, $4::uuid))
             order by s.created_at desc, s.id desc
             limit $5",
            [
                family_id.into(),
                STALE_SESSION_HOURS.into(),
                before.map(|cursor| cursor.at).into(),
                before.map(|cursor| cursor.id).into(),
                (limit + 1).into(),
            ],
        ))
        .await?;
    let (rows, next) = paged(rows, limit)?;
    let sessions: Vec<Value> = rows
        .iter()
        .map(|row| {
            Ok(json!({
                "created_at": row.try_get::<DateTime<Utc>>("", "created_at")?,
                "started_at": row.try_get::<Option<DateTime<Utc>>>("", "started_at")?,
                "seconds": row.try_get::<Option<f64>>("", "seconds")?,
                "status": row.try_get::<String>("", "status")?,
                "end_reason": row.try_get::<Option<String>>("", "end_reason")?,
                "engine": row.try_get::<bool>("", "engine")?,
                "via": if row.try_get::<bool>("", "device")? { "device" } else { "web" },
                "child": row.try_get::<String>("", "nickname")?,
                "audience": row.try_get::<String>("", "audience")?,
            }))
        })
        .collect::<Result<_, DbErr>>()?;
    Ok(Json(json!({ "sessions": sessions, "next": next })))
}

/// The notices a family was sent, newest first: their kind, when, about which
/// child, and when they were read, mailed and pushed. Never their words: a
/// session's summary is written from what was said in it.
pub async fn family_notices(
    _: Staff,
    State(state): State<AppState>,
    Path(family_id): Path<Uuid>,
    Query(query): Query<PageQuery>,
) -> ApiResult<Json<Value>> {
    let (before, limit) = query.read()?;
    known_family(&state.db, family_id).await?;
    let rows = state
        .db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select n.id, n.created_at, n.kind, n.read_at, n.emailed_at, n.pushed_at, c.nickname
             from notices n left join children c on c.id = n.child_id
             where n.family_id = $1
               and ($2::timestamptz is null or (n.created_at, n.id) < ($2, $3::uuid))
             order by n.created_at desc, n.id desc
             limit $4",
            [
                family_id.into(),
                before.map(|cursor| cursor.at).into(),
                before.map(|cursor| cursor.id).into(),
                (limit + 1).into(),
            ],
        ))
        .await?;
    let (rows, next) = paged(rows, limit)?;
    let notices: Vec<Value> = rows
        .iter()
        .map(|row| {
            Ok(json!({
                "kind": row.try_get::<String>("", "kind")?,
                "created_at": row.try_get::<DateTime<Utc>>("", "created_at")?,
                "child": row.try_get::<Option<String>>("", "nickname")?,
                "read_at": row.try_get::<Option<DateTime<Utc>>>("", "read_at")?,
                "emailed_at": row.try_get::<Option<DateTime<Utc>>>("", "emailed_at")?,
                "pushed_at": row.try_get::<Option<DateTime<Utc>>>("", "pushed_at")?,
            }))
        })
        .collect::<Result<_, DbErr>>()?;
    Ok(Json(json!({ "notices": notices, "next": next })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cursor_reads_back_what_it_wrote() {
        let at = "2026-11-25T15:04:05.123456Z".parse::<DateTime<Utc>>().unwrap();
        let id = Uuid::parse_str("01a1f5f4-ede7-7028-a524-9d8e2f36b92d").unwrap();
        let written = Cursor::write(at, id);
        assert_eq!(written, "1795619045123456_01a1f5f4-ede7-7028-a524-9d8e2f36b92d");
        assert_eq!(Cursor::read(&written).unwrap(), Cursor { at, id });
    }

    #[test]
    fn anything_else_is_no_cursor() {
        for text in [
            "",
            "_",
            "1795619045123456",
            "1795619045123456_",
            "_01a1f5f4-ede7-7028-a524-9d8e2f36b92d",
            "-1_01a1f5f4-ede7-7028-a524-9d8e2f36b92d",
            "+1_01a1f5f4-ede7-7028-a524-9d8e2f36b92d",
            " 1_01a1f5f4-ede7-7028-a524-9d8e2f36b92d",
            "1.5_01a1f5f4-ede7-7028-a524-9d8e2f36b92d",
            "9999999999999999999_01a1f5f4-ede7-7028-a524-9d8e2f36b92d",
            "1_01A1F5F4-EDE7-7028-A524-9D8E2F36B92D",
            "1_01a1f5f4ede77028a5249d8e2f36b92d",
            "1_{01a1f5f4-ede7-7028-a524-9d8e2f36b92d}",
            "1_01a1f5f4-ede7-7028-a524-9d8e2f36b92d_2",
            "1_01a1f5f4-ede7-7028-a524-9d8e2f36b92",
        ] {
            assert!(Cursor::read(text).is_err(), "{text:?}");
        }
    }

    #[test]
    fn a_page_holds_what_was_asked_within_its_bounds() {
        assert_eq!(page_size(None, 20, 50).unwrap(), 20);
        assert_eq!(page_size(Some("7"), 20, 50).unwrap(), 7);
        assert_eq!(page_size(Some("0"), 20, 50).unwrap(), 1);
        assert_eq!(page_size(Some("-3"), 20, 50).unwrap(), 1);
        assert_eq!(page_size(Some("500"), 20, 50).unwrap(), 50);
        for bad in ["x", "1.5", "1e3", "99999999999999999999"] {
            assert!(page_size(Some(bad), 20, 50).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_search_finds_the_text_as_it_was_typed() {
        assert_eq!(search_pattern("ana@").unwrap(), "%ana@%");
        // The characters that mean something to `like` mean only themselves.
        assert_eq!(search_pattern("a_b").unwrap(), r"%a\_b%");
        assert_eq!(search_pattern("100%").unwrap(), r"%100\%%");
        assert_eq!(search_pattern(r"a\b").unwrap(), r"%a\\b%");
        assert!(search_pattern(&"a".repeat(100)).is_ok());
        assert!(search_pattern(&"a".repeat(101)).is_err());
        assert!(search_pattern("ana\nluis").is_err());
        assert!(search_pattern("ana\u{0}").is_err());
    }

    #[test]
    fn an_empty_value_is_not_given() {
        assert_eq!(given(&None), None);
        assert_eq!(given(&Some(String::new())), None);
        assert_eq!(given(&Some("  ".into())), None);
        assert_eq!(given(&Some(" cesar ".into())), Some("cesar"));
    }
}
