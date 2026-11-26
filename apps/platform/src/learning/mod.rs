//! What each child knows. The model itself is [`skill_model`], a pure
//! function of the child's history; this module stores that history, keeps
//! the difficulty of questions calibrated, and picks what to work on next.

pub mod skill_model;

use std::collections::{BTreeMap, BTreeSet};

use chrono::{DateTime, Utc};
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseConnection, DbBackend, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect, Statement, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::entity::{attempt, correction, item_difficulty, skill};
use crate::error::{ApiError, ApiResult};
use skill_model::{Correction, LearnerModel, Params, SkillTrace, TraceAttempt, TraceRequest, TraceResponse};

/// Skill and question ids are slugs, so one coming from a language model can
/// be checked before it is stored.
pub fn is_slug(id: &str) -> bool {
    let mut chars = id.chars();
    id.len() <= 80
        && chars.next().is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
}

#[derive(Clone, Debug, Deserialize)]
pub struct NewAttempt {
    pub skill_id: String,
    #[serde(default)]
    pub question_id: Option<String>,
    pub correct: bool,
    /// Partial credit from 0 to 1. Defaults to 1 or 0 from `correct`.
    #[serde(default)]
    pub credit: Option<f64>,
    /// A multiple-choice question, which can be answered right by chance.
    #[serde(default)]
    pub choice: bool,
    #[serde(default)]
    pub at: Option<DateTime<Utc>>,
}

impl NewAttempt {
    pub fn validate(&self) -> Result<(), String> {
        if !is_slug(&self.skill_id) {
            return Err(format!("skill_id {:?} is not a valid id", self.skill_id));
        }
        if self.question_id.as_deref().is_some_and(|id| !is_slug(id)) {
            return Err("question_id is not a valid id".into());
        }
        if self.credit.is_some_and(|credit| !(0.0..=1.0).contains(&credit)) {
            return Err("credit must be a number between 0 and 1".into());
        }
        Ok(())
    }
}

async fn history(
    db: &impl ConnectionTrait,
    child_id: Uuid,
) -> Result<(Vec<TraceAttempt>, Vec<Correction>), sea_orm::DbErr> {
    let attempts = attempt::Entity::find()
        .filter(attempt::Column::ChildId.eq(child_id))
        .order_by_asc(attempt::Column::At)
        .order_by_asc(attempt::Column::Id)
        .limit(skill_model::MAX_ATTEMPTS as u64)
        .all(db)
        .await?;
    let corrections = correction::Entity::find()
        .filter(correction::Column::ChildId.eq(child_id))
        .order_by_asc(correction::Column::At)
        .order_by_asc(correction::Column::Id)
        .limit(skill_model::MAX_CORRECTIONS as u64)
        .all(db)
        .await?;
    Ok((
        attempts
            .into_iter()
            .map(|row| TraceAttempt {
                skill_id: row.skill_id,
                question_id: row.question_id,
                correct: row.correct,
                credit: row.credit,
                at: row.at,
                choice: row.choice,
                difficulty: row.difficulty,
            })
            .collect(),
        corrections
            .into_iter()
            .map(|row| Correction { skill_id: row.skill_id, at: row.at, level: row.level })
            .collect(),
    ))
}

/// The model after the child's whole history, in the same order
/// [`skill_model::trace`] replays it: by time, attempts before corrections.
pub fn replay(attempts: &[TraceAttempt], corrections: &[Correction], params: Params) -> LearnerModel {
    enum Event<'a> {
        Attempt(&'a TraceAttempt),
        Correction(&'a Correction),
    }
    let mut events: Vec<(DateTime<Utc>, u8, Event)> = attempts
        .iter()
        .map(|attempt| (attempt.at, 0, Event::Attempt(attempt)))
        .chain(corrections.iter().map(|correction| (correction.at, 1, Event::Correction(correction))))
        .collect();
    events.sort_by_key(|(at, kind, _)| (*at, *kind));

    let mut model = LearnerModel::new(params);
    for (at, _, event) in events {
        match event {
            Event::Attempt(attempt) => {
                let credit = attempt.credit.unwrap_or(if attempt.correct { 1.0 } else { 0.0 });
                model.observe(
                    &attempt.skill_id,
                    attempt.difficulty.unwrap_or(0.0),
                    attempt.choice,
                    credit,
                    at,
                );
            }
            Event::Correction(correction) => model.correct(&correction.skill_id, correction.level, at),
        }
    }
    model
}

/// What the child knows now.
pub async fn trace_child(
    db: &DatabaseConnection,
    child_id: Uuid,
    now: DateTime<Utc>,
) -> ApiResult<TraceResponse> {
    let txn = db.begin().await?;
    let (attempts, corrections) = history(&txn, child_id).await?;
    txn.commit().await?;
    skill_model::trace(&TraceRequest { now: Some(now), attempts, corrections, params: Params::default() })
        .map_err(ApiError::Internal)
}

/// Reads the calibrated difficulty of a skill or question, locking its row so
/// two answers to the same question update it one after the other.
async fn locked_difficulty(
    db: &impl ConnectionTrait,
    skill_id: &str,
    question_id: &str,
) -> Result<(f64, i32), sea_orm::DbErr> {
    item_difficulty::Entity::insert(item_difficulty::ActiveModel {
        skill_id: Set(skill_id.to_string()),
        question_id: Set(question_id.to_string()),
        ..Default::default()
    })
    .on_conflict_do_nothing()
    .exec_without_returning(db)
    .await?;
    let row = item_difficulty::Entity::find_by_id((skill_id.to_string(), question_id.to_string()))
        .lock_exclusive()
        .one(db)
        .await?
        .ok_or_else(|| sea_orm::DbErr::RecordNotFound("item_difficulty".into()))?;
    Ok((row.value, row.answers))
}

/// Records answers. Each one moves the child's model and, with the same
/// signal, the difficulty of the question and of its skill: an answer most
/// children get wrong becomes a harder question for everyone.
pub async fn record(
    db: &DatabaseConnection,
    child_id: Uuid,
    session_id: Option<Uuid>,
    source: &str,
    attempts: &[NewAttempt],
    now: DateTime<Utc>,
) -> ApiResult<usize> {
    for attempt in attempts {
        attempt.validate().map_err(ApiError::BadRequest)?;
    }
    let mut ordered: Vec<(DateTime<Utc>, &NewAttempt)> =
        attempts.iter().map(|attempt| (attempt.at.unwrap_or(now).min(now), attempt)).collect();
    ordered.sort_by_key(|(at, _)| *at);

    let params = Params::default();
    let txn = db.begin().await?;
    // One writer per child at a time, so the replay below is the real history.
    txn.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "select pg_advisory_xact_lock(hashtextextended($1::text, 0))",
        [child_id.into()],
    ))
    .await?;
    let (past, corrections) = history(&txn, child_id).await?;
    let mut model = replay(&past, &corrections, params);

    for (at, attempt) in &ordered {
        let (skill_value, skill_answers) = locked_difficulty(&txn, &attempt.skill_id, "").await?;
        let question = match attempt.question_id.as_deref() {
            Some(question_id) => {
                Some((question_id, locked_difficulty(&txn, &attempt.skill_id, question_id).await?))
            }
            None => None,
        };
        let difficulty = skill_value + question.map_or(0.0, |(_, (value, _))| value);
        let credit = attempt.credit.unwrap_or(if attempt.correct { 1.0 } else { 0.0 });
        let signal = model.observe(&attempt.skill_id, difficulty, attempt.choice, credit, *at);

        attempt::Entity::insert(attempt::ActiveModel {
            id: Set(Uuid::now_v7()),
            child_id: Set(child_id),
            session_id: Set(session_id),
            skill_id: Set(attempt.skill_id.clone()),
            question_id: Set(attempt.question_id.clone()),
            correct: Set(attempt.correct),
            credit: Set(attempt.credit),
            choice: Set(attempt.choice),
            difficulty: Set(Some(difficulty)),
            source: Set(source.to_string()),
            at: Set(*at),
            ..Default::default()
        })
        .exec_without_returning(&txn)
        .await?;

        let mut updates = vec![("", skill_value, skill_answers)];
        if let Some((question_id, (value, answers))) = question {
            updates.push((question_id, value, answers));
        }
        for (question_id, value, answers) in updates {
            item_difficulty::Entity::update_many()
                .col_expr(
                    item_difficulty::Column::Value,
                    Expr::value(params.item_update(value, answers.max(0) as u32, signal)),
                )
                .col_expr(
                    item_difficulty::Column::Answers,
                    sea_orm::sea_query::ExprTrait::add(Expr::col(item_difficulty::Column::Answers), 1),
                )
                .filter(item_difficulty::Column::SkillId.eq(&attempt.skill_id))
                .filter(item_difficulty::Column::QuestionId.eq(question_id))
                .exec(&txn)
                .await?;
        }
    }
    txn.commit().await?;
    Ok(ordered.len())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Skill {
    pub id: String,
    pub subject: String,
    pub name: String,
    #[serde(default)]
    pub grade: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub prerequisites: Vec<String>,
}

impl From<skill::Model> for Skill {
    fn from(row: skill::Model) -> Self {
        Self {
            id: row.id,
            subject: row.subject,
            name: row.name,
            grade: row.grade,
            description: row.description,
            prerequisites: row.prerequisites,
        }
    }
}

pub async fn catalog(db: &DatabaseConnection) -> ApiResult<Vec<Skill>> {
    let rows = skill::Entity::find().order_by_asc(skill::Column::Id).all(db).await?;
    Ok(rows.into_iter().map(Skill::from).collect())
}

pub async fn upsert_skills(db: &DatabaseConnection, skills: &[Skill]) -> ApiResult<usize> {
    for skill in skills {
        if !is_slug(&skill.id) || skill.prerequisites.iter().any(|id| !is_slug(id)) {
            return Err(ApiError::bad_request(format!(
                "skill id {:?} or one of its prerequisites is not valid",
                skill.id
            )));
        }
    }
    let txn = db.begin().await?;
    for one in skills {
        skill::Entity::insert(skill::ActiveModel {
            id: Set(one.id.clone()),
            subject: Set(one.subject.clone()),
            name: Set(one.name.clone()),
            grade: Set(one.grade.clone()),
            description: Set(one.description.clone()),
            prerequisites: Set(one.prerequisites.clone()),
        })
        .on_conflict(
            OnConflict::column(skill::Column::Id)
                .update_columns([
                    skill::Column::Subject,
                    skill::Column::Name,
                    skill::Column::Grade,
                    skill::Column::Description,
                    skill::Column::Prerequisites,
                ])
                .to_owned(),
        )
        .exec_without_returning(&txn)
        .await?;
    }
    txn.commit().await?;
    Ok(skills.len())
}

/// School grades are codes that sort in school order: `P1` to `P6` for
/// primary, `S1` to `S5` for secondary.
pub fn is_grade(grade: &str) -> bool {
    matches!(grade.as_bytes(), [b'P', b'1'..=b'6'] | [b'S', b'1'..=b'5'])
}

/// Why a skill is worth working on in the next session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    /// Known, and about to be forgotten.
    ReviewDue,
    /// Started and not yet mastered.
    InProgress,
    /// Not seen yet, and everything it builds on is mastered.
    Ready,
    /// What the family said today's session is about.
    Asked,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Candidate {
    pub skill_id: String,
    pub name: Option<String>,
    pub reason: Reason,
    /// Chance of a right answer today on an average question, if known.
    pub p_now: Option<f64>,
    /// Difficulty (logit) at which the child would get about four in five right.
    pub target_difficulty: Option<f64>,
}

pub const MAX_CANDIDATES_PER_REASON: usize = 3;

/// Lower case without accents, cut into words.
fn words(text: &str) -> Vec<String> {
    let plain: String = text
        .to_lowercase()
        .chars()
        .map(|letter| match letter {
            'á' | 'à' | 'ä' => 'a',
            'é' | 'è' | 'ë' => 'e',
            'í' | 'ì' | 'ï' => 'i',
            'ó' | 'ò' | 'ö' => 'o',
            'ú' | 'ù' | 'ü' => 'u',
            other => other,
        })
        .collect();
    plain
        .split(|letter: char| !letter.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(String::from)
        .collect()
}

/// Whether today's objective is for something the catalog cannot name: no
/// skill matches its topic and the catalog holds no skill of its subject. Such
/// a session is planned for the objective alone, since every other skill on
/// offer belongs to another subject. The family's subjects
/// (`families::SUBJECTS`) are named in Spanish; the catalog's are not.
pub fn beyond_catalog(subject: &str, asked: &[Candidate], catalog: &[Skill]) -> bool {
    let subject = match subject {
        "matematica" => "math",
        other => other,
    };
    asked.is_empty() && !catalog.iter().any(|skill| skill.subject == subject)
}

/// The skills that the topic of today's session names, best match first. A
/// homework on perimeter is about the perimeter skills whether or not the
/// learner model would have offered them today, so these come from the whole
/// catalog up to the student's grade. Words are compared by their first
/// letters: "triángulos" finds "triángulo", and "multiplication" finds
/// "multiplicación".
pub fn asked(trace: &[SkillTrace], catalog: &[Skill], grade: Option<&str>, topic: &str) -> Vec<Candidate> {
    const STEM: usize = 5;
    let stems: BTreeSet<String> = words(topic)
        .into_iter()
        .filter(|word| word.chars().count() >= 4)
        .map(|word| word.chars().take(STEM).collect())
        .collect();
    if stems.is_empty() {
        return Vec::new();
    }
    let traced: BTreeMap<&str, &SkillTrace> =
        trace.iter().map(|skill| (skill.skill_id.as_str(), skill)).collect();
    let mut found: Vec<(BTreeSet<&String>, &Skill)> = catalog
        .iter()
        .filter(|skill| match (skill.grade.as_deref(), grade) {
            (Some(skill_grade), Some(child_grade)) if is_grade(skill_grade) && is_grade(child_grade) => {
                skill_grade <= child_grade
            }
            _ => true,
        })
        .filter_map(|skill| {
            let named = words(&format!("{} {}", skill.id, skill.name));
            let hits: BTreeSet<&String> = stems
                .iter()
                .filter(|stem| named.iter().any(|word| word.starts_with(stem.as_str())))
                .collect();
            (!hits.is_empty()).then_some((hits, skill))
        })
        .collect();
    // Most words in common first; among equals, the student's own grade.
    found.sort_by_key(|(hits, skill)| {
        (usize::MAX - hits.len(), grade.is_none() || skill.grade.as_deref() != grade)
    });
    // A topic can name two things ("la hora y las tablas"): each gets a skill
    // before any gets a second one.
    let mut covered: BTreeSet<&String> = BTreeSet::new();
    let mut chosen: Vec<&Skill> = Vec::new();
    for (hits, skill) in &found {
        if chosen.len() < MAX_CANDIDATES_PER_REASON && !hits.is_subset(&covered) {
            covered.extend(hits.iter().copied());
            chosen.push(skill);
        }
    }
    for (_, skill) in &found {
        if chosen.len() < MAX_CANDIDATES_PER_REASON && !chosen.iter().any(|taken| taken.id == skill.id) {
            chosen.push(skill);
        }
    }
    chosen
        .into_iter()
        .map(|skill| {
            let known = traced.get(skill.id.as_str());
            Candidate {
                skill_id: skill.id.clone(),
                name: Some(skill.name.clone()),
                reason: Reason::Asked,
                p_now: known.map(|skill| skill.p_now),
                target_difficulty: known.map(|skill| skill.target_difficulty),
            }
        })
        .collect()
}

/// The skills worth offering to whoever plans the session, most useful first
/// within each reason. It narrows the choice; it does not make it.
pub fn candidates(
    trace: &[SkillTrace],
    catalog: &[Skill],
    grade: Option<&str>,
    now: DateTime<Utc>,
) -> Vec<Candidate> {
    let names: BTreeMap<&str, &Skill> = catalog.iter().map(|skill| (skill.id.as_str(), skill)).collect();
    let traced: BTreeMap<&str, &SkillTrace> =
        trace.iter().map(|skill| (skill.skill_id.as_str(), skill)).collect();
    let mastered: BTreeSet<&str> =
        trace.iter().filter(|skill| skill.mastered).map(|skill| skill.skill_id.as_str()).collect();
    let from_trace = |skill: &SkillTrace, reason| Candidate {
        skill_id: skill.skill_id.clone(),
        name: names.get(skill.skill_id.as_str()).map(|entry| entry.name.clone()),
        reason,
        p_now: Some(skill.p_now),
        target_difficulty: Some(skill.target_difficulty),
    };

    // Most forgotten first.
    let mut due: Vec<&SkillTrace> = trace
        .iter()
        .filter(|skill| skill.p_known >= 0.6 && skill.review_at.is_some_and(|review_at| review_at <= now))
        .collect();
    due.sort_by(|a, b| a.p_now.total_cmp(&b.p_now));
    let due_ids: BTreeSet<&str> = due.iter().map(|skill| skill.skill_id.as_str()).collect();

    // Closest to mastery first: the next success is the most motivating one.
    let mut in_progress: Vec<&SkillTrace> =
        trace.iter().filter(|skill| !skill.mastered && !due_ids.contains(skill.skill_id.as_str())).collect();
    in_progress.sort_by(|a, b| b.p_now.total_cmp(&a.p_now));

    // A skill is ready when what it builds on is mastered. With no evidence
    // either way, a child is assumed to know what earlier grades taught: a
    // fourth grader starts with fourth-grade work, and the first wrong answers
    // on a prerequisite put it back on the list as a skill in progress.
    let assumed = |id: &str| {
        let earlier = names.get(id).and_then(|skill| skill.grade.as_deref()).zip(grade).is_some_and(
            |(skill_grade, child_grade)| {
                is_grade(skill_grade) && is_grade(child_grade) && skill_grade < child_grade
            },
        );
        earlier && !traced.contains_key(id)
    };
    // The child's own grade first, then catalog order. Skills of later grades wait.
    let mut ready: Vec<&Skill> = catalog
        .iter()
        .filter(|skill| !traced.contains_key(skill.id.as_str()) && !assumed(&skill.id))
        .filter(|skill| skill.prerequisites.iter().all(|id| mastered.contains(id.as_str()) || assumed(id)))
        .filter(|skill| match (skill.grade.as_deref(), grade) {
            (Some(skill_grade), Some(child_grade)) if is_grade(skill_grade) && is_grade(child_grade) => {
                skill_grade <= child_grade
                    || (!skill.prerequisites.is_empty()
                        && skill.prerequisites.iter().all(|id| mastered.contains(id.as_str())))
            }
            _ => true,
        })
        .collect();
    ready.sort_by_key(|skill| grade.is_none() || skill.grade.as_deref() != grade);

    let take = MAX_CANDIDATES_PER_REASON;
    due.into_iter()
        .take(take)
        .map(|skill| from_trace(skill, Reason::ReviewDue))
        .chain(in_progress.into_iter().take(take).map(|skill| from_trace(skill, Reason::InProgress)))
        .chain(ready.into_iter().take(take).map(|skill| Candidate {
            skill_id: skill.id.clone(),
            name: Some(skill.name.clone()),
            reason: Reason::Ready,
            p_now: None,
            target_difficulty: None,
        }))
        .collect()
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    fn day(day: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, day, 15, 0, 0).unwrap()
    }

    fn answers(skill: &str, results: &[bool], first_day: u32) -> Vec<TraceAttempt> {
        results
            .iter()
            .enumerate()
            .map(|(index, correct)| TraceAttempt {
                skill_id: skill.into(),
                question_id: None,
                correct: *correct,
                credit: None,
                at: day(first_day) + chrono::TimeDelta::minutes(index as i64),
                choice: false,
                difficulty: None,
            })
            .collect()
    }

    #[test]
    fn an_objective_the_catalog_cannot_name_is_beyond_it() {
        let catalog = vec![skill("fracciones.sumar", "P4", &[])];
        let asked = vec![Candidate {
            skill_id: "fracciones.sumar".into(),
            name: None,
            reason: Reason::Asked,
            p_now: None,
            target_difficulty: None,
        }];
        // Personal Social has no skill, so «leyes» is planned for on its own.
        assert!(beyond_catalog("personal_social", &[], &catalog));
        assert!(beyond_catalog("other", &[], &catalog));
        // Mathematics is the catalog's, named in the family's Spanish.
        assert!(!beyond_catalog("matematica", &[], &catalog));
        // A topic a skill names is never beyond it, whatever the subject.
        assert!(!beyond_catalog("other", &asked, &catalog));
        assert!(!beyond_catalog("personal_social", &asked, &catalog));
    }

    fn skill(id: &str, grade: &str, prerequisites: &[&str]) -> Skill {
        Skill {
            id: id.into(),
            subject: "math".into(),
            name: format!("Skill {id}"),
            grade: Some(grade.into()),
            description: None,
            prerequisites: prerequisites.iter().map(|id| id.to_string()).collect(),
        }
    }

    fn traced(attempts: Vec<TraceAttempt>, now: DateTime<Utc>) -> Vec<SkillTrace> {
        skill_model::trace(&TraceRequest {
            now: Some(now),
            attempts,
            corrections: vec![],
            params: Params::default(),
        })
        .unwrap()
        .skills
    }

    #[test]
    fn ids_are_slugs() {
        for id in ["fractions.add", "mult-2", "a", "3_digits"] {
            assert!(is_slug(id), "{id}");
        }
        for id in ["", "Fractions", "a b", "-a", "á", &"a".repeat(81), "a/b", "a;drop"] {
            assert!(!is_slug(id), "{id}");
        }
    }

    #[test]
    fn replay_matches_the_model() {
        let attempts =
            [answers("add", &[true, false, true, true], 1), answers("sub", &[false, false], 2)].concat();
        let corrections = vec![Correction { skill_id: "sub".into(), at: day(3), level: 0.9 }];
        let now = day(4);

        let model = replay(&attempts, &corrections, Params::default());
        let trace = skill_model::trace(&TraceRequest {
            now: Some(now),
            attempts,
            corrections,
            params: Params::default(),
        })
        .unwrap();

        assert!((model.ability - trace.ability).abs() < 1e-4);
        assert_eq!(model.skills.len(), trace.skills.len());
        assert!(model.skills["sub"].corrected);
    }

    #[test]
    fn a_new_child_is_offered_skills_with_no_prerequisites_from_their_grade_first() {
        let catalog = [skill("add", "P2", &[]), skill("count", "P1", &[]), skill("mult", "P3", &["add"])];

        let offered = candidates(&[], &catalog, Some("P1"), day(1));

        let ids: Vec<&str> = offered.iter().map(|candidate| candidate.skill_id.as_str()).collect();
        assert_eq!(ids, ["count"], "add is second-grade work and has to wait");
        assert!(
            offered.iter().all(|candidate| candidate.reason == Reason::Ready && candidate.p_now.is_none())
        );
    }

    #[test]
    fn mastering_a_skill_unlocks_what_builds_on_it_and_later_makes_it_due() {
        let catalog = [skill("add", "P2", &[]), skill("mult", "P3", &["add"])];
        let attempts = answers("add", &[true; 8], 1);

        let during = candidates(&traced(attempts.clone(), day(1)), &catalog, None, day(1));
        assert_eq!((during[0].skill_id.as_str(), during[0].reason), ("add", Reason::InProgress));

        let now = day(1) + chrono::TimeDelta::minutes(10);
        let soon = candidates(&traced(attempts.clone(), now), &catalog, None, now);
        assert_eq!(soon.len(), 1);
        assert_eq!((soon[0].skill_id.as_str(), soon[0].reason), ("mult", Reason::Ready));

        let later = candidates(&traced(attempts, day(25)), &catalog, None, day(25));
        assert_eq!((later[0].skill_id.as_str(), later[0].reason), ("add", Reason::ReviewDue));
        assert_eq!(later[0].name.as_deref(), Some("Skill add"));
    }

    #[test]
    fn a_child_starts_at_their_grade_until_an_answer_says_otherwise() {
        let catalog = [
            skill("count", "P1", &[]),
            skill("add", "P2", &["count"]),
            skill("mult", "P3", &["add"]),
            skill("div", "P3", &["mult"]),
            skill("fractions", "P4", &["div"]),
        ];
        let ids = |offered: &[Candidate]| offered.iter().map(|c| c.skill_id.clone()).collect::<Vec<_>>();

        // A third grader with no history: third-grade work whose earlier
        // prerequisites are taken as known. Not first grade, not fourth.
        let offered = candidates(&[], &catalog, Some("P3"), day(1));
        assert_eq!(ids(&offered), ["mult"]);

        // Wrong answers on an assumed prerequisite bring it back, and block what builds on it.
        let now = day(1) + chrono::TimeDelta::minutes(10);
        let struggling = traced(answers("add", &[false, false, false], 1), now);
        let offered = candidates(&struggling, &catalog, Some("P3"), now);
        assert_eq!(ids(&offered), ["add"]);
        assert_eq!(offered[0].reason, Reason::InProgress);

        // Without a grade nothing is assumed.
        assert_eq!(ids(&candidates(&[], &catalog, None, day(1))), ["count"]);
        assert!(
            is_grade("P6") && is_grade("S1") && !is_grade("P7") && !is_grade("4 primaria") && !is_grade("")
        );
    }

    #[test]
    fn unfinished_skills_come_closest_to_mastery_first_and_each_reason_is_capped() {
        let attempts = [
            answers("weak", &[false, false, false], 1),
            answers("close", &[true, true, false, true], 1),
            answers("a", &[false], 1),
            answers("b", &[false], 1),
        ]
        .concat();

        let now = day(1) + chrono::TimeDelta::minutes(10);
        let offered = candidates(&traced(attempts, now), &[], None, now);

        assert_eq!(offered.len(), MAX_CANDIDATES_PER_REASON);
        assert_eq!(offered[0].skill_id, "close");
        assert!(offered.iter().all(|candidate| candidate.reason == Reason::InProgress));
        assert!(offered.iter().all(|candidate| candidate.skill_id != "weak"));
    }
    #[test]
    fn the_topic_of_the_day_names_its_skills_whatever_the_learner_model_would_offer() {
        let catalog = [
            skill("geometria.area-triangulo", "P5", &["geometria.area-rectangulo"]),
            skill("geometria.perimetro-rectangulo", "P4", &[]),
            skill("geometria.problemas-de-perimetro", "P6", &[]),
            skill("multiplicacion.tablas-7-8-9", "P3", &[]),
        ];
        let ids =
            |offered: &[Candidate]| -> Vec<String> { offered.iter().map(|c| c.skill_id.clone()).collect() };
        let offered = asked(&[], &catalog, Some("P5"), "Perímetro y área de rectángulos y triángulos");
        // Two words in common before one; the student's grade before an earlier one; nothing of a later grade.
        assert_eq!(ids(&offered), ["geometria.area-triangulo", "geometria.perimetro-rectangulo"]);
        assert!(offered.iter().all(|candidate| candidate.reason == Reason::Asked));
        assert_eq!(
            ids(&asked(&[], &catalog, Some("P3"), "multiplication tables")),
            ["multiplicacion.tablas-7-8-9"]
        );
        assert!(asked(&[], &catalog, Some("P5"), "").is_empty());
        assert!(asked(&[], &catalog, Some("P5"), "los cóndores").is_empty());

        // Two things in one topic: each is offered, however many skills the first one has.
        let catalog = [
            skill("multiplicacion.tablas-2-5-10", "P3", &[]),
            skill("multiplicacion.tablas-3-4-6", "P3", &[]),
            skill("multiplicacion.tablas-7-8-9", "P3", &[]),
            skill("tiempo.leer-horas-y-minutos", "P3", &[]),
        ];
        let offered = asked(&[], &catalog, Some("P3"), "leer la hora y tablas de multiplicar");
        assert_eq!(offered.len(), 3);
        assert!(offered.iter().any(|candidate| candidate.skill_id == "tiempo.leer-horas-y-minutos"));
    }
}
