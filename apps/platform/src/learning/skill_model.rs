//! "Elo with memory" skill model: estimates, without an LLM, the probability
//! that a student answers a question correctly. It belongs to the logistic
//! family that the knowledge tracing literature finds on par with deep models
//! when data is scarce (Pelánek 2016; Gervet et al. 2020), with a per-skill
//! memory in the style of spaced-repetition schedulers. It is a pure,
//! deterministic function: the state is rebuilt by replaying the history.
//!
//! `P(correct) = g + (1 − g)·σ(z)`, with
//! `z = global_ability + skill_offset + practice − difficulty − forgetting`:
//!
//! - **Global ability** of the student and a **per-skill offset** (logits).
//!   Each answer moves both by `step/(1 + decay·n)·signal`: large steps with
//!   little evidence and small ones later. The global ability is the starting
//!   point for a new skill.
//! - **Practice**: `practice_gain·ln(1 + attempts)` on the skill, the learning
//!   curve that shows up regardless of right and wrong answers.
//! - **Difficulty** of the question (logits, 0 = average question). The caller
//!   supplies it; [`Calibration`] estimates it from the answers of all
//!   students as the difficulty of the skill plus an offset for the question,
//!   so a new question inherits the difficulty of its skill.
//! - **Guessing** `g`: a correct answer that could have been a guess counts
//!   for less (`signal = (credit − P)·σ(z)/P`, the gradient of the
//!   likelihood).
//! - **Forgetting**: subtracts up to `forget_weight` logits following
//!   `1 − 2^(−Δt/h)`. The half-life `h` grows on a correct answer in
//!   proportion to what had been forgotten (`h·(1 + growth·(1 − R))`), so six
//!   correct answers in a row within one session do not inflate it; a wrong
//!   answer shrinks it.
//!
//! It can be corrected in three ways:
//!
//! 1. **Data**: since the model is a replay of the history, fixing an attempt,
//!    its skill or its credit and calling again recomputes everything.
//! 2. **Teacher or parent**: a [`Correction`] sets the level of a skill ("they
//!    already know this") and weighs as much as `correction_weight` attempts;
//!    later attempts keep moving it.
//! 3. **Parameters**: every number in the model lives in [`Params`] and can be
//!    sent in the request. `examples/skill_model_eval.rs` refits them from a
//!    log of answers and measures calibration.

use std::collections::BTreeMap;

use chrono::{DateTime, TimeDelta, Utc};
use serde::{Deserialize, Deserializer, Serialize};

pub const MAX_ATTEMPTS: usize = 20_000;
pub const MAX_CORRECTIONS: usize = 1_000;
pub const MIN_HALF_LIFE_DAYS: f64 = 0.25;
pub const MAX_HALF_LIFE_DAYS: f64 = 365.0;
/// Retention at which a review is due.
pub const REVIEW_RETENTION: f64 = 0.8;
/// Minimum evidence (attempts or a correction) to declare mastery.
pub const MIN_EVIDENCE: f64 = 3.0;

const MS_PER_DAY: f64 = 86_400_000.0;
/// Corrections are clamped so that the logit stays finite.
const LEVEL_MARGIN: f64 = 0.02;

fn null_to_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// Model parameters. The steps, the guessing rates and the practice gain come
/// from a fit on ASSISTments 2009 and 2017
/// (`examples/skill_model_eval.rs`). The memory values are a starting point:
/// on that data they barely change the prediction, so they have to be refit
/// on your own answers.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Params {
    /// Global ability of a student with no history (logit).
    pub prior_ability: f64,
    /// Initial step and decay of the global ability.
    pub global_step: f64,
    pub global_decay: f64,
    /// Initial step and decay of the per-skill offset.
    pub skill_step: f64,
    pub skill_decay: f64,
    /// Logits added per unit of `ln(1 + attempts)` on the skill.
    pub practice_gain: f64,
    /// Initial step and decay of the difficulty of a question or skill.
    pub item_step: f64,
    pub item_decay: f64,
    /// Probability of a correct guess: open answer and multiple choice.
    pub guess_open: f64,
    pub guess_choice: f64,
    /// Logits subtracted for a completely forgotten skill.
    pub forget_weight: f64,
    pub half_life_init_days: f64,
    /// Half-life growth on a correct answer when everything was forgotten.
    pub half_life_growth: f64,
    /// Factor applied to the half-life after a wrong answer (0–1).
    pub half_life_shrink: f64,
    /// `p_now` from which the skill counts as mastered.
    pub mastery_p: f64,
    /// Success rate aimed for when choosing the next question's difficulty.
    pub target_success: f64,
    /// Number of attempts a teacher or parent correction is worth.
    pub correction_weight: f64,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            prior_ability: 0.0,
            global_step: 0.6,
            global_decay: 0.05,
            skill_step: 0.3,
            skill_decay: 0.1,
            practice_gain: 0.2,
            item_step: 0.6,
            item_decay: 0.05,
            guess_open: 0.0,
            guess_choice: 0.1,
            forget_weight: 0.5,
            half_life_init_days: 2.0,
            half_life_growth: 2.0,
            half_life_shrink: 0.5,
            mastery_p: 0.85,
            target_success: 0.8,
            correction_weight: 10.0,
        }
    }
}

impl Params {
    fn validate(&self) -> Result<(), String> {
        let finite = [
            self.prior_ability,
            self.global_step,
            self.global_decay,
            self.skill_step,
            self.skill_decay,
            self.practice_gain,
            self.item_step,
            self.item_decay,
            self.forget_weight,
            self.half_life_growth,
            self.correction_weight,
        ];
        if finite.iter().any(|value| !value.is_finite()) || finite[1..].iter().any(|value| *value < 0.0) {
            return Err("params: steps, decays and weights must be non-negative numbers.".to_string());
        }
        if ![self.guess_open, self.guess_choice].iter().all(|guess| (0.0..1.0).contains(guess)) {
            return Err("params: guess_open and guess_choice must be in [0, 1).".to_string());
        }
        if ![self.mastery_p, self.target_success].iter().all(|p| *p > 0.0 && *p < 1.0) {
            return Err("params: mastery_p and target_success must be between 0 and 1.".to_string());
        }
        if !(self.half_life_init_days > 0.0 && self.half_life_init_days <= MAX_HALF_LIFE_DAYS) {
            return Err(format!("params: half_life_init_days must be in (0, {MAX_HALF_LIFE_DAYS}]."));
        }
        if !(self.half_life_shrink > 0.0 && self.half_life_shrink <= 1.0) {
            return Err("params: half_life_shrink must be in (0, 1].".to_string());
        }
        Ok(())
    }

    fn guess(&self, choice: bool) -> f64 {
        if choice { self.guess_choice } else { self.guess_open }
    }

    /// New difficulty of a question or skill with `answers` previous answers,
    /// given the signal returned by [`LearnerModel::observe`].
    pub fn item_update(&self, difficulty: f64, answers: u32, signal: f64) -> f64 {
        difficulty - step(self.item_step, self.item_decay, f64::from(answers)) * signal
    }
}

fn step(initial: f64, decay: f64, evidence: f64) -> f64 {
    initial / (1.0 + decay * evidence)
}

fn sigmoid(z: f64) -> f64 {
    1.0 / (1.0 + (-z).exp())
}

fn logit(p: f64) -> f64 {
    (p / (1.0 - p)).ln()
}

fn retention(dt_days: f64, half_life: f64) -> f64 {
    2f64.powf(-dt_days / half_life)
}

/// Days elapsed from `from` to `to` (0 if `to` is earlier).
fn days_between(from: DateTime<Utc>, to: DateTime<Utc>) -> f64 {
    ((to - from).num_milliseconds() as f64 / MS_PER_DAY).max(0.0)
}

fn round4(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

/// State of one skill for one student (unrounded).
#[derive(Clone, Debug)]
pub struct SkillState {
    /// Offset on top of the global ability (logit).
    pub offset: f64,
    /// Attempts plus the weight of the latest correction.
    pub evidence: f64,
    pub attempts: u32,
    pub half_life: f64,
    pub last_at: Option<DateTime<Utc>>,
    pub corrected: bool,
}

/// Model state for one student.
#[derive(Clone, Debug)]
pub struct LearnerModel {
    pub params: Params,
    /// Global ability (logit).
    pub ability: f64,
    pub answered: u32,
    pub skills: BTreeMap<String, SkillState>,
}

impl LearnerModel {
    pub fn new(params: Params) -> Self {
        Self { params, ability: params.prior_ability, answered: 0, skills: BTreeMap::new() }
    }

    /// Logit of a correct answer to an average question on a just-reviewed skill.
    fn known_logit(&self, state: &SkillState) -> f64 {
        self.ability + state.offset + self.practice(state.attempts)
    }

    fn practice(&self, attempts: u32) -> f64 {
        self.params.practice_gain * f64::from(attempts).ln_1p()
    }

    /// Logit of a correct answer at `at` to a question of difficulty
    /// `difficulty`, with the forgetting accumulated since the last attempt.
    fn logit_at(&self, skill: &str, difficulty: f64, at: DateTime<Utc>) -> f64 {
        let Some(state) = self.skills.get(skill) else {
            return self.ability - difficulty;
        };
        let forgotten = match state.last_at {
            Some(last) => 1.0 - retention(days_between(last, at), state.half_life),
            None => 0.0,
        };
        self.known_logit(state) - difficulty - self.params.forget_weight * forgotten
    }

    /// Probability of a correct answer at `at`.
    pub fn predict(&self, skill: &str, difficulty: f64, choice: bool, at: DateTime<Utc>) -> f64 {
        let guess = self.params.guess(choice);
        guess + (1.0 - guess) * sigmoid(self.logit_at(skill, difficulty, at))
    }

    /// Records an attempt with credit 0–1 and returns the error signal, the
    /// same one that moves the question's difficulty in [`Params::item_update`].
    pub fn observe(
        &mut self,
        skill: &str,
        difficulty: f64,
        choice: bool,
        credit: f64,
        at: DateTime<Utc>,
    ) -> f64 {
        let params = self.params;
        let solved = sigmoid(self.logit_at(skill, difficulty, at));
        let guess = params.guess(choice);
        let p = guess + (1.0 - guess) * solved;
        let signal = (credit - p) * if p > 0.0 { solved / p } else { 1.0 };

        self.ability += step(params.global_step, params.global_decay, f64::from(self.answered)) * signal;
        self.answered += 1;

        let state = self.skills.entry(skill.to_string()).or_insert_with(|| SkillState {
            offset: 0.0,
            evidence: 0.0,
            attempts: 0,
            half_life: params.half_life_init_days,
            last_at: None,
            corrected: false,
        });
        state.offset += step(params.skill_step, params.skill_decay, state.evidence) * signal;
        if let Some(last) = state.last_at {
            let forgotten = 1.0 - retention(days_between(last, at), state.half_life);
            state.half_life = if credit >= 0.5 {
                (state.half_life * (1.0 + params.half_life_growth * forgotten)).min(MAX_HALF_LIFE_DAYS)
            } else {
                (state.half_life * params.half_life_shrink).max(MIN_HALF_LIFE_DAYS)
            };
        }
        state.evidence += 1.0;
        state.attempts += 1;
        // An attempt dated before the last one does not rewind the memory.
        state.last_at = Some(state.last_at.map_or(at, |last| last.max(at)));
        signal
    }

    /// Teacher or parent correction: sets to `level` the probability of a
    /// correct answer to an average question on the skill, just reviewed at `at`.
    pub fn correct(&mut self, skill: &str, level: f64, at: DateTime<Utc>) {
        let params = self.params;
        let attempts = self.skills.get(skill).map_or(0, |state| state.attempts);
        let offset =
            logit(level.clamp(LEVEL_MARGIN, 1.0 - LEVEL_MARGIN)) - self.ability - self.practice(attempts);
        let state = self.skills.entry(skill.to_string()).or_insert_with(|| SkillState {
            offset,
            evidence: 0.0,
            attempts: 0,
            half_life: params.half_life_init_days,
            last_at: None,
            corrected: true,
        });
        state.offset = offset;
        state.evidence = params.correction_weight;
        state.last_at = Some(state.last_at.map_or(at, |last| last.max(at)));
        state.corrected = true;
    }
}

/// Estimated difficulty (logit) and the number of answers behind it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Difficulty {
    pub value: f64,
    pub answers: u32,
}

/// Calibrates difficulty from the answers of many students, in date order:
/// each answer moves the student, the skill and the question at once. The
/// result feeds `difficulty` in [`TraceAttempt`].
#[derive(Clone, Debug)]
pub struct Calibration {
    pub params: Params,
    /// Without per-skill difficulty every question starts at 0.
    pub by_skill: bool,
    pub learners: BTreeMap<String, LearnerModel>,
    pub skills: BTreeMap<String, Difficulty>,
    /// Offset of each question on top of the difficulty of its skill.
    pub questions: BTreeMap<String, Difficulty>,
}

impl Calibration {
    pub fn new(params: Params) -> Self {
        Self {
            params,
            by_skill: true,
            learners: BTreeMap::new(),
            skills: BTreeMap::new(),
            questions: BTreeMap::new(),
        }
    }

    /// Difficulty of a question: that of its skill plus its own offset.
    pub fn difficulty(&self, skill: &str, question: &str) -> f64 {
        let part =
            |table: &BTreeMap<String, Difficulty>, id: &str| table.get(id).map_or(0.0, |entry| entry.value);
        part(&self.skills, skill) + part(&self.questions, question)
    }

    /// Records an answer and returns the probability of a correct answer that
    /// the model gave it before seeing it.
    pub fn observe(
        &mut self,
        learner: &str,
        skill: &str,
        question: &str,
        choice: bool,
        credit: f64,
        at: DateTime<Utc>,
    ) -> f64 {
        let params = self.params;
        let difficulty = self.difficulty(skill, question);
        if !self.learners.contains_key(learner) {
            self.learners.insert(learner.to_string(), LearnerModel::new(params));
        }
        let model = self.learners.get_mut(learner).expect("just inserted");
        let predicted = model.predict(skill, difficulty, choice, at);
        let signal = model.observe(skill, difficulty, choice, credit, at);
        let update = |table: &mut BTreeMap<String, Difficulty>, id: &str| {
            if !table.contains_key(id) {
                table.insert(id.to_string(), Difficulty::default());
            }
            let entry = table.get_mut(id).expect("just inserted");
            *entry = Difficulty {
                value: params.item_update(entry.value, entry.answers, signal),
                answers: entry.answers + 1,
            };
        };
        update(&mut self.questions, question);
        if self.by_skill {
            update(&mut self.skills, skill);
        }
        predicted
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct TraceAttempt {
    pub skill_id: String,
    #[serde(default)]
    pub question_id: Option<String>,
    pub correct: bool,
    /// Credit 0–1. If missing: 1 if `correct`, otherwise 0.
    #[serde(default)]
    pub credit: Option<f64>,
    /// RFC 3339 timestamp of the attempt.
    pub at: DateTime<Utc>,
    /// Multiple-choice question (can be answered correctly by guessing).
    #[serde(default, deserialize_with = "null_to_default")]
    pub choice: bool,
    /// Calibrated difficulty of the question (logit; 0 = average question).
    #[serde(default)]
    pub difficulty: Option<f64>,
}

/// Teacher or parent correction on a skill.
#[derive(Clone, Debug, Deserialize)]
pub struct Correction {
    pub skill_id: String,
    pub at: DateTime<Utc>,
    /// Probability (0–1) of a correct answer to an average question on the skill.
    pub level: f64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct TraceRequest {
    /// Reference instant (inclusive). Later attempts and corrections are ignored. Defaults to now.
    #[serde(default)]
    pub now: Option<DateTime<Utc>>,
    #[serde(default, deserialize_with = "null_to_default")]
    pub attempts: Vec<TraceAttempt>,
    #[serde(default, deserialize_with = "null_to_default")]
    pub corrections: Vec<Correction>,
    /// Parameters to override; missing ones take their default value.
    #[serde(default, deserialize_with = "null_to_default")]
    pub params: Params,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SkillTrace {
    pub skill_id: String,
    pub attempts: u32,
    /// Expected success on an average question, just reviewed and without guessing.
    pub p_known: f64,
    /// The same now and in 7 days, with the accumulated forgetting.
    pub p_now: f64,
    pub p_7d: f64,
    pub half_life_days: f64,
    /// When retention drops to 0.8.
    pub review_at: Option<DateTime<Utc>>,
    /// `p_now` reaches `mastery_p` with enough evidence.
    pub mastered: bool,
    /// Difficulty (logit) at which the success rate now would be `target_success`.
    pub target_difficulty: f64,
    /// The skill has a teacher or parent correction.
    pub corrected: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct TraceResponse {
    /// Global ability of the student (logit).
    pub ability: f64,
    /// Skills with attempts or corrections, by id.
    pub skills: Vec<SkillTrace>,
    /// Parameters used for the computation.
    pub params: Params,
}

fn validate(request: &TraceRequest) -> Result<(), String> {
    if request.attempts.len() > MAX_ATTEMPTS {
        return Err(format!("At most {MAX_ATTEMPTS} attempts are allowed."));
    }
    if request.corrections.len() > MAX_CORRECTIONS {
        return Err(format!("At most {MAX_CORRECTIONS} corrections are allowed."));
    }
    request.params.validate()?;
    for attempt in &request.attempts {
        if attempt.credit.is_some_and(|credit| !(0.0..=1.0).contains(&credit)) {
            return Err("credit must be a number between 0 and 1.".to_string());
        }
        if attempt.difficulty.is_some_and(|difficulty| !difficulty.is_finite()) {
            return Err("difficulty must be a finite number.".to_string());
        }
    }
    if request.corrections.iter().any(|correction| !(0.0..=1.0).contains(&correction.level)) {
        return Err("level must be a number between 0 and 1.".to_string());
    }
    Ok(())
}

/// State of the student after replaying their history. `Err` carries a
/// message for a 400 response.
pub fn trace(request: &TraceRequest) -> Result<TraceResponse, String> {
    validate(request)?;
    let params = request.params;
    let now = request.now.unwrap_or_else(Utc::now);

    // Stable timeline: by date and, on equal dates, attempts before
    // corrections and in input order.
    enum Event<'a> {
        Attempt(&'a TraceAttempt),
        Correction(&'a Correction),
    }
    let mut events: Vec<(DateTime<Utc>, u8, Event)> = request
        .attempts
        .iter()
        .map(|attempt| (attempt.at, 0, Event::Attempt(attempt)))
        .chain(request.corrections.iter().map(|correction| (correction.at, 1, Event::Correction(correction))))
        .filter(|(at, _, _)| *at <= now)
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

    let week = now + TimeDelta::days(7);
    let skills = model
        .skills
        .iter()
        .map(|(skill_id, state)| {
            let logit_now = model.logit_at(skill_id, 0.0, now);
            let p_now = sigmoid(logit_now);
            let review_at = state.last_at.map(|last| {
                let days = state.half_life * (1.0 / REVIEW_RETENTION).log2();
                last + TimeDelta::milliseconds((days * MS_PER_DAY).round() as i64)
            });
            SkillTrace {
                skill_id: skill_id.clone(),
                attempts: state.attempts,
                p_known: round4(sigmoid(model.known_logit(state))),
                p_now: round4(p_now),
                p_7d: round4(sigmoid(model.logit_at(skill_id, 0.0, week))),
                half_life_days: round4(state.half_life),
                review_at,
                mastered: state.evidence >= MIN_EVIDENCE && p_now >= params.mastery_p,
                target_difficulty: round4(logit_now - logit(params.target_success)),
                corrected: state.corrected,
            }
        })
        .collect();

    Ok(TraceResponse { ability: round4(model.ability), skills, params })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(day: u32, minute: u32) -> DateTime<Utc> {
        format!("2026-10-{day:02}T10:{minute:02}:00Z").parse().unwrap()
    }

    fn attempt(skill_id: &str, day: u32, minute: u32, correct: bool) -> TraceAttempt {
        TraceAttempt {
            skill_id: skill_id.to_string(),
            question_id: None,
            correct,
            credit: None,
            at: at(day, minute),
            choice: false,
            difficulty: None,
        }
    }

    fn request(attempts: Vec<TraceAttempt>, now: DateTime<Utc>) -> TraceRequest {
        TraceRequest { now: Some(now), attempts, corrections: Vec::new(), params: Params::default() }
    }

    fn skill<'a>(response: &'a TraceResponse, id: &str) -> &'a SkillTrace {
        response.skills.iter().find(|skill| skill.skill_id == id).unwrap()
    }

    #[test]
    fn historical_trace_ignores_later_attempts_and_corrections() {
        let now = at(2, 0);
        let mut past = request(vec![attempt("a", 1, 0, false)], now);
        past.corrections.push(Correction { skill_id: "b".into(), at: at(1, 1), level: 0.7 });
        let expected = trace(&past).unwrap();
        let mut history = past;
        history.attempts.extend([attempt("a", 3, 0, true), attempt("future", 3, 1, true)]);
        history.corrections.extend([
            Correction { skill_id: "a".into(), at: at(3, 2), level: 0.95 },
            Correction { skill_id: "future-correction".into(), at: at(3, 3), level: 0.9 },
        ]);
        let actual = trace(&history).unwrap();
        assert_eq!(actual.ability, expected.ability);
        assert_eq!(actual.skills, expected.skills);
    }

    #[test]
    fn trace_includes_events_at_the_reference_instant() {
        let now = at(2, 0);
        let mut boundary = request(vec![attempt("a", 2, 0, true)], now);
        boundary.corrections.push(Correction { skill_id: "a".into(), at: now, level: 0.9 });
        let actual = trace(&boundary).unwrap();
        assert_eq!(actual.skills.len(), 1);
        assert_eq!(skill(&actual, "a").attempts, 1);
        assert!(skill(&actual, "a").corrected);
        assert!(skill(&actual, "a").p_now > 0.8);

        boundary.now = Some(now - TimeDelta::milliseconds(1));
        let earlier = trace(&boundary).unwrap();
        assert!(earlier.skills.is_empty());
        assert_eq!(earlier.ability, Params::default().prior_ability);
    }

    #[test]
    fn answers_move_the_estimate_and_evidence_slows_it() {
        let empty = trace(&request(Vec::new(), at(1, 0))).unwrap();
        assert_eq!(empty.ability, 0.0);
        assert!(empty.skills.is_empty());

        let right = trace(&request(vec![attempt("a", 1, 0, true)], at(1, 1))).unwrap();
        let wrong = trace(&request(vec![attempt("a", 1, 0, false)], at(1, 1))).unwrap();
        assert!(skill(&right, "a").p_known > 0.5 && skill(&wrong, "a").p_known < 0.5);

        // The tenth correct answer moves the estimate less than the first.
        let p = |n: u32| {
            let attempts = (0..n).map(|minute| attempt("a", 1, minute, true)).collect();
            skill(&trace(&request(attempts, at(1, 30))).unwrap(), "a").p_known
        };
        assert!(p(1) - 0.5 > p(10) - p(9));
        assert!(!skill(&right, "a").mastered, "one correct answer is not enough evidence");
        assert!(
            skill(
                &trace(&request((0..12).map(|m| attempt("a", 1, m, true)).collect(), at(1, 30))).unwrap(),
                "a"
            )
            .mastered
        );
    }

    #[test]
    fn guessable_and_easy_questions_count_less() {
        let p_known = |edit: fn(&mut TraceAttempt)| {
            let mut one = attempt("a", 1, 0, true);
            edit(&mut one);
            skill(&trace(&request(vec![one], at(1, 1))).unwrap(), "a").p_known
        };
        let open = p_known(|_| {});
        assert!(p_known(|a| a.choice = true) < open, "a correct multiple-choice answer says less");
        assert!(p_known(|a| a.difficulty = Some(-2.0)) < open, "an easy correct answer says less");
        assert!(p_known(|a| a.difficulty = Some(2.0)) > open, "a hard correct answer says more");
        assert!(p_known(|a| a.credit = Some(0.5)) < open, "partial credit says less");
    }

    #[test]
    fn global_ability_is_the_starting_point_for_a_new_skill() {
        let mut attempts: Vec<TraceAttempt> = (0..8).map(|minute| attempt("a", 1, minute, true)).collect();
        attempts.extend((8..16).map(|minute| attempt("b", 1, minute, true)));
        let strong = LearnerModel {
            ability: trace(&request(attempts, at(1, 30))).unwrap().ability,
            ..LearnerModel::new(Params::default())
        };
        assert!(strong.ability > 0.5);
        assert!(strong.predict("new", 0.0, false, at(1, 30)) > 0.6);
        assert_eq!(LearnerModel::new(Params::default()).predict("new", 0.0, false, at(1, 30)), 0.5);
    }

    #[test]
    fn spaced_practice_builds_memory_and_cramming_does_not() {
        // Six correct answers in one session: the half-life barely changes.
        let crammed: Vec<TraceAttempt> = (0..6).map(|minute| attempt("a", 1, minute, true)).collect();
        let crammed = trace(&request(crammed, at(1, 10))).unwrap();
        let init = Params::default().half_life_init_days;
        assert!(skill(&crammed, "a").half_life_days < init * 1.05);

        // Six correct answers on alternate days: it grows.
        let spaced: Vec<TraceAttempt> = (0..6).map(|index| attempt("a", 1 + 2 * index, 0, true)).collect();
        let spaced = trace(&request(spaced, at(11, 10))).unwrap();
        let spaced = skill(&spaced, "a");
        assert!(spaced.half_life_days > init * 4.0, "{}", spaced.half_life_days);
        assert!(spaced.p_now > spaced.p_7d && spaced.p_known >= spaced.p_now);
        let review = spaced.review_at.unwrap();
        assert!(review > at(11, 0) && review < at(31, 0));

        // A wrong answer shrinks the half-life, and forgetting lowers `p_now`, not `p_known`.
        let mut failed: Vec<TraceAttempt> =
            (0..6).map(|index| attempt("a", 1 + 2 * index, 0, true)).collect();
        failed.push(attempt("a", 13, 0, false));
        let failed = trace(&request(failed, at(13, 10))).unwrap();
        assert!(skill(&failed, "a").half_life_days < spaced.half_life_days);
        let later = trace(&request(vec![attempt("a", 1, 0, true)], at(30, 0))).unwrap();
        let fresh = trace(&request(vec![attempt("a", 1, 0, true)], at(1, 1))).unwrap();
        assert_eq!(skill(&later, "a").p_known, skill(&fresh, "a").p_known);
        assert!(skill(&later, "a").p_now < skill(&fresh, "a").p_now);
    }

    #[test]
    fn target_difficulty_tracks_the_learner() {
        let weak =
            trace(&request(vec![attempt("a", 1, 0, false), attempt("a", 1, 1, false)], at(1, 2))).unwrap();
        let strong =
            trace(&request(vec![attempt("a", 1, 0, true), attempt("a", 1, 1, true)], at(1, 2))).unwrap();
        let (weak, strong) = (skill(&weak, "a"), skill(&strong, "a"));
        assert!(strong.target_difficulty > weak.target_difficulty);
        // At that difficulty the expected success rate is `target_success`.
        let model = LearnerModel::new(Params::default());
        let target = model.logit_at("x", 0.0, at(1, 0)) - logit(0.8);
        assert!((model.predict("x", target, false, at(1, 0)) - 0.8).abs() < 1e-9);
    }

    #[test]
    fn teacher_correction_sets_the_level_and_later_answers_still_count() {
        let attempts = vec![attempt("a", 1, 0, false), attempt("a", 1, 1, false), attempt("a", 1, 2, false)];
        let mut corrected = request(attempts.clone(), at(2, 1));
        corrected.corrections = vec![Correction { skill_id: "a".to_string(), at: at(2, 0), level: 0.95 }];
        let response = trace(&corrected).unwrap();
        let state = skill(&response, "a");
        assert_eq!(state.p_known, 0.95);
        assert!(state.corrected && state.mastered && state.attempts == 3);

        // A correction on a skill with no attempts is valid too.
        corrected.corrections.push(Correction { skill_id: "b".to_string(), at: at(2, 0), level: 0.0 });
        assert_eq!(skill(&trace(&corrected).unwrap(), "b").p_known, 0.02);

        // Later wrong answers lower it, less than without a prior correction.
        let mut after = attempts;
        after.extend([attempt("a", 2, 5, false), attempt("a", 2, 6, false)]);
        let mut contested = request(after, at(2, 10));
        contested.corrections = vec![Correction { skill_id: "a".to_string(), at: at(2, 0), level: 0.95 }];
        let contested = trace(&contested).unwrap();
        let p = skill(&contested, "a").p_known;
        assert!(p < 0.95 && p > 0.6, "{p}");
    }

    #[test]
    fn input_order_does_not_matter_and_params_can_be_overridden() {
        let ordered = vec![attempt("a", 1, 0, true), attempt("a", 2, 0, false), attempt("b", 3, 0, true)];
        let mut shuffled = ordered.clone();
        shuffled.reverse();
        let (left, right) =
            (trace(&request(ordered, at(4, 0))).unwrap(), trace(&request(shuffled, at(4, 0))).unwrap());
        assert_eq!(left.skills, right.skills);
        assert_eq!(left.ability, right.ability);

        let body = r#"{"now":"2026-10-20T10:00:00Z","params":{"forget_weight":0},
            "attempts":[{"skill_id":"a","correct":true,"at":"2026-10-01T10:00:00Z"}]}"#;
        let response = trace(&serde_json::from_str(body).unwrap()).unwrap();
        assert_eq!(response.params.forget_weight, 0.0);
        assert_eq!(response.params.skill_step, Params::default().skill_step);
        assert_eq!(response.skills[0].p_now, response.skills[0].p_known, "no forgetting, no decay");
    }

    #[test]
    fn item_difficulty_follows_the_answers() {
        let params = Params::default();
        let mut difficulty = 0.0;
        for answers in 0..20 {
            let mut model = LearnerModel::new(params);
            let signal = model.observe("a", difficulty, false, 0.0, at(1, 0));
            difficulty = params.item_update(difficulty, answers, signal);
        }
        assert!(difficulty > 1.0, "a question everyone gets wrong is hard: {difficulty}");
    }

    #[test]
    fn practice_adds_a_learning_curve() {
        let mixed =
            |n: u32| (0..n).map(|minute| attempt("a", 1, minute, minute % 2 == 0)).collect::<Vec<_>>();
        let p_known = |gain: f64, n: u32| {
            let mut request = request(mixed(n), at(1, 40));
            request.params.practice_gain = gain;
            skill(&trace(&request).unwrap(), "a").p_known
        };
        assert!(p_known(0.2, 20) > p_known(0.0, 20), "with the same mix of answers, practice adds");
    }

    #[test]
    fn calibration_learns_question_and_skill_difficulty() {
        let mut calibration = Calibration::new(Params::default());
        for learner in 0..30 {
            let id = format!("s{learner}");
            // "addition" goes well except for one question; "roots" goes badly.
            calibration.observe(&id, "addition", "s1", false, 1.0, at(1, learner));
            calibration.observe(&id, "addition", "s2", false, 0.0, at(1, learner));
            calibration.observe(&id, "roots", "r1", false, 0.0, at(1, learner));
            calibration.observe(&id, "roots", "r2", false, 0.0, at(1, learner));
        }
        assert!(calibration.difficulty("addition", "s2") > calibration.difficulty("addition", "s1") + 1.0);
        assert!(calibration.skills["roots"].value > calibration.skills["addition"].value);
        // A new question inherits the difficulty of its skill.
        assert!(calibration.difficulty("roots", "new") > calibration.difficulty("addition", "new"));
        assert_eq!(calibration.difficulty("other", "new"), 0.0);
        assert_eq!(calibration.questions["s1"].answers, 30);
        // The prediction made before each answer improves with what was learned.
        let late = calibration.observe("newcomer", "roots", "r1", false, 0.0, at(2, 0));
        assert!(late < 0.3, "{late}");

        calibration.by_skill = false;
        calibration.observe("newcomer", "roots", "r1", false, 0.0, at(2, 1));
        assert_eq!(calibration.skills["roots"].answers, 61);
    }

    #[test]
    fn validation_errors() {
        let mut bad = request(vec![attempt("a", 1, 0, true)], at(1, 1));
        bad.attempts[0].credit = Some(1.5);
        assert!(trace(&bad).unwrap_err().contains("credit"));
        bad.attempts[0].credit = None;
        bad.attempts[0].difficulty = Some(f64::NAN);
        assert!(trace(&bad).unwrap_err().contains("difficulty"));
        bad.attempts[0].difficulty = None;
        bad.corrections = vec![Correction { skill_id: "a".to_string(), at: at(1, 0), level: 1.2 }];
        assert!(trace(&bad).unwrap_err().contains("level"));
        bad.corrections.clear();
        bad.params.guess_choice = 1.0;
        assert!(trace(&bad).unwrap_err().contains("guess"));
        bad.params = Params { half_life_shrink: 0.0, ..Params::default() };
        assert!(trace(&bad).unwrap_err().contains("half_life_shrink"));
    }
}
