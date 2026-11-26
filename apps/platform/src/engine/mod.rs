//! A session run by the session engine (`engine/`).
//!
//! The engine decides what happens: which stage the student is in, the next
//! exercise, when a hint is due, when the session ends. This module drives it:
//! it turns what the student said into the engine's inputs, and what the
//! engine answers into lines for the tutor to say and things for the screen
//! to show. The tutor's model words a reply only where the engine leaves the
//! conversation free, and then under the engine's rules for that moment.
//!
//! The engine is not serializable and reads the time only from the clock it
//! is given. A session is therefore kept as the ordered inputs that went into
//! it, each with the clock at which it was applied; applying them again gives
//! the same engine. Live engines are cached in the process and rebuilt from
//! the table when they are missing or may have fallen behind it.
//!
//! The inputs hold what the student said. Nothing from them is logged, and
//! they are deleted with the session's turns (see `sessions::review_session`,
//! `jobs::housekeeping` and `families::record_consent`).

mod visuals;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use aule_core::banco::{Banco, Ejercicio};
use aule_core::conversacion::{self, Intencion};
use aule_core::correccion::{self, Clave, Veredicto};
use aule_core::modelo::{EstadoObjetivo, Objetivo, Perfil, TamizajeParcial, TipoObjetivo};
use aule_core::motor::{
    Adjunto, Calificacion, Clase, Entrada, Esperando, LecturaTarea, Mensaje, Modo, Motor, Redaccion, Tarjeta,
};
use aule_core::reloj::Reloj;
use aule_core::texto;
use axum::Json;
use axum::extract::{Path, State};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DatabaseConnection, DbBackend, DbErr, EntityTrait,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Statement, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::auth::{Agent, Caller, Input as Body, Session};
use crate::entity::{attempt, child, guardian, session as session_row, session_engine_input};
use crate::error::{ApiError, ApiResult};
use crate::families::{child_for, find_child};
use crate::state::AppState;

/// The subject, as families name it, of the bank compiled into the binary.
const BANK_SUBJECT: &str = "matematica";
/// The engine's texts exist in Spanish only.
const BANK_LANGUAGE: &str = "es";
const MAX_SAID_CHARS: usize = 500;
/// The engine works with exact fractions on 64-bit integers. A number longer
/// than this is not an answer to any exercise, and is kept away from that
/// arithmetic so it cannot overflow.
const MAX_DIGITS: usize = 6;
/// Said once when an answer came without how it was worked out, in the stages
/// that ask for both. It says nothing about whether the answer is right.
const ASK_HOW: &str = "¡Gracias! Ahora cuéntame cómo lo pensaste.";
/// The report greets the guardian by name; a family always has one.
const GUARDIAN_FALLBACK: &str = "familia";

/// The bank compiled into the binary, checked once. Nothing when it fails
/// its own validation: then no session is run by the engine.
fn bank() -> Option<Arc<Banco>> {
    static BANK: OnceLock<Option<Arc<Banco>>> = OnceLock::new();
    BANK.get_or_init(|| match contenido::cargar_validado() {
        Ok(bank) => Some(Arc::new(bank)),
        Err(problems) => {
            tracing::error!(problems = problems.len(), "the engine's bank is not valid; the engine is off");
            None
        }
    })
    .clone()
}

/// What a photo of the homework is read against: the bank's topic and what
/// each of its levels is about, in the bank's own words. The agent builds its
/// question from this, so a bank for another topic, or with other levels,
/// needs no change there. Nothing when the bank is not valid.
pub fn homework_course() -> Option<Value> {
    let bank = bank()?;
    let levels: Vec<Value> =
        bank.niveles.iter().map(|level| json!({ "level": level.nivel, "about": level.titulo })).collect();
    Some(json!({ "topic": bank.tema, "levels": levels }))
}

/// The engine's clock: milliseconds since the session's first input, set by
/// the platform before every input and never read from the system.
#[derive(Clone, Default)]
struct Clock(Arc<AtomicU64>);

impl Reloj for Clock {
    fn ahora_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// What a session is for, in the engine's terms.
///
/// | The family's objective (`kind`) | The engine's `TipoObjetivo` |
/// |---|---|
/// | `homework` | `Tarea`, with the bank's own homework as the exercises |
/// | `exam_prep` | `Preparacion`: the engine simulates the exam |
/// | `explore` | no objective: `Extracurricular`, with the topic as the family's suggestion |
/// | `exam_review` | not run by the engine |
///
/// `exam_review` is left out because the engine's `Correccion` works on an
/// exam the student already sat: which questions they missed and what they
/// answered. The platform does not have that, and the bank's sample exam
/// would be presented to the student as their own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Goal {
    Homework,
    ExamPrep,
    Explore,
}

/// The objective as the engine can run it, or nothing when the bank does not
/// cover it: today the bank is fractions in mathematics, in Spanish.
pub fn goal(objective: Option<&Value>, language: &str) -> Option<(Goal, Option<NaiveDate>)> {
    let (objective, bank) = (objective?, bank()?);
    if language != BANK_LANGUAGE {
        return None;
    }
    // A subject left out is decided by the topic; any other subject is not ours.
    if objective["subject"].as_str().is_some_and(|subject| subject != BANK_SUBJECT) {
        return None;
    }
    // "Fracciones equivalentes" and "suma de fracciones" are both the bank's topic.
    let stem: String = texto::normalizar(&bank.tema).chars().take(7).collect();
    if !texto::normalizar(objective["topic"].as_str()?).contains(&stem) {
        return None;
    }
    let goal = match objective["kind"].as_str()? {
        "homework" => Goal::Homework,
        "exam_prep" => Goal::ExamPrep,
        "explore" => Goal::Explore,
        _ => return None,
    };
    let due = objective["due"].as_str().and_then(|due| due.parse().ok());
    Some((goal, due))
}

/// What an engine is started with. A session rebuilt later is started with
/// the same, read again from the database.
///
/// The child becomes the engine's `Perfil`: the nickname is the student's
/// name, the interests (joined) choose the setting of the exercises, the
/// family's first guardian is who the report greets. Those are read fresh
/// every time; what the engine learned in earlier sessions comes in `start`.
#[derive(Clone, Debug)]
pub struct Setup {
    pub student: String,
    pub interests: Vec<String>,
    pub guardian: String,
    /// The day of the session where the family lives.
    pub today: NaiveDate,
    pub goal: Goal,
    pub due: Option<NaiveDate>,
    pub start: Start,
}

/// What the engine keeps about a child from one session to the next: the
/// level reached per topic, a screening left half way, how long each level
/// took and which exercises were used. Levels and ids, nothing the student
/// said. With a level known the engine does not screen that topic again; a
/// screening left half way is taken up where it stopped (TAM-01, TAM-06).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Kept {
    #[serde(default)]
    pub levels: BTreeMap<String, u8>,
    #[serde(default)]
    pub unfinished_screenings: BTreeMap<String, TamizajeParcial>,
    #[serde(default)]
    pub minutes_per_level: Vec<(String, u8, f64)>,
    #[serde(default)]
    pub used_exercises: BTreeSet<String>,
    #[serde(default)]
    pub sessions: u32,
}

/// What a session started from, fixed when it was created: a session rebuilt
/// later must not see a profile or a setting that changed since.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Start {
    /// The platform's session length, in minutes.
    pub minutes: u32,
    #[serde(default)]
    pub kept: Kept,
    /// The minute of the day the session was opened where the family lives
    /// (0 to 1439), so the engine can tell night from day (PAU-07). None for a
    /// session opened before this was stored.
    #[serde(default)]
    pub minute: Option<u16>,
}

/// The engine's shortest and longest session (SES-01: 30 minutes to an hour
/// and a half). The platform's length is brought inside them.
const ENGINE_MINUTES: std::ops::RangeInclusive<u32> = 30..=90;

/// The engine's settings with its session as long as the platform's. The
/// engine closes at its longest session and gives a break at 30 and 60
/// minutes only when the session is longer than that, so both follow.
fn settings(minutes: u32) -> aule_core::config::Config {
    let mut settings = aule_core::config::Config::default();
    settings.sesion_maxima_min = minutes.clamp(*ENGINE_MINUTES.start(), *ENGINE_MINUTES.end());
    settings.sesion_recomendada_min = settings.sesion_recomendada_min.min(settings.sesion_maxima_min);
    settings
}

fn engine(setup: &Setup, bank: Arc<Banco>, clock: Clock) -> Motor {
    let mut profile =
        Perfil::nuevo(&setup.student, &setup.interests.join(", "), &setup.guardian, setup.today);
    let kept = setup.start.kept.clone();
    profile.niveles = kept.levels;
    profile.tamizaje_parcial = kept.unfinished_screenings;
    profile.time_to_master = kept.minutes_per_level;
    profile.ejercicios_usados = kept.used_exercises;
    profile.numero_sesion = kept.sessions + 1;
    profile.minuto_inicio = setup.start.minute;
    let objective = |kind: TipoObjetivo| Objetivo {
        id: 1,
        tipo: kind,
        // The engine matches an objective to the bank by these two names.
        curso: bank.curso.clone(),
        tema: bank.tema.clone(),
        fecha: setup.due,
        // The family was asked for the date when it said what the session is
        // for; an empty date is their answer, so the student is not asked again.
        sin_fecha_confirmado: setup.due.is_none(),
        nivel_objetivo: None,
        tarea_id: (kind == TipoObjetivo::Tarea).then(|| bank.tareas.first().map(|t| t.id.clone())).flatten(),
        evaluacion_id: None,
        falladas: Vec::new(),
        estado: EstadoObjetivo::Pendiente,
    };
    let objectives = match setup.goal {
        Goal::Homework => vec![objective(TipoObjetivo::Tarea)],
        Goal::ExamPrep => vec![objective(TipoObjetivo::Preparacion)],
        Goal::Explore => {
            profile.sugerencia_padre = Some(bank.tema.clone());
            Vec::new()
        }
    };
    Motor::new(settings(setup.start.minutes), bank, Arc::new(clock), profile, objectives)
}

/// The platform's own copy of what can go into the engine, so what is stored
/// does not depend on the engine's types. `Hold` is the platform's: an answer
/// kept until the student says how they worked it out.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Input {
    /// `homework` is what the engine may do with a photo of the homework for
    /// the whole session (see [`HOMEWORK_LEVEL`]). Inputs stored before it
    /// existed read as 0, and 0 is stored as they were.
    Start {
        #[serde(default, skip_serializing_if = "is_zero")]
        homework: u8,
    },
    Text {
        text: String,
    },
    Graded {
        read: Option<String>,
        correct: bool,
        wrong_form: bool,
        explained: Option<bool>,
        unreadable: bool,
    },
    Help,
    Tired,
    LeaveScreening,
    Activity {
        choice: usize,
    },
    Tick,
    Chat {
        text: String,
        intent: Intencion,
    },
    Hold {
        said: String,
    },
    /// What the agent read in a photo of the homework the engine asked for:
    /// for a homework that was read, its level and how sure the reading is,
    /// in percent. Never the photo.
    Homework {
        outcome: Reading,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        level: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        confidence: Option<u8>,
    },
}

fn is_zero(value: &u8) -> bool {
    *value == 0
}

/// The most the agent can say it does with a photo of the homework when it
/// starts a session: 1, the photo sets the homework's level (the engine's
/// TAR-05); 2, it can also work through the homework itself, which the engine
/// does not do yet. `AULE_ENGINE_HOMEWORK` caps what a session gets.
pub const HOMEWORK_MAX: u8 = 2;
/// From here on, the engine asks for a photo of the homework.
pub const HOMEWORK_LEVEL: u8 = 1;
/// `awaits` while the engine waits for a photo of the homework.
const AWAITS_PHOTO: &str = "homework_photo";

/// What the agent read in a photo of the homework.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reading {
    /// A homework of the bank's topic, with its level: the highest in sight.
    Read,
    /// A homework of another subject or topic.
    OtherSubject,
    /// No homework in the photo.
    NoHomework,
    /// A homework that cannot be read: blurry, too far, too dark.
    Unreadable,
    /// The photo could not be read: the reader failed or did not answer.
    Unavailable,
    /// An exercise of the homework, shown while the student works through
    /// it. No session does that yet, so nothing awaits it.
    Shown,
}

/// The engine's reading of what the agent read, or nothing for what no
/// engine stage takes.
fn reading(outcome: Reading, level: Option<u8>, confidence: Option<u8>) -> Option<LecturaTarea> {
    Some(match outcome {
        Reading::Read => LecturaTarea::Leida { nivel: level?, confianza: confidence? },
        Reading::OtherSubject => LecturaTarea::OtroTema,
        Reading::NoHomework => LecturaTarea::SinTarea,
        Reading::Unreadable => LecturaTarea::Borrosa,
        Reading::Unavailable => LecturaTarea::NoDisponible,
        Reading::Shown => return None,
    })
}

/// An input and the engine's clock when it was applied.
#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    pub at_ms: u64,
    pub input: Input,
}

/// One thing for the tutor to say, and what to put on the screen with it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Line {
    /// The engine's text, word for word.
    pub say: String,
    pub show: Option<Value>,
    /// The engine would have a model word this one; `say` is its fallback.
    pub reword: bool,
    /// The line answers something the student said in their own words, so it
    /// is not treated as fixed text.
    pub echoes: bool,
    /// What the student can tap under the line to answer it. Left out when
    /// the line asks nothing whose answers are known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choices: Option<Choices>,
}

impl Line {
    fn fixed(say: &str, show: Option<Value>) -> Self {
        Self { say: say.to_string(), show, reword: false, echoes: false, choices: None }
    }
}

/// Answers the student can tap under a line, as `contracts/choices` has them.
/// Tapping one is the student's turn: the page sends its words to the tutor as
/// typed, they pass the input gates, and they reach the engine as `said` does.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Choices {
    pub options: Vec<String>,
    /// Several may be marked and sent together. The engine's questions take one.
    #[serde(default)]
    pub multiple: bool,
}

// The contract's limits. Options outside them are not offered, never cut down.
const MAX_CHOICES: usize = 4;
const MAX_CHOICE_CHARS: usize = 40;

/// Options as a screen can show them, or nothing: none, more than it takes,
/// a blank or a long one, or the same one twice.
fn choices(options: &[String]) -> Option<Choices> {
    let distinct = options.iter().collect::<BTreeSet<_>>().len() == options.len();
    let fit =
        options.iter().all(|option| !option.trim().is_empty() && option.chars().count() <= MAX_CHOICE_CHARS);
    (!options.is_empty() && options.len() <= MAX_CHOICES && distinct && fit)
        .then(|| Choices { options: options.to_vec(), multiple: false })
}

/// What the tutor does with one thing the student said.
#[derive(Clone, Debug, PartialEq)]
pub struct Turn {
    pub lines: Vec<Line>,
    /// Rules for a reply in the model's own words after the lines, when the
    /// engine leaves this turn free. Nothing when the lines are the whole turn.
    pub converse: Option<String>,
    pub closed: bool,
    /// What the engine waits for that the agent has to act on: a photo of the
    /// homework (`"homework_photo"`). Nothing otherwise.
    pub awaits: Option<&'static str>,
}

impl Turn {
    /// The turn as the agent gets it: `awaits` is there only while the engine
    /// waits for something, so a session that never does answers as before.
    fn reply(&self) -> Value {
        let mut reply = json!({ "lines": self.lines, "converse": self.converse, "closed": self.closed });
        if let Some(awaits) = self.awaits {
            reply["awaits"] = json!(awaits);
        }
        reply
    }

    /// The lines alone, for the agent to say when it next asks.
    fn script(&self) -> Value {
        let mut script = json!({ "lines": self.lines, "closed": self.closed });
        if let Some(awaits) = self.awaits {
            script["awaits"] = json!(awaits);
        }
        script
    }
}

struct Held {
    card: String,
    said: String,
}

/// An exercise the engine closed, for the learner model.
#[derive(Clone, Debug, PartialEq)]
pub struct Outcome {
    /// The exercise's id in the bank.
    pub exercise: String,
    pub skill: Option<&'static str>,
    /// One of a few options, which can be right by chance.
    pub choice: bool,
    /// 1 solved at the first try without help, 0.5 solved after a wrong
    /// answer or a hint, 0 not solved.
    pub credit: f64,
    pub at_ms: u64,
}

/// The exercise being worked on, and what it has cost so far.
struct Working {
    exercise: String,
    wrong: u32,
    helped: bool,
}

/// What an exercise of the bank practises, as a skill of the curriculum
/// (`curriculum/math-primaria.json`). The engine has five levels of
/// fractions, and a level mixes more than one skill, so the exercise's own
/// arithmetic (the bank's checking expression) chooses within the level.
const SKILLS: [(u8, Work, &str); 10] = [
    (1, Work::Any, "fracciones.concepto-numerador-y-denominador"),
    (2, Work::Compare, "fracciones.comparar-distinto-denominador"),
    (2, Work::Any, "fracciones.equivalentes-y-simplificar"),
    (3, Work::Add, "fracciones.sumar-igual-denominador"),
    (3, Work::Subtract, "fracciones.restar-igual-denominador"),
    (3, Work::Any, "fracciones.numeros-mixtos-e-impropias"),
    (4, Work::Add, "fracciones.sumar-distinto-denominador"),
    (4, Work::Subtract, "fracciones.restar-distinto-denominador"),
    (5, Work::Of, "fracciones.fraccion-de-una-cantidad"),
    (5, Work::Any, "fracciones.problemas-con-fracciones"),
];

#[derive(Clone, Copy, Debug, PartialEq)]
enum Work {
    /// Two fractions added: "2/7 + 3/7". Not "3 + 2/5", which is a mixed number.
    Add,
    Subtract,
    /// Which of two fractions is greater: "2/3 > 3/5".
    Compare,
    /// A fraction of an amount, and nothing else: "(2/3) * 18".
    Of,
    Any,
}

fn work_of(check: &str) -> Work {
    let first = check.find(['+', '-']);
    match first {
        Some(at) if check[..at].contains('/') => {
            if check[at..].starts_with('+') {
                Work::Add
            } else {
                Work::Subtract
            }
        }
        Some(_) => Work::Any,
        None if check.contains(['<', '>', '=']) => Work::Compare,
        None if check.contains('*') => Work::Of,
        None => Work::Any,
    }
}

fn skill_of(exercise: &Ejercicio) -> Option<&'static str> {
    let work = work_of(&exercise.verificar);
    SKILLS
        .iter()
        .find(|(level, kind, _)| *level == exercise.nivel && (*kind == work || *kind == Work::Any))
        .map(|(_, _, skill)| *skill)
}

/// Whether the lines the engine answered with are the whole turn.
#[derive(PartialEq)]
enum Reply {
    Scripted,
    Free,
}

/// An engine and the inputs it has taken.
pub struct Engine {
    motor: Motor,
    clock: Clock,
    setup: Setup,
    bank: Arc<Banco>,
    /// Inputs applied and not stored yet.
    unsaved: Vec<Record>,
    /// How many inputs are stored: the place of the next one.
    stored: usize,
    last_ms: u64,
    held: Option<Held>,
    working: Option<Working>,
    outcomes: Vec<Outcome>,
    /// What the session started with (`Input::Start`).
    homework: u8,
}

fn has_long_number(text: &str) -> bool {
    text.split(|c: char| !c.is_ascii_digit()).any(|digits| digits.len() > MAX_DIGITS)
}

fn is_question(said: &str) -> bool {
    let words = texto::normalizar(said);
    said.contains(['?', '¿'])
        || ["que ", "como ", "cual ", "cuanto ", "por que "].iter().any(|start| words.starts_with(start))
}

/// The student asks to stop the screening, which the engine tells them they may.
fn wants_out(said: &str) -> bool {
    let said = texto::normalizar(said);
    ["salir", "abrumad", "ya no quiero", "no quiero seguir"].iter().any(|phrase| said.contains(phrase))
}

/// The part of a spoken answer that is the answer itself: what comes before
/// "porque" or the end of the first sentence, when a reading of `readable`
/// is there. The engine's reader takes the number after the last "es" or
/// "son", which in "tres octavos porque el ocho es el total" is not the answer.
fn answer_part(said: &str, readable: impl Fn(&str) -> bool) -> &str {
    let mut cut = said.find(". ");
    let mut words = said.split_whitespace().peekable();
    while let Some(word) = words.next() {
        let offset = word.as_ptr() as usize - said.as_ptr() as usize;
        let next = words.peek().map(|next| texto::normalizar(next));
        let connector = match texto::normalizar(word).as_str() {
            "porque" | "pues" => true,
            "por" | "ya" => next.as_deref() == Some("que"),
            _ => false,
        };
        if connector {
            cut = Some(cut.map_or(offset, |cut| cut.min(offset)));
            break;
        }
    }
    match cut.map(|cut| said[..cut].trim()) {
        Some(part) if !part.is_empty() && readable(part) => part,
        _ => said,
    }
}

fn card_key(card: &Tarjeta) -> String {
    format!("{:?}|{}", card.modo, card.id.as_deref().unwrap_or(&card.enunciado))
}

/// The statement of the card, to say and to show: its drawing, or its text
/// when it has none or the screen cannot draw it.
fn card_line(card: &Tarjeta) -> Line {
    let show = card
        .grafico
        .as_ref()
        .and_then(visuals::drawing)
        .or_else(|| visuals::statement(None, &card.enunciado));
    Line::fixed(&card.enunciado, show)
}

fn lines_of(messages: Vec<Mensaje>, echoes: bool, out: &mut Vec<Line>) {
    for message in messages {
        out.push(Line {
            show: message.adjunto.as_ref().and_then(visuals::attachment),
            reword: matches!(message.redaccion, Redaccion::Ia { .. }),
            // What the engine asks with known answers: they are its own words.
            choices: choices(&message.opciones),
            say: message.texto,
            echoes,
        });
        // A worked example lives in the attachment, which a page shows whole.
        // A voice has to say it: the statement, then each step.
        if let Some(Adjunto::Pasos { enunciado, pasos, .. }) = &message.adjunto {
            out.push(Line::fixed(enunciado, None));
            out.extend(pasos.iter().map(|step| Line::fixed(step, None)));
        }
    }
}

impl Engine {
    pub fn new(setup: Setup, bank: Arc<Banco>) -> Self {
        let clock = Clock::default();
        Self {
            motor: engine(&setup, bank.clone(), clock.clone()),
            clock,
            setup,
            bank,
            unsaved: Vec::new(),
            stored: 0,
            last_ms: 0,
            held: None,
            working: None,
            outcomes: Vec::new(),
            homework: 0,
        }
    }

    /// The engine that took `records`, in order, each at its own time.
    pub fn replay(setup: Setup, bank: Arc<Banco>, records: &[Record]) -> Self {
        let mut engine = Self::new(setup, bank);
        for record in records {
            engine.feed(record.at_ms, &record.input);
        }
        engine.stored = records.len();
        engine
    }

    pub fn started(&self) -> bool {
        self.stored + self.unsaved.len() > 0
    }

    pub fn closed(&self) -> bool {
        self.motor.terminada()
    }

    /// The inputs applied since the last `saved`.
    pub fn unsaved(&self) -> &[Record] {
        &self.unsaved
    }

    pub fn stored(&self) -> usize {
        self.stored
    }

    pub fn saved(&mut self) {
        self.stored += self.unsaved.len();
        self.unsaved.clear();
    }

    // The clock never goes back, whatever the caller's does.
    fn at(&mut self, at_ms: u64) {
        self.last_ms = self.last_ms.max(at_ms);
        self.clock.0.store(self.last_ms, Ordering::SeqCst);
    }

    fn card(&self) -> Option<Tarjeta> {
        self.motor.vista().tarjeta
    }

    /// Hands one input to the engine. Replaying goes through here too, so
    /// everything an input changes must happen in this function.
    fn feed(&mut self, at_ms: u64, input: &Input) -> Vec<Mensaje> {
        self.at(at_ms);
        let (exercise, stage) = (self.motor.ejercicio_actual(), self.motor.actividad());
        let messages = self.hand(input);
        if let Some(exercise) = exercise {
            self.note(input, &exercise, &stage, &messages);
        }
        messages
    }

    /// Keeps what the engine's grading says about the exercise on the screen.
    /// The screening and the simulated exam take one answer per question;
    /// elsewhere an exercise stays until it is solved or the engine leaves it.
    fn note(&mut self, input: &Input, exercise: &Ejercicio, stage: &str, messages: &[Mensaje]) {
        let one_answer = stage.starts_with("tamizaje") || stage.starts_with("simulacion");
        if self.working.as_ref().is_none_or(|working| working.exercise != exercise.id) {
            self.working = Some(Working { exercise: exercise.id.clone(), wrong: 0, helped: false });
        }
        let Some(working) = self.working.as_mut() else { return };
        let credit = match input {
            Input::Graded { unreadable: true, .. } => None,
            Input::Graded { correct, explained, .. } => {
                // The screening needs the explanation too (TAM-04); elsewhere a missing one is not asked for.
                let solved = *correct && explained.unwrap_or(!stage.starts_with("tamizaje"));
                let left = self.motor.ejercicio_actual().is_none_or(|now| now.id != exercise.id);
                match (solved, one_answer) {
                    (true, true) => Some(1.0),
                    (true, false) => Some(if working.wrong == 0 && !working.helped { 1.0 } else { 0.5 }),
                    (false, true) => Some(0.0),
                    (false, false) => {
                        working.wrong += 1;
                        // The engine gave up on it: back to the theory, or marked for the teacher.
                        left.then_some(0.0)
                    }
                }
            }
            Input::Help if !one_answer => {
                working.helped = true;
                None
            }
            // A hint the engine gave because the exercise was taking long.
            Input::Tick if messages.iter().any(|message| message.clase == Clase::Pista) => {
                working.helped = true;
                None
            }
            _ => None,
        };
        if let Some(credit) = credit {
            self.outcomes.push(Outcome {
                exercise: exercise.id.clone(),
                skill: skill_of(exercise),
                choice: !exercise.opciones.is_empty(),
                credit,
                at_ms: self.last_ms,
            });
            self.working = None;
        }
    }

    fn hand(&mut self, input: &Input) -> Vec<Mensaje> {
        let entry = match input.clone() {
            Input::Start { homework } => {
                self.homework = homework;
                // The engine asks for a photo of the homework only when the tutor can read one.
                self.motor.cfg.foto_tarea = homework >= HOMEWORK_LEVEL;
                Entrada::Comenzar
            }
            Input::Text { text } => Entrada::Texto(text),
            Input::Graded { read, correct, wrong_form, explained, unreadable } => {
                self.held = None;
                Entrada::Calificada(Calificacion {
                    respuesta_leida: read,
                    respuesta_correcta: correct,
                    forma_incorrecta: wrong_form,
                    explicacion_correcta: explained,
                    // The engine speaks a comment as its own line. Only a model
                    // writes one, and no model grades here.
                    comentario: None,
                    ilegible: unreadable,
                })
            }
            Input::Help => Entrada::Ayuda,
            Input::Tired => Entrada::Cansado,
            Input::LeaveScreening => Entrada::SalirTamizaje,
            Input::Activity { choice } => Entrada::Actividad(choice),
            Input::Tick => Entrada::Tick,
            Input::Chat { text, intent } => Entrada::Chat { texto: text, intencion: intent },
            Input::Hold { said } => {
                self.held = self.card().map(|card| Held { card: card_key(&card), said });
                return Vec::new();
            }
            Input::Homework { outcome, level, confidence } => match reading(outcome, level, confidence) {
                Some(reading) => Entrada::FotoTarea(reading),
                None => return Vec::new(),
            },
        };
        self.motor.entrada(entry)
    }

    fn apply(&mut self, at_ms: u64, input: Input) -> Vec<Mensaje> {
        let messages = self.feed(at_ms, &input);
        self.unsaved.push(Record { at_ms: self.last_ms, input });
        messages
    }

    /// Applies an input and turns what the engine answers into lines. A line
    /// that answers the student's own words is marked as such.
    fn push(&mut self, at_ms: u64, input: Input, out: &mut Vec<Line>) {
        let echoes = matches!(input, Input::Text { .. } | Input::Chat { .. });
        let messages = self.apply(at_ms, input);
        lines_of(messages, echoes, out);
    }

    /// Lets the time that has passed act: a hint for an exercise that is
    /// taking long, the end of a break, the warning before the last
    /// exercises. Kept as an input only when it did something.
    fn tick(&mut self, at_ms: u64, out: &mut Vec<Line>) {
        let before = self.motor.actividad();
        let messages = self.feed(at_ms, &Input::Tick);
        if !messages.is_empty() || self.motor.actividad() != before {
            self.unsaved.push(Record { at_ms: self.last_ms, input: Input::Tick });
        }
        lines_of(messages, false, out);
    }

    /// When the card on the screen changed, says what the engine only shows:
    /// the statement of a new exercise, and the drawing of a guided example.
    fn present(&self, before: Option<String>, out: &mut Vec<Line>) {
        let Some(card) = self.card() else { return };
        if Some(card_key(&card)) == before {
            return;
        }
        match card.modo {
            Modo::Tamizaje | Modo::Etapa2 | Modo::Tarea | Modo::Simulacion | Modo::Correccion => {
                out.push(card_line(&card));
            }
            // The engine's message already says the statement; its drawing is
            // only on the card.
            Modo::EjemploAsistido => {
                if let Some(drawing) = card.grafico.as_ref().and_then(visuals::drawing)
                    && let Some(line) = out.iter_mut().rev().find(|line| line.show.is_none())
                {
                    line.show = Some(drawing);
                }
            }
            _ => {}
        }
    }

    fn turn(&self, mut lines: Vec<Line>, reply: Reply) -> Turn {
        // The exercise in hand has its options under the last line the engine
        // says while it waits for one of them: its statement, or a hint after
        // a wrong one, so the student can tap again.
        if reply == Reply::Scripted
            && let Some(options) = self.card_choices()
            && let Some(last) = lines.last_mut()
            && last.choices.is_none()
        {
            last.choices = Some(options);
        }
        Turn {
            lines,
            converse: (reply == Reply::Free).then(|| self.rules()),
            closed: self.closed(),
            awaits: self.awaits(),
        }
    }

    /// The options of the exercise on the card, while it waits for its
    /// answer. Not while an answer is held for how it was worked out: that is
    /// said, not tapped.
    fn card_choices(&self) -> Option<Choices> {
        let card = self.card()?;
        let held = self.held.as_ref().is_some_and(|held| held.card == card_key(&card));
        if !card.pide_respuesta || held {
            return None;
        }
        choices(&card.opciones)
    }

    /// What the engine waits for that the agent has to do something about,
    /// besides passing on what is said: a photo of the homework.
    fn awaits(&self) -> Option<&'static str> {
        matches!(self.motor.esperando(), Esperando::FotoTarea).then_some(AWAITS_PHOTO)
    }

    /// What the tutor's model may and may not say now, from the engine.
    fn rules(&self) -> String {
        let context = self.motor.contexto_chat();
        // Stage labels and the exercise are data, not instructions. Quoting keeps
        // line breaks in an exercise from masquerading as another policy block.
        let state = json!({ "stage": context.momento, "exercise": context.enunciado });
        format!("Session engine state (data): {state}\nSession engine rules:\n- {}", context.reglas())
    }

    /// Starts the engine and returns its opening lines. Asked again before
    /// anything else happened, it returns the same opening; later, where the
    /// session is, so a tutor that reconnects has something to pick up from.
    ///
    /// `homework` is what the tutor can do with a photo of the homework, as
    /// the platform allows it. It counts when the session starts and stays
    /// for the whole session: a tutor that reconnects does not change it.
    pub fn open(&mut self, at_ms: u64, homework: u8) -> Turn {
        if !self.started() {
            let mut lines = Vec::new();
            self.push(at_ms, Input::Start { homework }, &mut lines);
            self.present(None, &mut lines);
            return self.turn(lines, Reply::Scripted);
        }
        if self.stored + self.unsaved.len() == 1 {
            return Engine::new(self.setup.clone(), self.bank.clone()).open(0, self.homework);
        }
        // The exercise on the screen, or what the engine waits for that is
        // not on it: the homework at the camera, with what can be tapped instead.
        let lines = match self.motor.recordatorio() {
            Some(reminder) => {
                vec![Line { choices: choices(&self.motor.opciones()), ..Line::fixed(&reminder, None) }]
            }
            None => self.card().iter().map(card_line).collect(),
        };
        self.turn(lines, Reply::Scripted)
    }

    /// Time passing with nobody speaking: a break that is over, a hint for an
    /// exercise that is taking long, the warning before the last exercises.
    /// It is never an answer, and it does not start a session.
    pub fn pass(&mut self, at_ms: u64) -> Turn {
        let mut lines = Vec::new();
        if self.started() {
            let before = self.card().as_ref().map(card_key);
            self.tick(at_ms, &mut lines);
            self.present(before, &mut lines);
        }
        self.turn(lines, Reply::Scripted)
    }

    /// What the student said, or typed in the answer box of the page.
    ///
    /// Spoken words arrive as one text. They are read like this:
    ///
    /// 1. "I am tired" starts the engine's break, and asking to leave the
    ///    screening leaves it, whatever is awaited.
    /// 2. When an answer is awaited and the text holds one (a number, a
    ///    fraction, one of the options), it is graded with the engine's own
    ///    checker. The number is the answer (the one said before "porque"
    ///    or the end of the first sentence, when there is one there) and the
    ///    whole text is the explanation, checked with the engine's key words,
    ///    which name the numbers too. An answer whose explanation is missing
    ///    where one is required is held, the student is asked once how they
    ///    worked it out, and what they say next is added to it (or replaces
    ///    it, when it is said like a new answer).
    /// 3. "No sé" is a wrong answer where there are no hints (the screening
    ///    and the simulated exam) and a request for a hint elsewhere.
    /// 4. In the guided moments (a date, "shall we start?", the theory), text
    ///    that moves the engine goes to the engine as text.
    /// 5. Anything else is conversation: the engine is told its intent, and
    ///    the tutor's model replies under the engine's rules. Asking for help
    ///    or for the answer goes to the engine's hints instead.
    ///
    /// Typed text skips 1 and 5: the answer box holds an answer.
    pub fn said(&mut self, at_ms: u64, said: &str, explanation: Option<&str>, typed: bool) -> Turn {
        let before = self.card().as_ref().map(card_key);
        let stage = self.motor.actividad();
        let mut lines = Vec::new();
        self.tick(at_ms, &mut lines);
        // When time alone moved the session on (a break that ended), what was
        // said belongs to the moment before: it is not read as an answer to
        // an exercise the student has not heard yet.
        let reply = if self.motor.actividad() == stage {
            let explanation = explanation.map(str::trim).filter(|text| !text.is_empty());
            self.hear(at_ms, said.trim(), explanation, typed, &mut lines)
        } else {
            Reply::Scripted
        };
        self.present(before, &mut lines);
        self.turn(lines, reply)
    }

    /// What the tutor read in a photo of the homework, which the engine asked
    /// for, and what the tutor says next. A reading nobody is waiting for is
    /// refused, and stores nothing.
    pub fn homework(
        &mut self,
        at_ms: u64,
        outcome: Reading,
        level: Option<u8>,
        confidence: Option<u8>,
    ) -> ApiResult<Turn> {
        if outcome == Reading::Shown {
            return Err(ApiError::Conflict("the session is not working through its homework"));
        }
        if self.awaits() != Some(AWAITS_PHOTO) {
            return Err(ApiError::Conflict("the session is not waiting for a photo of the homework"));
        }
        let before = self.card().as_ref().map(card_key);
        let mut lines = Vec::new();
        self.push(at_ms, Input::Homework { outcome, level, confidence }, &mut lines);
        self.present(before, &mut lines);
        Ok(self.turn(lines, Reply::Scripted))
    }

    fn hear(
        &mut self,
        at_ms: u64,
        said: &str,
        explanation: Option<&str>,
        typed: bool,
        out: &mut Vec<Line>,
    ) -> Reply {
        let awaited = self.motor.esperando();
        let intent = conversacion::clasificar(said);
        let text = || Input::Text { text: said.to_string() };
        if !typed {
            // In a break "tengo sueño" chooses an activity; it is not a request for another break.
            if intent == Intencion::EstoyCansado && !matches!(awaited, Esperando::Actividad { .. }) {
                self.push(at_ms, Input::Tired, out);
                return Reply::Scripted;
            }
            if self.motor.vista().boton_salir_tamizaje && wants_out(said) {
                self.push(at_ms, Input::LeaveScreening, out);
                return Reply::Scripted;
            }
        }
        match awaited {
            Esperando::Respuesta {
                respuesta,
                opciones,
                forma,
                pide_explicacion,
                claves,
                minimo_claves,
                ..
            } => {
                let key = Clave { respuesta: &respuesta, opciones: &opciones, forma };
                let needs = pide_explicacion.then_some((claves.as_slice(), minimo_claves));
                self.answer(at_ms, said, explanation, typed, intent, &key, needs, out)
            }
            Esperando::Explicacion { claves, minimo_claves, .. } => {
                // A long text is the explanation itself, even if a word in it sounds like a request.
                let short = said.split_whitespace().count() <= 6;
                if !typed && short && asks(intent, said) {
                    return self.chat(at_ms, said, intent, out);
                }
                if texto::es_no_se(said) {
                    self.push(at_ms, Input::Help, out);
                    return Reply::Scripted;
                }
                let explained =
                    correccion::explicacion_por_claves(explanation.unwrap_or(said), &claves, minimo_claves);
                self.push(at_ms, graded(None, explained, false, Some(explained), false), out);
                Reply::Scripted
            }
            Esperando::Conversacion { .. } => {
                if typed || self.motor.texto_es_flujo(said) {
                    self.push(at_ms, text(), out);
                    Reply::Scripted
                } else {
                    self.chat(at_ms, said, intent, out)
                }
            }
            Esperando::Actividad { .. } => {
                let chosen = |engine: &Self| engine.motor.vista().pausa.and_then(|pause| pause.actividad);
                let before = chosen(self);
                let messages = self.apply(at_ms, text());
                if typed || chosen(self) != before {
                    lines_of(messages, true, out);
                    return Reply::Scripted;
                }
                // The engine only said how long is left: let the model talk instead.
                self.chat(at_ms, said, intent, out)
            }
            // A photo of the homework, which the agent reads. What is said
            // meanwhile is the engine's to answer: "no tengo" goes on without
            // the photo, anything else is reminded of the camera.
            Esperando::FotoTarea | Esperando::Nada => {
                self.push(at_ms, text(), out);
                Reply::Scripted
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn answer(
        &mut self,
        at_ms: u64,
        said: &str,
        explanation: Option<&str>,
        typed: bool,
        intent: Intencion,
        key: &Clave,
        needs: Option<(&[Vec<String>], usize)>,
        out: &mut Vec<Line>,
    ) -> Reply {
        let readable = |text: &str| {
            !has_long_number(text)
                && if key.opciones.is_empty() {
                    texto::leer_respuesta(text).is_some()
                } else {
                    texto::leer_opcion(text, key.opciones).is_some()
                }
        };
        let card = self.card().as_ref().map(card_key);
        let held =
            self.held.as_ref().filter(|held| Some(&held.card) == card.as_ref()).map(|h| h.said.clone());
        // After an answer that is held, what comes next is how it was worked
        // out, and that names numbers too. It is a new answer only when it
        // is said like one: a few words, a correction, or "... porque ...".
        let restated = typed || held.is_none() || {
            let words: Vec<String> = said.split_whitespace().map(texto::normalizar).collect();
            let corrects = ["no", "perdon", "mejor"].contains(&words.first().map_or("", String::as_str));
            words.len() <= 4 || corrects || answer_part(said, readable) != said
        };
        let fresh = restated && readable(said);
        // "¿Qué significa 3/4?" has a number in it and is still a question;
        // asking for help while giving an answer is an answer.
        let question = matches!(intent, Intencion::AclararPalabra | Intencion::RepetirEnunciado);
        if !typed && asks(intent, said) && (question || !fresh) {
            return self.chat(at_ms, said, intent, out);
        }
        let answer = match (&held, fresh) {
            (_, true) if typed => said.to_string(),
            (_, true) => answer_part(said, readable).to_string(),
            (Some(held), false) if typed => held.clone(),
            (Some(held), false) => answer_part(held, readable).to_string(),
            (None, false) => {
                if texto::es_no_se(said) {
                    let no_hints = self.motor.contexto_chat().sin_ayuda;
                    if no_hints && !typed && texto::normalizar(said).contains("no entiend") {
                        // Not giving up: asking. The rules allow explaining a word, not helping.
                        return self.chat(at_ms, said, intent, out);
                    }
                    let input =
                        if no_hints { graded(None, false, false, Some(false), false) } else { Input::Help };
                    self.push(at_ms, input, out);
                    return Reply::Scripted;
                }
                if typed {
                    self.push(at_ms, graded(None, false, false, None, true), out);
                    return Reply::Scripted;
                }
                return self.chat(at_ms, said, intent, out);
            }
        };
        let reading = correccion::corregir(key, &answer);
        let unreadable = reading.veredicto == Veredicto::Ilegible;
        let mut explained = None;
        if let (Some((keys, least)), false) = (needs, unreadable) {
            // Typed, the explanation has its own box. Spoken, it is everything
            // the student said about this exercise: the keys name the numbers too.
            let explanation = match (explanation, typed, &held) {
                (Some(explanation), ..) => explanation.to_string(),
                (None, true, _) => String::new(),
                (None, false, Some(held)) => format!("{held} {said}"),
                (None, false, None) => said.to_string(),
            };
            let enough = correccion::explicacion_por_claves(&explanation, keys, least);
            // An explanation written in its own box is the explanation: it is
            // graded as it is, and the student is not asked for it again.
            let written = typed && !explanation.is_empty();
            if !enough && held.is_none() && !written {
                // Spoken, what was said so far is kept whole: it is the start of the explanation.
                let said = if typed { answer } else { said.to_string() };
                self.push(at_ms, Input::Hold { said }, out);
                out.push(Line::fixed(ASK_HOW, None));
                return Reply::Scripted;
            }
            explained = Some(enough);
        }
        let input = graded(
            reading.leida,
            reading.veredicto == Veredicto::Correcta,
            matches!(reading.veredicto, Veredicto::FormaIncorrecta { .. }),
            explained,
            unreadable,
        );
        self.push(at_ms, input, out);
        Reply::Scripted
    }

    /// Something said that is neither an answer nor a step of the engine.
    fn chat(&mut self, at_ms: u64, said: &str, intent: Intencion, out: &mut Vec<Line>) -> Reply {
        let chat = Input::Chat { text: said.to_string(), intent };
        match intent {
            // The engine's hints, or its fixed line where there are none.
            Intencion::PedirAyuda | Intencion::PedirRespuesta => {
                self.push(at_ms, Input::Help, out);
                Reply::Scripted
            }
            // Read again by the platform, word for word: no model needed.
            Intencion::RepetirEnunciado => {
                let lines = out.len();
                self.push(at_ms, chat, out);
                // The engine went on by itself (talk on one explanation has a
                // limit): what it said is the whole turn, and the statement on
                // the screen is no longer the one that was asked about.
                if out.len() > lines {
                    return Reply::Scripted;
                }
                match self.card() {
                    Some(card) => {
                        out.push(card_line(&card));
                        Reply::Scripted
                    }
                    None => Reply::Free,
                }
            }
            _ => {
                let lines = out.len();
                self.push(at_ms, chat, out);
                // When the engine answers a chat itself, that is the whole turn.
                if out.len() > lines { Reply::Scripted } else { Reply::Free }
            }
        }
    }

    /// The session as a student's screen may show it. The engine's own view
    /// also carries the expected answer, the key words of the explanation and
    /// the criteria (`Esperando`), the rules it applied and the family's
    /// report: none of that is copied here, field by field on purpose.
    pub fn step(&self, at_ms: u64) -> Value {
        self.clock.0.store(self.last_ms.max(at_ms), Ordering::SeqCst);
        let view = self.motor.vista();
        self.clock.0.store(self.last_ms, Ordering::SeqCst);
        let route: Vec<Value> = view
            .ruta
            .iter()
            .map(|step| {
                let state = match step.estado.as_str() {
                    "hecho" => "done",
                    "actual" => "current",
                    _ => "pending",
                };
                json!({ "name": step.nombre, "detail": step.detalle, "state": state })
            })
            .collect();
        let card = view.tarjeta.map(|card| {
            json!({
                "mode": card.modo,
                "title": card.titulo,
                "statement": card.enunciado,
                "visual": card.grafico.as_ref().and_then(visuals::drawing),
                "options": card.opciones,
                "asks_answer": card.pide_respuesta,
                "asks_explanation": card.pide_explicacion,
                "is_exercise": card.es_ejercicio,
                "note": card.nota,
                "hints_allowed": card.permite_pistas,
                "format_help": card.ayuda_formato,
            })
        });
        let mut step = json!({
            "stage": view.etapa,
            "progress": view.progreso,
            "route": route,
            "card": card,
            "elapsed_seconds": view.transcurrido_s,
            "closed": view.terminada,
        });
        // The page may point at the camera while the engine waits for the homework.
        if let Some(awaits) = self.awaits() {
            step["awaits"] = json!(awaits);
        }
        // What can be tapped to answer what the engine has just asked, as its
        // line offered it. An exercise's options are on its card.
        if let Some(offered) = choices(&self.motor.opciones()) {
            step["choices"] = json!(offered);
        }
        step
    }

    /// The family's report in the engine's words, one paragraph per message.
    /// Nothing while there is only the greeting: nothing happened to report.
    pub fn report(&self) -> Option<String> {
        let messages = self.motor.informe();
        (messages.len() > 1).then(|| messages.join("\n\n"))
    }

    /// What the next session of this child starts from, as the engine itself
    /// hands it over (`para_siguiente_sesion`). The names, the interests and
    /// the topics the student asked for stay out: the first two are read
    /// fresh, the last are the student's words.
    pub fn kept(&self) -> Kept {
        let (profile, _) = self.motor.para_siguiente_sesion();
        Kept {
            levels: profile.niveles,
            unfinished_screenings: profile.tamizaje_parcial,
            minutes_per_level: profile.time_to_master,
            used_exercises: profile.ejercicios_usados,
            sessions: self.setup.start.kept.sessions + 1,
        }
    }

    /// Every exercise the engine closed so far, in order.
    pub fn outcomes(&self) -> &[Outcome] {
        &self.outcomes
    }
}

/// Whether the student is asking for something instead of answering. The
/// engine's classifier reads "creo que es..." and "así que son tres octavos"
/// as asking what a word means, so that one also has to look like a question.
fn asks(intent: Intencion, said: &str) -> bool {
    match intent {
        Intencion::RepetirEnunciado | Intencion::PedirAyuda | Intencion::PedirRespuesta => true,
        Intencion::AclararPalabra => is_question(said) || texto::normalizar(said).contains("significa"),
        _ => false,
    }
}

fn graded(
    read: Option<String>,
    correct: bool,
    wrong_form: bool,
    explained: Option<bool>,
    unreadable: bool,
) -> Input {
    Input::Graded { read, correct, wrong_form, explained, unreadable }
}

// ----------------------------------------------------------------- storage

/// A session's engine in this process.
pub struct Live {
    engine: Engine,
    /// The wall time of the engine's clock at zero.
    anchor: DateTime<Utc>,
    /// False while an input is being applied and stored. Left false by a
    /// failure, so the next call rebuilds the engine from what was stored.
    settled: bool,
    used: std::time::Instant,
}

/// The engines of the sessions running in this process.
pub type Engines = Arc<Mutex<HashMap<Uuid, Arc<tokio::sync::Mutex<Live>>>>>;

/// An engine nobody has used for this long belongs to a session that is over.
const FORGET_AFTER: std::time::Duration = std::time::Duration::from_secs(3 * 3600);

pub fn runs(session: &Session) -> bool {
    session.engine
}

/// For the routes of the free mode: the engine and the supervisor's
/// exercises cannot both decide what the student works on.
pub fn free(session: &Session) -> ApiResult<()> {
    if runs(session) { Err(ApiError::Conflict("the session is run by the session engine")) } else { Ok(()) }
}

fn by_engine(session: &Session) -> ApiResult<()> {
    if runs(session) {
        Ok(())
    } else {
        Err(ApiError::Conflict("the session is not run by the session engine"))
    }
}

async fn setup(state: &AppState, session: &Session) -> ApiResult<Setup> {
    let not_runnable = ApiError::Conflict("the session cannot be run by the session engine");
    let Some(child_id) = session.child_id else { return Err(not_runnable) };
    let child = find_child(&state.db, child_id).await?;
    let guardian: Option<String> = guardian::Entity::find()
        .filter(guardian::Column::FamilyId.eq(child.family_id))
        .order_by_asc(guardian::Column::CreatedAt)
        .select_only()
        .column(guardian::Column::Name)
        .into_tuple()
        .one(&state.db)
        .await?;
    let stored = session_row::Entity::find_by_id(session.id).one(&state.db).await?;
    let objective: Option<Value> = stored.as_ref().and_then(|row| row.objective.clone());
    let Some((goal, due)) = goal(objective.as_ref(), &session.language) else { return Err(not_runnable) };
    // The session's own day, so an engine rebuilt after midnight is the same one.
    let today = (session.created_at + Duration::minutes(i64::from(state.config.timezone_offset_minutes)))
        .date_naive();
    let start: Option<Start> =
        stored.and_then(|row| row.engine_start).and_then(|start| serde_json::from_value(start).ok());
    // A session from before this was stored started from nothing, at the engine's own length.
    let start =
        start.unwrap_or(Start { minutes: *ENGINE_MINUTES.end(), kept: Kept::default(), minute: None });
    Ok(Setup {
        student: child.nickname,
        interests: child.interests,
        guardian: guardian.unwrap_or_else(|| GUARDIAN_FALLBACK.to_string()),
        today,
        goal,
        due,
        start,
    })
}

/// The session's engine rebuilt from its stored inputs.
async fn load(state: &AppState, session: &Session) -> ApiResult<Live> {
    let bank = bank().ok_or(ApiError::Unavailable("the session engine's bank is not valid"))?;
    let setup = setup(state, session).await?;
    let rows = session_engine_input::Entity::find()
        .filter(session_engine_input::Column::SessionId.eq(session.id))
        .order_by_asc(session_engine_input::Column::Seq)
        .all(&state.db)
        .await?;
    let anchor = rows.first().map_or_else(Utc::now, |row| row.at);
    let records: Vec<Record> = rows
        .into_iter()
        .map(|row| {
            let input: Input = serde_json::from_value(row.input)
                .map_err(|_| ApiError::Conflict("a stored input of the session engine cannot be read"))?;
            Ok(Record { at_ms: row.at_ms.max(0) as u64, input })
        })
        .collect::<ApiResult<_>>()?;
    Ok(Live {
        engine: Engine::replay(setup, bank, &records),
        anchor,
        settled: true,
        used: std::time::Instant::now(),
    })
}

async fn live(state: &AppState, session: &Session) -> ApiResult<Arc<tokio::sync::Mutex<Live>>> {
    if let Some(found) = state.engines.lock().expect("lock").get(&session.id).cloned() {
        return Ok(found);
    }
    let built = Arc::new(tokio::sync::Mutex::new(load(state, session).await?));
    let mut engines = state.engines.lock().expect("lock");
    engines.retain(|_, live| live.try_lock().map_or(true, |live| live.used.elapsed() < FORGET_AFTER));
    Ok(engines.entry(session.id).or_insert(built).clone())
}

/// Drops the session's engine from this process, when the session is over.
pub fn forget(state: &AppState, session_id: Uuid) {
    state.engines.lock().expect("lock").remove(&session_id);
}

/// Stores the inputs applied since the last time. `queued` are lines the
/// tutor still has to be handed, kept with the last of them.
async fn save(
    db: &DatabaseConnection,
    session_id: Uuid,
    live: &mut Live,
    queued: Option<&Value>,
) -> Result<(), DbErr> {
    let records = live.engine.unsaved();
    if records.is_empty() {
        return Ok(());
    }
    let txn = db.begin().await?;
    for (i, record) in records.iter().enumerate() {
        let last = i + 1 == records.len();
        let input = serde_json::to_value(&record.input).map_err(|error| DbErr::Custom(error.to_string()))?;
        session_engine_input::Entity::insert(session_engine_input::ActiveModel {
            session_id: Set(session_id),
            seq: Set((live.engine.stored() + i) as i32),
            at_ms: Set(record.at_ms as i64),
            input: Set(input),
            queued: Set(queued.filter(|_| last).cloned()),
            at: Set(live.anchor + Duration::milliseconds(record.at_ms as i64)),
        })
        .exec_without_returning(&txn)
        .await?;
    }
    txn.commit().await?;
    live.engine.saved();
    Ok(())
}

/// Runs `act` on the session's engine at the current time and stores the
/// inputs it applied. One at a time per session.
async fn with_engine<T>(
    state: &AppState,
    session: &Session,
    act: impl FnOnce(&mut Engine, u64) -> ApiResult<(T, Option<Value>)>,
) -> ApiResult<T> {
    let live = live(state, session).await?;
    let mut live = live.lock().await;
    // Another process may have taken inputs, or the last call here failed half way.
    let stored = session_engine_input::Entity::find()
        .filter(session_engine_input::Column::SessionId.eq(session.id))
        .count(&state.db)
        .await?;
    if !live.settled || stored != live.engine.stored() as u64 {
        *live = load(state, session).await?;
    }
    live.settled = false;
    live.used = std::time::Instant::now();
    if !live.engine.started() {
        live.anchor = Utc::now();
    }
    let at_ms = (Utc::now() - live.anchor).num_milliseconds().max(0) as u64;
    let (result, queued) = act(&mut live.engine, at_ms)?;
    save(&state.db, session.id, &mut live, queued.as_ref()).await?;
    live.settled = true;
    Ok(result)
}

/// The engine's opening lines, for the tutor that just joined. `homework` is
/// what the tutor can do with a photo of the homework, as the platform allows
/// it; it counts for the session only the first time.
pub async fn open(state: &AppState, session: &Session, homework: u8) -> ApiResult<Value> {
    with_engine(state, session, |engine, at_ms| Ok((engine.open(at_ms, homework).script(), None))).await
}

/// Lines from answers typed on the page since the tutor last asked, in
/// order. They are handed over once.
pub async fn queued(db: &DatabaseConnection, session_id: Uuid) -> Result<Option<Value>, DbErr> {
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "with due as (
                 select seq, queued from session_engine_inputs
                 where session_id = $1 and queued is not null for update
             ), handed as (
                 update session_engine_inputs input set queued = null from due
                 where input.session_id = $1 and input.seq = due.seq
             ) select queued from due order by seq",
            [session_id.into()],
        ))
        .await?;
    let queued: Vec<Value> =
        rows.iter().map(|row| row.try_get("", "queued")).collect::<Result<_, DbErr>>()?;
    if queued.is_empty() {
        return Ok(None);
    }
    let mut lines = Vec::new();
    let mut closed = false;
    let mut awaits = None;
    for part in queued {
        lines.extend(part["lines"].as_array().cloned().unwrap_or_default());
        closed |= part["closed"] == true;
        // What the engine waits for after the last of them.
        awaits = part.get("awaits").cloned();
    }
    let mut script = json!({ "lines": lines, "closed": closed });
    if let Some(awaits) = awaits {
        script["awaits"] = awaits;
    }
    Ok(Some(script))
}

/// What a child's next engine session starts from, as it is now, for a
/// session being created. Read inside the transaction that creates it.
pub async fn start_for(
    db: &impl sea_orm::ConnectionTrait,
    child_id: Uuid,
    minutes: u32,
    minute: u16,
) -> Result<Value, sea_orm::DbErr> {
    let kept: Option<Value> = child::Entity::find_by_id(child_id)
        .select_only()
        .column(child::Column::EngineProfile)
        .into_tuple::<Option<Value>>()
        .one(db)
        .await?
        .flatten();
    let kept: Kept = kept.and_then(|kept| serde_json::from_value(kept).ok()).unwrap_or_default();
    serde_json::to_value(Start { minutes, kept, minute: Some(minute) })
        .map_err(|error| sea_orm::DbErr::Custom(error.to_string()))
}

/// What is done with a session the engine ran once it is over, from its
/// stored inputs (so it works in the worker, which never had the live
/// engine): the child's profile for the next session, each graded exercise
/// as evidence for the learner model, and the family's report in the
/// engine's words, which is returned. Safe to run again.
pub async fn conclude(state: &AppState, session: &Session) -> ApiResult<Option<String>> {
    let (true, Some(child_id)) = (runs(session), session.child_id) else { return Ok(None) };
    let live = match load(state, session).await {
        Ok(live) => live,
        // The child is gone, or the engine cannot be rebuilt: nothing to conclude, not a failed review.
        Err(ApiError::NotFound(_) | ApiError::Conflict(_) | ApiError::Unavailable(_)) => return Ok(None),
        Err(error) => return Err(error),
    };
    // Never started, or its inputs are already gone: what is stored stands.
    if !live.engine.started() {
        return Ok(None);
    }
    // A session reviewed late does not undo what a later one learned.
    let kept =
        serde_json::to_value(live.engine.kept()).map_err(|error| ApiError::Internal(error.to_string()))?;
    child::Entity::update_many()
        .col_expr(child::Column::EngineProfile, Expr::value(kept))
        .col_expr(child::Column::EngineProfileAt, Expr::value(session.created_at))
        .filter(child::Column::Id.eq(child_id))
        .filter(
            Condition::any()
                .add(child::Column::EngineProfileAt.is_null())
                .add(child::Column::EngineProfileAt.lt(session.created_at)),
        )
        .exec(&state.db)
        .await?;

    // Only skills of the catalog count, as for the tutor's own exercises.
    let catalog: Vec<String> =
        crate::learning::catalog(&state.db).await?.into_iter().map(|skill| skill.id).collect();
    let attempts: Vec<crate::learning::NewAttempt> = live
        .engine
        .outcomes()
        .iter()
        .filter_map(|outcome| {
            let skill = outcome.skill.filter(|skill| catalog.iter().any(|known| known == skill))?;
            Some(crate::learning::NewAttempt {
                skill_id: skill.to_string(),
                question_id: Some(outcome.exercise.clone()),
                correct: outcome.credit > 0.0,
                credit: Some(outcome.credit),
                choice: outcome.choice,
                at: Some(live.anchor + Duration::milliseconds(outcome.at_ms as i64)),
            })
        })
        .collect();
    // A second run replaces what the first one wrote.
    attempt::Entity::delete_many()
        .filter(attempt::Column::SessionId.eq(session.id))
        .filter(attempt::Column::Source.eq("engine"))
        .exec(&state.db)
        .await?;
    crate::learning::record(&state.db, child_id, Some(session.id), "engine", &attempts, Utc::now()).await?;
    Ok(live.engine.report())
}

/// The same delete as for a session's turns, for its inputs.
pub async fn delete_inputs_after_review(db: &DatabaseConnection, session_id: Uuid) -> Result<(), DbErr> {
    db.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "delete from session_engine_inputs using sessions
         where session_engine_inputs.session_id = sessions.id and sessions.id = $1 and not sessions.keep_transcript",
        [session_id.into()],
    ))
    .await?;
    Ok(())
}

// ---------------------------------------------------------------- handlers

fn checked(text: &str, what: &'static str) -> ApiResult<()> {
    if text.trim().is_empty() || text.chars().count() > MAX_SAID_CHARS {
        return Err(ApiError::bad_request(format!("{what} must have 1 to {MAX_SAID_CHARS} characters")));
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct SaidInput {
    /// What the student said, in their words.
    said: String,
    /// How they worked it out, when the caller can tell it apart.
    #[serde(default)]
    explanation: Option<String>,
}

/// The agent reports what the student said and gets what the tutor does next.
pub async fn said(
    Agent(session): Agent,
    State(state): State<AppState>,
    Body(body): Body<SaidInput>,
) -> ApiResult<Json<Value>> {
    if session.status == "ended" {
        return Err(ApiError::Conflict("the session has ended"));
    }
    by_engine(&session)?;
    // Nothing said: only time has passed. The agent may call this on a timer.
    let silence = body.said.trim().is_empty();
    if !silence {
        checked(&body.said, "said")?;
    }
    if let Some(explanation) = body.explanation.as_deref().filter(|text| !text.trim().is_empty()) {
        checked(explanation, "explanation")?;
    }
    let turn = with_engine(&state, &session, |engine, at_ms| {
        if silence {
            return Ok((engine.pass(at_ms), None));
        }
        // A tutor that reports speech before asking for the opening gets the
        // opening: what was said came before the engine had asked anything.
        // It said nothing about the homework, so the engine asks for no photo.
        if !engine.started() {
            return Ok((engine.open(at_ms, 0), None));
        }
        Ok((engine.said(at_ms, &body.said, body.explanation.as_deref(), false), None))
    })
    .await?;
    Ok(Json(turn.reply()))
}

/// What the agent read in a photo of the homework: the outcome and, for a
/// homework that was read, its level and the reading's confidence, from 0 to
/// 1. Anything else, such as the photo itself, is refused.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HomeworkInput {
    outcome: Reading,
    #[serde(default)]
    level: Option<u8>,
    #[serde(default)]
    confidence: Option<f64>,
}

/// The agent reports what it read in a photo of the homework, while the
/// engine waits for one, and gets what the tutor says next.
pub async fn homework(
    Agent(session): Agent,
    State(state): State<AppState>,
    Body(body): Body<HomeworkInput>,
) -> ApiResult<Json<Value>> {
    if session.status == "ended" {
        return Err(ApiError::Conflict("the session has ended"));
    }
    by_engine(&session)?;
    let levels = aule_core::config::Config::default().niveles_por_tema;
    let (level, confidence) = match (body.outcome, body.level, body.confidence) {
        (Reading::Read, Some(level), Some(confidence)) => {
            if !(1..=levels).contains(&level) {
                return Err(ApiError::bad_request(format!("level must be from 1 to {levels}")));
            }
            if !(0.0..=1.0).contains(&confidence) {
                return Err(ApiError::bad_request("confidence must be from 0 to 1"));
            }
            // The engine's threshold is in percent.
            (Some(level), Some((confidence * 100.0).round() as u8))
        }
        (Reading::Read, ..) => {
            return Err(ApiError::bad_request("a homework that was read needs its level and confidence"));
        }
        (_, None, None) => (None, None),
        _ => return Err(ApiError::bad_request("only a homework that was read has a level and a confidence")),
    };
    let turn = with_engine(&state, &session, |engine, at_ms| {
        Ok((engine.homework(at_ms, body.outcome, level, confidence)?, None))
    })
    .await?;
    Ok(Json(turn.reply()))
}

/// The session, for the operator or a guardian of its child.
async fn session_for(state: &AppState, caller: &Caller, session_id: Uuid) -> ApiResult<Session> {
    let session = session_row::Entity::find_by_id(session_id)
        .one(&state.db)
        .await?
        .map(Session::from)
        .ok_or(ApiError::NotFound("session"))?;
    match (caller, session.child_id) {
        // A session of another family does not exist as far as a guardian can tell.
        (_, Some(child_id)) => {
            child_for(&state.db, caller, child_id).await.map_err(|_| ApiError::NotFound("session"))?;
        }
        (Caller::Operator, None) => {}
        (Caller::Guardian { .. }, None) => return Err(ApiError::NotFound("session")),
    }
    if session.status == "ended" {
        return Err(ApiError::Conflict("the session has ended"));
    }
    by_engine(&session)?;
    Ok(session)
}

/// Where the session is, for the student's screen.
pub async fn step(
    caller: Caller,
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let session = session_for(&state, &caller, session_id).await?;
    Ok(Json(with_engine(&state, &session, |engine, at_ms| Ok((engine.step(at_ms), None))).await?))
}

#[derive(Deserialize)]
pub struct TypedInput {
    answer: String,
    #[serde(default)]
    explanation: Option<String>,
}

/// An answer typed on the page. The engine takes it like a spoken one; what
/// it answers is spoken by the tutor, which collects it with its next report
/// of turns. The page gets where the session is now.
pub async fn typed(
    caller: Caller,
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    Body(body): Body<TypedInput>,
) -> ApiResult<Json<Value>> {
    let session = session_for(&state, &caller, session_id).await?;
    checked(&body.answer, "answer")?;
    if let Some(explanation) = body.explanation.as_deref().filter(|text| !text.trim().is_empty()) {
        checked(explanation, "explanation")?;
    }
    let step = with_engine(&state, &session, |engine, at_ms| {
        if !engine.started() {
            return Err(ApiError::Conflict("the session has not started"));
        }
        let turn = engine.said(at_ms, &body.answer, body.explanation.as_deref(), true);
        Ok((engine.step(at_ms), Some(turn.script())))
    })
    .await?;
    Ok(Json(step))
}

#[cfg(test)]
mod tests;
