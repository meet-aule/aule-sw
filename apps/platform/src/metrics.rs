//! What the team reads to know how the tutor is doing: one row of numbers per
//! day, the pilot's four numbers per week of sign-ups, and how many children
//! come back and how much they talk. Everything here is a count, a rate or a
//! duration. No name, no id of a child and nothing anybody said is read or
//! returned.

use axum::Json;
use axum::extract::{Query, State};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, DbErr, Statement};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::auth::Staff;
use crate::error::ApiResult;
use crate::jobs::STALE_SESSION_HOURS;
use crate::plans::{SHORT_MINUTES, TRIAL_DAYS};
use crate::state::AppState;

const MAX_METRICS: usize = 40;
const MAX_NAME_CHARS: usize = 40;

/// The agent's own measurements, kept only when they are what they claim to
/// be: a small object of short lower-case names with finite numbers.
pub fn numbers_only(metrics: &Value) -> Option<Value> {
    let object = metrics.as_object()?;
    let kept: Map<String, Value> = object
        .iter()
        .filter(|(name, value)| {
            !name.is_empty()
                && name.chars().count() <= MAX_NAME_CHARS
                && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
                && value.as_f64().is_some_and(f64::is_finite)
        })
        .take(MAX_METRICS)
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    (!kept.is_empty()).then_some(Value::Object(kept))
}

// What a session costs ----------------------------------------------------------

// List prices in US dollars as published on 2026-11-20. They change: check
// them against the invoices.
// - Anthropic, per million tokens: Sonnet 5.5 $2 in, $10 out; Haiku 5.5 $0.10
//   in, $0.50 out. Cache reads at a tenth of the input price, cache writes
//   (five minutes) at 1.25 times it.
// - Deepgram Nova-3 streaming: $0.0077 a minute of audio sent (list price; a
//   promotion was at $0.0048).
// - AssemblyAI TTS-1: $15 per million characters.
// The tutor's model is the agent's default, `claude-sonnet-5-5`: the agent
// reports its tokens, not its model.
const TUTOR_MODEL: &str = "claude-sonnet-5-5";
const CACHE_READ: f64 = 0.1;
const CACHE_WRITE: f64 = 1.25;
const SPEECH_TO_TEXT_PER_MINUTE: f64 = 0.0077;
const VOICE_PER_MILLION_CHARACTERS: f64 = 15.0;

/// Input and output price per million tokens. A model not known here is
/// priced as the dearer one, so the estimate errs high.
fn model_price(model: &str) -> (f64, f64) {
    if model.contains("haiku") { (0.10, 0.50) } else { (2.0, 10.0) }
}

/// Tokens of one model, split the way they are billed.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Tokens {
    pub input: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub output: f64,
}

pub fn tokens_cost(model: &str, tokens: Tokens) -> f64 {
    let (input, output) = model_price(model);
    (tokens.input * input
        + tokens.cache_read * input * CACHE_READ
        + tokens.cache_write * input * CACHE_WRITE
        + tokens.output * output)
        / 1e6
}

/// Dollars, to the cent. A sum of nothing is -0.0 in floating point; it is shown as 0.
fn cents(value: f64) -> Value {
    let rounded = (value * 100.0).round() / 100.0;
    json!(if rounded == 0.0 { 0.0 } else { rounded })
}

/// What the sessions of each day cost, by service, from what the agent
/// reported at their end and what the platform's own model calls used.
async fn costs(db: &DatabaseConnection, days: i32, offset: i32) -> Result<Map<String, Value>, DbErr> {
    // The agent counts every prompt token, cached or not; the uncached part
    // is what is left after reads and writes.
    let agents = db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select ((created_at + make_interval(mins => $2))::date)::text as day,
                count(*) as sessions,
                coalesce(sum((agent_metrics->>'minutes')::float8), 0) as minutes,
                coalesce(sum((agent_metrics->>'input_tokens')::float8
                             - coalesce((agent_metrics->>'cached_input_tokens')::float8, 0)
                             - coalesce((agent_metrics->>'cache_write_tokens')::float8, 0)), 0) as input,
                coalesce(sum((agent_metrics->>'cached_input_tokens')::float8), 0) as cache_read,
                coalesce(sum((agent_metrics->>'cache_write_tokens')::float8), 0) as cache_write,
                coalesce(sum((agent_metrics->>'output_tokens')::float8), 0) as output,
                -- Older sessions did not report these: their length and the tutor's words stand in.
                coalesce(sum(coalesce((agent_metrics->>'stt_seconds')::float8,
                                      (agent_metrics->>'minutes')::float8 * 60)), 0) as heard,
                coalesce(sum(coalesce((agent_metrics->>'tts_chars')::float8, tutor_chars)), 0) as spoken
         from sessions
         where agent_metrics ? 'input_tokens' and created_at > now() - make_interval(days => $1 + 1)
         group by 1",
            [days.into(), offset.into()],
        ))
        .await?;
    let supervisors = db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "select ((s.created_at + make_interval(mins => $2))::date)::text as day, u.model,
                sum(u.input_tokens)::float8 as input, sum(u.cache_read_tokens)::float8 as cache_read,
                sum(u.cache_write_tokens)::float8 as cache_write, sum(u.output_tokens)::float8 as output
         from session_model_usage u join sessions s on s.id = u.session_id
         where s.created_at > now() - make_interval(days => $1 + 1)
         group by 1, 2",
            [days.into(), offset.into()],
        ))
        .await?;
    let supervisors = supervisors
        .iter()
        .map(|row| {
            Ok((
                row.try_get::<String>("", "day")?,
                row.try_get::<String>("", "model")?,
                row.try_get::<f64>("", "input")?,
                row.try_get::<f64>("", "cache_read")?,
                row.try_get::<f64>("", "cache_write")?,
                row.try_get::<f64>("", "output")?,
            ))
        })
        .collect::<Result<Vec<_>, DbErr>>()?;

    let mut by_day = Map::new();
    for row in agents {
        let day: String = row.try_get("", "day")?;
        let sessions: i64 = row.try_get("", "sessions")?;
        let minutes: f64 = row.try_get("", "minutes")?;
        let input: f64 = row.try_get("", "input")?;
        let cache_read: f64 = row.try_get("", "cache_read")?;
        let cache_write: f64 = row.try_get("", "cache_write")?;
        let output: f64 = row.try_get("", "output")?;
        let heard: f64 = row.try_get("", "heard")?;
        let spoken: f64 = row.try_get("", "spoken")?;
        let tutor = tokens_cost(TUTOR_MODEL, Tokens { input, cache_read, cache_write, output });
        let speech_to_text = heard / 60.0 * SPEECH_TO_TEXT_PER_MINUTE;
        let voice = spoken / 1e6 * VOICE_PER_MILLION_CHARACTERS;
        let supervisor: f64 = supervisors
            .iter()
            .filter(|row| row.0 == day)
            .map(|(_, model, input, cache_read, cache_write, output)| {
                let tokens = Tokens {
                    input: *input,
                    cache_read: *cache_read,
                    cache_write: *cache_write,
                    output: *output,
                };
                tokens_cost(model, tokens)
            })
            .sum();
        let total = tutor + speech_to_text + voice + supervisor;
        by_day.insert(
            day,
            json!({
                "sessions": sessions,
                "minutes": (minutes * 10.0).round() / 10.0,
                "tutor": cents(tutor),
                "speech_to_text": cents(speech_to_text),
                "voice": cents(voice),
                "supervisor": cents(supervisor),
                "total": cents(total),
                "per_hour": if minutes > 0.0 { cents(total / minutes * 60.0) } else { Value::Null },
            }),
        );
    }
    Ok(by_day)
}

#[derive(Deserialize)]
pub struct DailyQuery {
    #[serde(default)]
    days: Option<i32>,
}

/// One object per day, newest first, in the server's configured local time.
pub async fn daily(
    _: Staff,
    State(state): State<AppState>,
    Query(query): Query<DailyQuery>,
) -> ApiResult<Json<Value>> {
    let days = query.days.unwrap_or(14).clamp(1, 90);
    let offset = state.config.timezone_offset_minutes;
    let rows = state
        .db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "with bounds as (
           select d::date as day
           from generate_series(
             ((now() + make_interval(mins => $2))::date - ($1 - 1)),
             (now() + make_interval(mins => $2))::date,
             interval '1 day') d
         ),
         s as (
           select *, (created_at + make_interval(mins => $2))::date as day,
                  extract(epoch from (ended_at - coalesce(started_at, created_at))) as seconds
           from sessions
           where created_at > now() - make_interval(days => $1 + 1)
         ),
         e as (
           select x.*, s.day from session_exercises x join s on s.id = x.session_id
         ),
         f as (
           select g.gate, g.action, s.day, g.session_id from session_flags g join s on s.id = g.session_id
         )
         select jsonb_build_object(
           'day', b.day,
           'sessions', jsonb_build_object(
             'started', (select count(*) from s where s.day = b.day and started_at is not null),
             'as_child', (select count(*) from s where s.day = b.day and audience = 'child' and started_at is not null),
             'never_started', (select count(*) from s where s.day = b.day and started_at is null),
             'under_a_minute', (select count(*) from s where s.day = b.day and seconds < 60),
             'median_minutes', (select round((percentile_cont(0.5) within group (order by seconds) / 60)::numeric, 1)
                                from s where s.day = b.day and seconds is not null),
             'median_seconds_to_start', (select round(percentile_cont(0.5) within group (
                                           order by extract(epoch from (started_at - created_at)))::numeric, 1)
                                         from s where s.day = b.day and started_at is not null),
             'students', (select count(distinct child_id) from s where s.day = b.day and child_id is not null)
           ),
           'talk', jsonb_build_object(
             'child_turns', (select sum(child_turns) from s where s.day = b.day),
             'tutor_turns', (select sum(tutor_turns) from s where s.day = b.day),
             'tutor_share_of_words', (select round((sum(tutor_chars)::numeric
                                        / nullif(sum(tutor_chars) + sum(child_chars), 0)), 2)
                                      from s where s.day = b.day)
           ),
           'exercises', jsonb_build_object(
             'posed', (select count(*) from e where e.day = b.day),
             'not_checkable', (select coalesce(sum(unchecked_exercises), 0) from s where s.day = b.day),
             'correct', (select count(*) from e where e.day = b.day and status = 'correct'),
             'failed', (select count(*) from e where e.day = b.day and status = 'failed'),
             'left_open', (select count(*) from e where e.day = b.day and status = 'dropped'),
             'first_try_rate', (select round(avg(case when first_try then 1 else 0 end)::numeric, 2)
                                from e where e.day = b.day and not probe and status in ('correct', 'failed')),
             'hints_per_exercise', (select round(avg(hints)::numeric, 2)
                                    from e where e.day = b.day and not probe and status in ('correct', 'failed')),
             'answer_given_away', (select count(*) from e where e.day = b.day and answer_said),
             'sessions_with_one', (select count(distinct session_id) from e where e.day = b.day)
           ),
           'safety', jsonb_build_object(
             'turns_stopped', (select count(*) from f where f.day = b.day),
             'sessions_with_a_stop', (select count(distinct session_id) from f where f.day = b.day),
             'by_gate_and_action', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (
                                      select gate || ':' || action as k, count(*) as n
                                      from f where f.day = b.day group by 1) t)
           ),
           'not_working', jsonb_build_object(
             'warned', (select count(*) from s where s.day = b.day and stop_step is not null),
             'closed', (select count(*) from s where s.day = b.day and stop_step = 'end')
           ),
           'breaks', jsonb_build_object(
             'taken', (select coalesce(sum(breaks), 0) from s where s.day = b.day),
             'sessions_with_one', (select count(*) from s where s.day = b.day and breaks > 0)
           ),
           'agent', (select coalesce(jsonb_object_agg(name, value), '{}'::jsonb) from (
                       select m.key as name, round(avg((m.value)::text::numeric), 2) as value
                       from s, jsonb_each(s.agent_metrics) m
                       where s.day = b.day and jsonb_typeof(m.value) = 'number'
                       group by m.key) t),
           'family', jsonb_build_object(
             'reviews', (select count(*) from session_reviews r join s on s.id = r.session_id where s.day = b.day),
             'notices', (select count(*) from notices n
                         where (n.created_at + make_interval(mins => $2))::date = b.day),
             'notices_emailed', (select count(*) from notices n
                                 where (n.created_at + make_interval(mins => $2))::date = b.day
                                   and n.emailed_at is not null)
           )
         )
         from bounds b order by b.day desc",
            [days.into(), offset.into()],
        ))
        .await?;
    let costs = costs(&state.db, days, offset).await?;
    let days: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mut day: Value = row.try_get_by_index(0)?;
            let cost = day["day"].as_str().and_then(|name| costs.get(name)).cloned();
            day["cost_usd"] = cost.unwrap_or(Value::Null);
            Ok(day)
        })
        .collect::<Result<_, DbErr>>()?;
    Ok(Json(json!({ "timezone_offset_minutes": offset, "days": days })))
}

// The pilot's four numbers ---------------------------------------------------------

/// A family has started once one of its sessions lasted this long.
const STARTED_MINUTES: i32 = 10;
/// Sessions in the seven days from its first that make a family one that came back.
const REPEAT_SESSIONS: i64 = 3;
/// A plan the team ended this soon after granting it was undone, not paid for.
const UNDONE_GRANT_HOURS: i32 = 24;

#[derive(Deserialize)]
pub struct WeeklyQuery {
    #[serde(default)]
    weeks: Option<i32>,
}

/// The families that signed up each week, in the server's local time, newest
/// first, by the link they came from, and the pilot's four numbers for them.
/// A number that takes time is counted only among the families whose time for
/// it is over, so a week still running does not read low:
///
/// - `started`: a session of ten minutes or more, out of all of them;
/// - `repeated`: three sessions in the seven days from their first, out of
///   `week1_over`, those whose seven days are over (their trial with them);
/// - `week4`: a session on days 21 to 27 from their first, out of
///   `week4_over`, those whose fourth week is over;
/// - `paying`: out of `week1_over` as well. Nobody can pay in the app yet, so
///   a plan the team granted once a family's trial was over counts as paid,
///   unless the team ended it within a day.
///
/// Sessions count as they do for the plan (`plans`), and the team's own
/// families are left out.
///
/// Next to them, two numbers about children rather than families, in the same
/// weeks (from the oldest one's Monday at midnight, local time) and from child
/// sessions only, counted as for the plan:
///
/// - `children`: those whose first session falls in these weeks
///   (`with_a_session`), and of them the ones with a second within seven days
///   of it: `back_in_week1` out of `week1_over`, those whose seven days are
///   over, and `back_so_far` out of all of them;
/// - `talk`: `median_child_turns_per_minute`, the median over the sessions
///   started in these weeks with a known length of the child's turns per
///   minute from start to end, breaks included, to one decimal (null when
///   there is none), and how many `sessions` that is.
pub async fn weekly(
    _: Staff,
    State(state): State<AppState>,
    Query(query): Query<WeeklyQuery>,
) -> ApiResult<Json<Value>> {
    let weeks = query.weeks.unwrap_or(12).clamp(1, 52);
    let offset = state.config.timezone_offset_minutes;
    // The addresses were checked at start: none has a comma.
    let team = state.config.admin_emails.join(",");
    let rows = state
        .db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "with counted as (
           select children.family_id, sessions.started_at
           from sessions join children on children.id = sessions.child_id
           where sessions.started_at is not null
             and (sessions.ended_at is null or sessions.ended_at - sessions.started_at >= make_interval(mins => $3))
         ),
         cohort as (
           select families.id, families.source,
                  date_trunc('week', (families.created_at at time zone 'UTC') + make_interval(mins => $1))::date as week,
                  (select min(counted.started_at) from counted where counted.family_id = families.id) as first
           from families
           where not exists (select 1 from guardians where guardians.family_id = families.id
                               and guardians.email = any(string_to_array($2, ',')))
         ),
         -- One line per family. A family with no session yet has no first one,
         -- so its weeks are null: never over.
         per_family as (
           select cohort.week, cohort.source,
             exists (
               select 1 from sessions join children on children.id = sessions.child_id
               where children.family_id = cohort.id
                 and sessions.ended_at - sessions.started_at >= make_interval(mins => $5)
                 -- One the housekeeping closed hours later has no known length.
                 and sessions.ended_at < sessions.created_at + make_interval(hours => $6)) as started,
             cohort.first <= now() - interval '7 days' as week1_over,
             (select count(*) from counted where counted.family_id = cohort.id
                and counted.started_at < cohort.first + interval '7 days') >= $7 as repeated,
             cohort.first <= now() - interval '28 days' as week4_over,
             exists (
               select 1 from counted where counted.family_id = cohort.id
                 and counted.started_at >= cohort.first + interval '21 days'
                 and counted.started_at < cohort.first + interval '28 days') as week4,
             exists (
               select 1 from subscriptions where subscriptions.family_id = cohort.id
                 and subscriptions.ends_at - subscriptions.starts_at >= make_interval(hours => $9)
                 and (subscriptions.plan = 'paid'
                      or subscriptions.starts_at >= cohort.first + make_interval(days => $8))) as paying
           from cohort
           where cohort.week > date_trunc('week', (now() at time zone 'UTC') + make_interval(mins => $1))::date - 7 * $4
         )
         select week::text as week, source, count(*) as families,
           count(*) filter (where started) as started,
           count(*) filter (where week1_over) as week1_over,
           count(*) filter (where week1_over and repeated) as repeated,
           count(*) filter (where week4_over) as week4_over,
           count(*) filter (where week4_over and week4) as week4,
           count(*) filter (where week1_over and paying) as paying
         from per_family
         group by week, source
         order by week desc, source nulls last",
            [
                offset.into(),
                team.as_str().into(),
                SHORT_MINUTES.into(),
                weeks.into(),
                STARTED_MINUTES.into(),
                STALE_SESSION_HOURS.into(),
                REPEAT_SESSIONS.into(),
                (TRIAL_DAYS as i32).into(),
                UNDONE_GRANT_HOURS.into(),
            ],
        ))
        .await?;
    let count = |row: &sea_orm::QueryResult, name: &str| row.try_get::<i64>("", name);
    let cohorts: Vec<Value> = rows
        .iter()
        .map(|row| {
            Ok(json!({
                "week": row.try_get::<String>("", "week")?,
                "source": row.try_get::<Option<String>>("", "source")?,
                "families": count(row, "families")?,
                "started": count(row, "started")?,
                "week1_over": count(row, "week1_over")?,
                "repeated": count(row, "repeated")?,
                "week4_over": count(row, "week4_over")?,
                "week4": count(row, "week4")?,
                "paying": count(row, "paying")?,
            }))
        })
        .collect::<Result<_, DbErr>>()?;
    let (children, talk) = children_and_talk(&state.db, weeks, offset, &team).await?;
    Ok(Json(json!({
        "timezone_offset_minutes": offset,
        "weeks": weeks,
        "cohorts": cohorts,
        "children": children,
        "talk": talk,
    })))
}

/// `weekly()`'s `children` and `talk`, without the team's children.
async fn children_and_talk(
    db: &DatabaseConnection,
    weeks: i32,
    offset: i32,
    team: &str,
) -> Result<(Value, Value), DbErr> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "with counted as (
           select sessions.child_id, sessions.created_at, sessions.started_at, sessions.ended_at,
                  sessions.child_turns
           from sessions join children on children.id = sessions.child_id
           where sessions.audience = 'child' and sessions.started_at is not null
             and (sessions.ended_at is null or sessions.ended_at - sessions.started_at >= make_interval(mins => $3))
             and not exists (select 1 from guardians where guardians.family_id = children.family_id
                               and guardians.email = any(string_to_array($2, ',')))
         ),
         -- The cohorts' weeks, this one included: from the oldest one's Monday,
         -- at midnight in the configured local time.
         since as (
           select (date_trunc('week', (now() at time zone 'UTC') + make_interval(mins => $5))
                   - make_interval(weeks => $1 - 1, mins => $5)) at time zone 'UTC' as at
         ),
         firsts as (
           select child_id, min(started_at) as first from counted group by child_id
           having min(started_at) >= (select at from since)
         ),
         per_child as (
           select first, exists (select 1 from counted where counted.child_id = firsts.child_id
                                   and counted.started_at > firsts.first
                                   and counted.started_at < firsts.first + interval '7 days') as back
           from firsts
         ),
         -- From the sessions that count too: a slip of a few seconds with one
         -- turn in it would read as several turns a minute.
         talked as (
           select child_turns::float8 / (extract(epoch from (ended_at - started_at))::float8 / 60) as per_minute
           from counted
           where started_at >= (select at from since)
             and ended_at > started_at and child_turns is not null
             -- One the housekeeping closed hours later has no known length.
             and ended_at < created_at + make_interval(hours => $4)
         )
         select
           (select count(*) from per_child) as with_a_session,
           (select count(*) from per_child where first <= now() - interval '7 days') as week1_over,
           (select count(*) from per_child where first <= now() - interval '7 days' and back) as back_in_week1,
           (select count(*) from per_child where back) as back_so_far,
           (select round((percentile_cont(0.5) within group (order by per_minute))::numeric, 1)::float8
            from talked) as median,
           (select count(*) from talked) as sessions",
            [weeks.into(), team.into(), SHORT_MINUTES.into(), STALE_SESSION_HOURS.into(), offset.into()],
        ))
        .await?
        .ok_or_else(|| DbErr::Custom("the children's numbers came back without a row".into()))?;
    let count = |name: &str| row.try_get::<i64>("", name);
    let children = json!({
        "with_a_session": count("with_a_session")?,
        "week1_over": count("week1_over")?,
        "back_in_week1": count("back_in_week1")?,
        "back_so_far": count("back_so_far")?,
    });
    let talk = json!({
        "median_child_turns_per_minute": row.try_get::<Option<f64>>("", "median")?,
        "sessions": count("sessions")?,
    });
    Ok((children, talk))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_priced_the_way_they_are_billed() {
        let million =
            |input, cache_read, cache_write, output| Tokens { input, cache_read, cache_write, output };
        // A million of each, on the tutor's model: 2 + 0.2 + 2.5 + 10.
        assert!((tokens_cost("claude-sonnet-5-5", million(1e6, 1e6, 1e6, 1e6)) - 14.7).abs() < 1e-9);
        assert!((tokens_cost("claude-haiku-5-5", million(1e6, 0.0, 0.0, 1e6)) - 0.6).abs() < 1e-9);
        // An unknown model is priced high, not free.
        assert!(tokens_cost("some-new-model", million(1e6, 0.0, 0.0, 0.0)) >= 2.0);
        assert_eq!(cents(0.126), json!(0.13));
        assert_eq!(cents(std::iter::empty::<f64>().sum()).to_string(), "0.0");
    }

    #[test]
    fn only_named_numbers_are_kept_from_what_the_agent_reports() {
        let kept = numbers_only(&json!({
            "first_word_ms": 2600,
            "stt_confidence": 0.91,
            "note": "the student said hello",
            "Bad Name": 3,
            "nested": { "a": 1 },
            "nothing": null
        }))
        .unwrap();
        assert_eq!(kept, json!({ "first_word_ms": 2600, "stt_confidence": 0.91 }));
        assert!(numbers_only(&json!({ "note": "words" })).is_none());
        assert!(numbers_only(&json!([1, 2, 3])).is_none());
    }
}
