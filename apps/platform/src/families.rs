//! Families, the children in them, and what their guardians have consented to.

use std::collections::BTreeMap;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use chrono::{DateTime, Datelike, Utc};
use sea_orm::ActiveValue::{Set, Unchanged};
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, DbBackend, DbErr, EntityTrait,
    QueryFilter, QueryOrder, QuerySelect, Statement, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::auth::{Caller, Input, Operator};
use crate::entity::{child, consent_record, family, guardian, guardian_child, memory, session};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::supervisor::ChildContext;

pub const PURPOSES: [&str; 3] = ["voice", "transcripts", "memory"];

fn text(value: &str, field: &str, max_chars: usize) -> ApiResult<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max_chars {
        return Err(ApiError::bad_request(format!("{field} must have 1 to {max_chars} characters")));
    }
    Ok(value.to_string())
}

#[derive(Deserialize)]
pub struct NewGuardian {
    email: String,
    name: String,
}

#[derive(Deserialize)]
pub struct NewFamily {
    name: String,
    guardian: NewGuardian,
}

pub async fn create_family(
    _: Operator,
    State(state): State<AppState>,
    Input(body): Input<NewFamily>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let name = text(&body.name, "name", 120)?;
    let guardian_name = text(&body.guardian.name, "guardian.name", 120)?;
    let email = body.guardian.email.trim().to_lowercase();
    if email.len() > 254 || email.split('@').filter(|part| !part.is_empty()).count() != 2 {
        return Err(ApiError::bad_request("guardian.email is not an email address"));
    }

    let (family_id, guardian_id) = (Uuid::now_v7(), Uuid::now_v7());
    let txn = state.db.begin().await?;
    family::ActiveModel { id: Set(family_id), name: Set(name), ..Default::default() }.insert(&txn).await?;
    let inserted = guardian::Entity::insert(guardian::ActiveModel {
        id: Set(guardian_id),
        family_id: Set(family_id),
        email: Set(email),
        name: Set(guardian_name),
        ..Default::default()
    })
    .on_conflict(OnConflict::column(guardian::Column::Email).do_nothing().to_owned())
    .exec_without_returning(&txn)
    .await?;
    if inserted == 0 {
        return Err(ApiError::Conflict("a guardian with that email already exists"));
    }
    txn.commit().await?;
    Ok((StatusCode::CREATED, Json(json!({ "family_id": family_id, "guardian_id": guardian_id }))))
}

#[derive(Clone, Debug, Serialize)]
pub struct Child {
    pub id: Uuid,
    pub family_id: Uuid,
    pub nickname: String,
    pub birth_year: Option<i32>,
    pub grade: Option<String>,
    pub language: String,
    pub interests: Vec<String>,
    /// The subjects the family wants reinforced, from `SUBJECTS`.
    pub subjects: Vec<String>,
    pub notes: Option<String>,
    pub tutor_name: String,
    pub tutor_persona: String,
    pub tutor_persona_note: Option<String>,
    pub created_at: DateTime<Utc>,
}

pub const TUTOR_NAME: &str = "Aule";
/// The subjects a family can ask to reinforce.
pub const SUBJECTS: [&str; 5] = ["matematica", "comunicacion", "ciencia", "personal_social", "ingles"];
pub const TUTOR_PERSONAS: [&str; 4] = ["calido", "jugueton", "aventurero", "tranquilo"];
/// What a guardian can be to a child: FHIR R4's `RelatedPerson.relationship`,
/// codes of HL7 v3 RoleCode (mother, father, stepmother, stepfather,
/// grandmother, grandfather, aunt, uncle, sibling, legal guardian, other family
/// member).
pub const RELATIONSHIPS: [&str; 11] =
    ["MTH", "FTH", "STPMTH", "STPFTH", "GRMTH", "GRFTH", "AUNT", "UNCLE", "SIB", "GUARD", "FAMMEMB"];

/// How the tutor presents itself, as the agent is told. The note is the
/// guardian's own words: the agent treats it as a wish about tone, after its
/// rules, and checks it like anything else a person typed.
pub fn tutor(child: Option<&Child>) -> Value {
    match child {
        Some(child) => json!({
            "name": child.tutor_name,
            "persona": child.tutor_persona,
            "note": child.tutor_persona_note,
        }),
        None => json!({ "name": TUTOR_NAME, "persona": TUTOR_PERSONAS[0], "note": null }),
    }
}

/// A name a child can say: letters, spaces and hyphens, nothing that could
/// be read as an instruction.
fn tutor_name(value: &str) -> ApiResult<String> {
    let name = text(value, "tutor_name", 20)?;
    if !name.chars().all(|c| c.is_alphabetic() || c == ' ' || c == '-') {
        return Err(ApiError::bad_request("tutor_name may only have letters, spaces and hyphens"));
    }
    Ok(name)
}

fn tutor_note(value: &str) -> ApiResult<String> {
    let note = text(value, "tutor_persona_note", 200)?;
    if note.chars().any(char::is_control) {
        return Err(ApiError::bad_request("tutor_persona_note must be one line"));
    }
    Ok(note)
}

/// A child's age, from the year they were born: this year's birthday counts
/// as had.
pub fn age(birth_year: Option<i32>, now: DateTime<Utc>) -> Option<i32> {
    birth_year.map(|year| now.year() - year)
}

impl Child {
    pub fn age(&self, now: DateTime<Utc>) -> Option<i32> {
        age(self.birth_year, now)
    }

    /// What the supervisor may know: no name, no ids.
    pub fn context(&self, now: DateTime<Utc>) -> ChildContext {
        ChildContext {
            age: self.age(now),
            grade: self.grade.clone(),
            language: self.language.clone(),
            interests: self.interests.clone(),
            subjects: self.subjects.clone(),
            notes: self.notes.clone(),
        }
    }
}

impl From<child::Model> for Child {
    fn from(row: child::Model) -> Self {
        Self {
            id: row.id,
            family_id: row.family_id,
            nickname: row.nickname,
            birth_year: row.birth_year,
            grade: row.grade,
            language: row.language,
            interests: row.interests,
            subjects: row.subjects,
            notes: row.notes,
            tutor_name: row.tutor_name,
            tutor_persona: row.tutor_persona,
            tutor_persona_note: row.tutor_persona_note,
            created_at: row.created_at,
        }
    }
}

pub async fn find_child(db: &DatabaseConnection, child_id: Uuid) -> ApiResult<Child> {
    child::Entity::find_by_id(child_id).one(db).await?.map(Child::from).ok_or(ApiError::NotFound("child"))
}

/// The child, if the caller may see them. A child of another family does not
/// exist as far as a guardian can tell.
pub async fn child_for(db: &DatabaseConnection, caller: &Caller, child_id: Uuid) -> ApiResult<Child> {
    let child = find_child(db, child_id).await?;
    if caller.may_access(child.family_id) { Ok(child) } else { Err(ApiError::NotFound("child")) }
}

#[derive(Deserialize)]
pub struct ChildInput {
    nickname: String,
    #[serde(default)]
    birth_year: Option<i32>,
    #[serde(default)]
    grade: Option<String>,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    interests: Vec<String>,
    /// Keeps its value when left out.
    #[serde(default)]
    subjects: Option<Vec<String>>,
    #[serde(default)]
    notes: Option<String>,
    /// The three below keep their value when they are left out.
    #[serde(default)]
    tutor_name: Option<String>,
    #[serde(default)]
    tutor_persona: Option<String>,
    /// An empty text removes the note.
    #[serde(default)]
    tutor_persona_note: Option<String>,
    /// The calling guardian's own relationship to the child, from
    /// `RELATIONSHIPS`. Keeps its value when left out; an empty text removes it.
    #[serde(default)]
    relationship: Option<String>,
    /// Only as the child is added: what the guardian consents to, written
    /// with the child.
    #[serde(default)]
    consents: Option<NewConsents>,
}

/// The consents a guardian gives as they add a child. A child is added to talk
/// with the tutor, so `voice` must be granted; `memory` and `transcripts` are
/// answered too, yes or no, so the record says what was chosen.
#[derive(Deserialize)]
pub struct NewConsents {
    voice: bool,
    memory: bool,
    transcripts: bool,
    policy_version: String,
    #[serde(default)]
    locale: Option<String>,
}

struct CheckedConsents {
    answers: [(&'static str, bool); 3],
    policy_version: String,
    locale: String,
}

impl NewConsents {
    fn checked(self, caller: &Caller) -> ApiResult<CheckedConsents> {
        // The operator records an answer given some other way, one at a time
        // and saying how (`record_consent`).
        if caller.guardian_id().is_none() {
            return Err(ApiError::bad_request("consents are given by a signed-in guardian"));
        }
        if !self.voice {
            return Err(ApiError::bad_request(
                "consents.voice must be true: a child is added to talk with the tutor",
            ));
        }
        Ok(CheckedConsents {
            answers: [("voice", true), ("memory", self.memory), ("transcripts", self.transcripts)],
            policy_version: text(&self.policy_version, "consents.policy_version", 40)?,
            locale: locale_of(self.locale.as_deref(), "consents.locale")?,
        })
    }
}

struct CheckedChild {
    nickname: String,
    birth_year: Option<i32>,
    grade: Option<String>,
    language: String,
    interests: Vec<String>,
    subjects: Option<Vec<String>>,
    notes: Option<String>,
    tutor_name: Option<String>,
    tutor_persona: Option<String>,
    /// `Some(None)` removes the note.
    tutor_persona_note: Option<Option<String>>,
    /// `Some(None)` removes it.
    relationship: Option<Option<String>>,
}

impl ChildInput {
    fn checked(self, now: DateTime<Utc>) -> ApiResult<CheckedChild> {
        let optional = |value: Option<String>, field: &str, max: usize| {
            value.filter(|value| !value.trim().is_empty()).map(|value| text(&value, field, max)).transpose()
        };
        // A student from about 3 to 19 years old.
        if self.birth_year.is_some_and(|year| !(now.year() - 19..=now.year() - 3).contains(&year)) {
            return Err(ApiError::bad_request("birth_year is not a school student's"));
        }
        let language = self.language.unwrap_or_else(|| "es".to_string());
        if !["es", "en"].contains(&language.as_str()) {
            return Err(ApiError::bad_request("language must be es or en"));
        }
        let grade = self.grade.map(|grade| grade.trim().to_uppercase()).filter(|grade| !grade.is_empty());
        if grade.as_deref().is_some_and(|grade| !crate::learning::is_grade(grade)) {
            return Err(ApiError::bad_request("grade must be P1 to P6 (primary) or S1 to S5 (secondary)"));
        }
        if self.interests.len() > 10 {
            return Err(ApiError::bad_request("at most 10 interests"));
        }
        let mut subjects = self.subjects;
        if let Some(subjects) = &mut subjects {
            if subjects.iter().any(|subject| !SUBJECTS.contains(&subject.as_str())) {
                return Err(ApiError::bad_request(format!(
                    "subjects must be among: {}",
                    SUBJECTS.join(", ")
                )));
            }
            // In the order the family chose them, each once.
            let mut seen = std::collections::HashSet::new();
            subjects.retain(|subject| seen.insert(subject.clone()));
        }
        if self.tutor_persona.as_deref().is_some_and(|persona| !TUTOR_PERSONAS.contains(&persona)) {
            return Err(ApiError::bad_request(
                "tutor_persona must be calido, jugueton, aventurero or tranquilo",
            ));
        }
        let relationship = match self.relationship {
            None => None,
            Some(code) if code.trim().is_empty() => Some(None),
            Some(code) if RELATIONSHIPS.contains(&code.as_str()) => Some(Some(code)),
            Some(_) => {
                return Err(ApiError::bad_request(format!(
                    "relationship must be one of: {}",
                    RELATIONSHIPS.join(", ")
                )));
            }
        };
        let tutor_persona_note = match self.tutor_persona_note {
            None => None,
            Some(note) if note.trim().is_empty() => Some(None),
            Some(note) => Some(Some(tutor_note(&note)?)),
        };
        Ok(CheckedChild {
            nickname: text(&self.nickname, "nickname", 40)?,
            birth_year: self.birth_year,
            grade,
            language,
            interests: self
                .interests
                .iter()
                .map(|item| text(item, "an interest", 40))
                .collect::<ApiResult<_>>()?,
            subjects,
            notes: optional(self.notes, "notes", 1000)?,
            tutor_name: self.tutor_name.as_deref().map(tutor_name).transpose()?,
            tutor_persona: self.tutor_persona,
            tutor_persona_note,
            relationship,
        })
    }
}

/// Records or removes how the calling guardian is related to the child. Only a
/// guardian has a relationship to state.
async fn set_relationship(
    db: &impl ConnectionTrait,
    caller: &Caller,
    child_id: Uuid,
    relationship: Option<Option<String>>,
) -> ApiResult<()> {
    let Some(relationship) = relationship else { return Ok(()) };
    let Some(guardian_id) = caller.guardian_id() else {
        return Err(ApiError::bad_request("relationship is stated by a guardian"));
    };
    match relationship {
        Some(code) => {
            guardian_child::Entity::insert(guardian_child::ActiveModel {
                guardian_id: Set(guardian_id),
                child_id: Set(child_id),
                relationship: Set(code),
                ..Default::default()
            })
            .on_conflict(
                OnConflict::columns([guardian_child::Column::GuardianId, guardian_child::Column::ChildId])
                    .update_column(guardian_child::Column::Relationship)
                    .value(guardian_child::Column::UpdatedAt, Expr::current_timestamp())
                    .to_owned(),
            )
            .exec_without_returning(db)
            .await?;
        }
        None => {
            guardian_child::Entity::delete_by_id((guardian_id, child_id)).exec(db).await?;
        }
    }
    Ok(())
}

/// The calling guardian's relationship to the child, if they stated one.
async fn relationship_of(
    db: &DatabaseConnection,
    caller: &Caller,
    child_id: Uuid,
) -> ApiResult<Option<String>> {
    let Some(guardian_id) = caller.guardian_id() else { return Ok(None) };
    let row = guardian_child::Entity::find_by_id((guardian_id, child_id)).one(db).await?;
    Ok(row.map(|row| row.relationship))
}

/// A child of the family, and, from a guardian, the consents they give with it
/// (`NewConsents`): all in one transaction, so a child is never there without
/// the consents it was added with.
pub async fn create_child(
    caller: Caller,
    State(state): State<AppState>,
    Path(family_id): Path<Uuid>,
    Input(mut body): Input<ChildInput>,
) -> ApiResult<(StatusCode, Json<Child>)> {
    if !caller.may_access(family_id) {
        return Err(ApiError::NotFound("family"));
    }
    let consents = body.consents.take().map(|consents| consents.checked(&caller)).transpose()?;
    let child = body.checked(Utc::now())?;
    family::Entity::find_by_id(family_id).one(&state.db).await?.ok_or(ApiError::NotFound("family"))?;
    let txn = state.db.begin().await?;
    let created = child::ActiveModel {
        id: Set(Uuid::now_v7()),
        family_id: Set(family_id),
        nickname: Set(child.nickname),
        birth_year: Set(child.birth_year),
        grade: Set(child.grade),
        language: Set(child.language),
        interests: Set(child.interests),
        notes: Set(child.notes),
        tutor_name: Set(child.tutor_name.unwrap_or_else(|| TUTOR_NAME.to_string())),
        tutor_persona: Set(child.tutor_persona.unwrap_or_else(|| TUTOR_PERSONAS[0].to_string())),
        tutor_persona_note: Set(child.tutor_persona_note.flatten()),
        subjects: Set(child.subjects.unwrap_or_default()),
        ..Default::default()
    }
    .insert(&txn)
    .await?;
    set_relationship(&txn, &caller, created.id, child.relationship).await?;
    if let Some(consents) = consents {
        for (purpose, granted) in consents.answers {
            let answer = Answer {
                family_id,
                child_id: created.id,
                guardian_id: caller.guardian_id(),
                purpose,
                granted,
                policy_version: &consents.policy_version,
                locale: &consents.locale,
                source: "app",
            };
            write_answer(&txn, &answer).await?;
        }
    }
    txn.commit().await?;
    Ok((StatusCode::CREATED, Json(created.into())))
}

pub async fn update_child(
    caller: Caller,
    State(state): State<AppState>,
    Path(child_id): Path<Uuid>,
    Input(body): Input<ChildInput>,
) -> ApiResult<Json<Child>> {
    child_for(&state.db, &caller, child_id).await?;
    // Said here, they would be dropped without a word: an answer has its own route.
    if body.consents.is_some() {
        return Err(ApiError::bad_request("consents are recorded with POST /v1/children/{id}/consents"));
    }
    let child = body.checked(Utc::now())?;
    let mut row = child::ActiveModel {
        id: Unchanged(child_id),
        nickname: Set(child.nickname),
        birth_year: Set(child.birth_year),
        grade: Set(child.grade),
        language: Set(child.language),
        interests: Set(child.interests),
        notes: Set(child.notes),
        ..Default::default()
    };
    // Left out, these keep their value.
    if let Some(name) = child.tutor_name {
        row.tutor_name = Set(name);
    }
    if let Some(persona) = child.tutor_persona {
        row.tutor_persona = Set(persona);
    }
    if let Some(note) = child.tutor_persona_note {
        row.tutor_persona_note = Set(note);
    }
    if let Some(subjects) = child.subjects {
        row.subjects = Set(subjects);
    }
    let txn = state.db.begin().await?;
    let updated = row.update(&txn).await.map_err(|error| match error {
        DbErr::RecordNotUpdated => ApiError::NotFound("child"),
        other => other.into(),
    })?;
    set_relationship(&txn, &caller, child_id, child.relationship).await?;
    txn.commit().await?;
    Ok(Json(updated.into()))
}

pub async fn get_child(
    caller: Caller,
    State(state): State<AppState>,
    Path(child_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let child = child_for(&state.db, &caller, child_id).await?;
    let consent = current_consent(&state.db, child_id).await?;
    let relationship = relationship_of(&state.db, &caller, child_id).await?;
    Ok(Json(json!({ "child": child, "consent": consent, "relationship": relationship })))
}

/// Erases the child and everything derived from them: sessions, transcripts,
/// answers, memories and reviews go with the row. The consent records stay,
/// as the proof of what was agreed while the data existed.
pub async fn delete_child(
    caller: Caller,
    State(state): State<AppState>,
    Path(child_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    child_for(&state.db, &caller, child_id).await?;
    let deleted = child::Entity::delete_by_id(child_id).exec(&state.db).await?;
    if deleted.rows_affected == 0 {
        return Err(ApiError::NotFound("child"));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// The latest answer for each purpose. A purpose never answered is not granted.
pub async fn current_consent(
    db: &impl ConnectionTrait,
    child_id: Uuid,
) -> Result<BTreeMap<String, bool>, DbErr> {
    let rows = consent_record::Entity::find()
        .filter(consent_record::Column::ChildId.eq(child_id))
        .order_by_desc(consent_record::Column::CreatedAt)
        .order_by_desc(consent_record::Column::Id)
        .all(db)
        .await?;
    let mut consent: BTreeMap<String, bool> =
        PURPOSES.iter().map(|purpose| (purpose.to_string(), false)).collect();
    // Newest first: the first answer seen for a purpose is its current one.
    let mut seen = std::collections::BTreeSet::new();
    for row in rows {
        if seen.insert(row.purpose.clone()) {
            consent.insert(row.purpose, row.granted);
        }
    }
    Ok(consent)
}

/// The language an answer was given in, as the guardian's app says it.
fn locale_of(locale: Option<&str>, field: &str) -> ApiResult<String> {
    Ok(locale.map(|locale| text(locale, field, 20)).transpose()?.unwrap_or_else(|| "es-PE".into()))
}

/// One answer about one purpose, as it is kept.
struct Answer<'a> {
    family_id: Uuid,
    child_id: Uuid,
    guardian_id: Option<Uuid>,
    purpose: &'a str,
    granted: bool,
    policy_version: &'a str,
    locale: &'a str,
    source: &'a str,
}

/// Appends an answer. The time is the clock's, not the transaction's: two
/// answers in one transaction keep their order.
async fn write_answer(db: &impl ConnectionTrait, answer: &Answer<'_>) -> Result<(), DbErr> {
    db.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "insert into consent_records (id, family_id, child_id, guardian_id, purpose, granted, policy_version, locale, source, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, clock_timestamp())",
        [
            Uuid::now_v7().into(),
            answer.family_id.into(),
            answer.child_id.into(),
            answer.guardian_id.into(),
            answer.purpose.into(),
            answer.granted.into(),
            answer.policy_version.into(),
            answer.locale.into(),
            answer.source.into(),
        ],
    ))
    .await?;
    Ok(())
}

#[derive(Deserialize)]
pub struct ConsentInput {
    purpose: String,
    granted: bool,
    policy_version: String,
    #[serde(default)]
    guardian_id: Option<Uuid>,
    #[serde(default)]
    locale: Option<String>,
    /// Where the guardian answered, such as "paper-form". A signed-in
    /// guardian's answer is always recorded as "app".
    #[serde(default)]
    source: Option<String>,
}

pub async fn record_consent(
    caller: Caller,
    State(state): State<AppState>,
    Path(child_id): Path<Uuid>,
    Input(body): Input<ConsentInput>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    if !PURPOSES.contains(&body.purpose.as_str()) {
        return Err(ApiError::bad_request(format!("purpose must be one of: {}", PURPOSES.join(", "))));
    }
    let child = child_for(&state.db, &caller, child_id).await?;
    // A guardian answers for themselves; only the operator records an answer
    // given some other way, and must say how.
    let (guardian_id, source) = match caller.guardian_id() {
        Some(guardian_id) => (Some(guardian_id), "app".to_string()),
        None => {
            let source = body.source.as_deref().ok_or_else(|| ApiError::bad_request("source is required"))?;
            (body.guardian_id, text(source, "source", 40)?)
        }
    };
    if let Some(guardian_id) = guardian_id {
        let belongs: Option<Uuid> = guardian::Entity::find_by_id(guardian_id)
            .filter(guardian::Column::FamilyId.eq(child.family_id))
            .select_only()
            .column(guardian::Column::Id)
            .into_tuple()
            .one(&state.db)
            .await?;
        belongs.ok_or(ApiError::Forbidden("that guardian is not in the child's family"))?;
    }
    let txn = state.db.begin().await?;
    // Session creation and memory writes take the same lock. Revocation must
    // either remove a completed write or prevent a later one.
    child::Entity::find_by_id(child_id)
        .select_only()
        .column(child::Column::Id)
        .lock_exclusive()
        .into_tuple::<Uuid>()
        .one(&txn)
        .await?
        .ok_or(ApiError::NotFound("child"))?;
    let locale = locale_of(body.locale.as_deref(), "locale")?;
    let policy_version = text(&body.policy_version, "policy_version", 40)?;
    let answer = Answer {
        family_id: child.family_id,
        child_id,
        guardian_id,
        purpose: &body.purpose,
        granted: body.granted,
        policy_version: &policy_version,
        locale: &locale,
        source: &source,
    };
    write_answer(&txn, &answer).await?;

    // Taking consent back takes the data back too.
    if !body.granted {
        match body.purpose.as_str() {
            "memory" => {
                session::Entity::update_many()
                    .col_expr(session::Column::UseMemory, Expr::value(false))
                    .filter(session::Column::ChildId.eq(child_id))
                    .exec(&txn)
                    .await?;
                memory::Entity::delete_many().filter(memory::Column::ChildId.eq(child_id)).exec(&txn).await?;
            }
            "transcripts" => {
                session::Entity::update_many()
                    .col_expr(session::Column::KeepTranscript, Expr::value(false))
                    .filter(session::Column::ChildId.eq(child_id))
                    .exec(&txn)
                    .await?;
                // What the student said: the turns, and what went into the session
                // engine, of every session that has ended.
                for table in ["session_turns", "session_engine_inputs"] {
                    txn.execute_raw(Statement::from_sql_and_values(
                        DbBackend::Postgres,
                        format!(
                            "delete from {table} using sessions
                             where {table}.session_id = sessions.id and sessions.child_id = $1 and sessions.status = 'ended'"
                        ),
                        [child_id.into()],
                    ))
                    .await?;
                }
            }
            _ => {}
        }
    }
    let consent = current_consent(&txn, child_id).await?;
    txn.commit().await?;
    Ok((StatusCode::CREATED, Json(json!({ "consent": consent }))))
}
