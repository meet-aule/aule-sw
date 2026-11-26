//! The engine driven the way the API drives it, without a database: a whole
//! session with the compiled-in bank, the rules for reading speech, what the
//! student's screen may get, and rebuilding an engine from its inputs.

use super::visuals::tests::{assert_follows, contract};
use super::*;

fn setup(goal: Goal) -> Setup {
    Setup {
        student: "Mateo".into(),
        interests: vec!["fútbol".into()],
        guardian: "Ana".into(),
        today: NaiveDate::from_ymd_opt(2026, 11, 14).unwrap(),
        goal,
        due: NaiveDate::from_ymd_opt(2026, 11, 19),
        start: Start { minutes: 90, kept: Kept::default(), minute: Some(16 * 60) },
    }
}

fn engine(goal: Goal) -> Engine {
    Engine::new(setup(goal), bank().unwrap())
}

/// A student who answers what the engine awaits, right or wrong, with the
/// explanation in its own field the way a caller that can tell them apart does.
struct Student {
    engine: Engine,
    /// The engine's clock, moved by the test.
    now: u64,
    records: Vec<Record>,
    turns: Vec<Turn>,
}

impl Student {
    fn new(goal: Goal) -> Self {
        Self::from(setup(goal))
    }

    fn from(setup: Setup) -> Self {
        Self::opened(setup, 0)
    }

    /// A student whose tutor can do `homework` with a photo of the homework.
    fn opened(setup: Setup, homework: u8) -> Self {
        let engine = Engine::new(setup, bank().unwrap());
        let mut student = Self { engine, now: 0, records: Vec::new(), turns: Vec::new() };
        let opening = student.engine.open(0, homework);
        student.keep(opening);
        student
    }

    fn keep(&mut self, turn: Turn) -> Turn {
        self.records.extend(self.engine.unsaved().iter().cloned());
        self.engine.saved();
        self.turns.push(turn.clone());
        turn
    }

    fn says(&mut self, said: &str) -> Turn {
        self.now += 45_000;
        let turn = self.engine.said(self.now, said, None, false);
        self.keep(turn)
    }

    fn explains(&mut self, said: &str, explanation: &str) -> Turn {
        self.now += 45_000;
        let turn = self.engine.said(self.now, said, Some(explanation), false);
        self.keep(turn)
    }

    /// Answers what is awaited. `right` chooses the answer and the explanation.
    fn answers(&mut self, right: bool) -> Turn {
        match self.engine.motor.esperando() {
            Esperando::Respuesta { respuesta, opciones, claves, .. } => {
                let answer = match (right, opciones.iter().find(|option| **option != respuesta)) {
                    (true, _) => respuesta,
                    (false, Some(other)) => other.clone(),
                    (false, None) => "97/98".to_string(),
                };
                // A wrong answer is wrong whatever the reasons given for it.
                self.explains(&answer, &explanation(&claves, true))
            }
            Esperando::Explicacion { claves, .. } => {
                let explanation = explanation(&claves, right);
                self.says(&explanation)
            }
            Esperando::Conversacion { sugerencias } => self.says(&sugerencias[0]),
            Esperando::Actividad { opciones } => {
                // Does the activity, and is back when the break is over.
                let turn = self.says(&opciones[0]);
                self.now += 5 * 60_000;
                turn
            }
            // This student has no photo of the homework to show.
            Esperando::FotoTarea => self.says("no tengo"),
            Esperando::Nada => panic!("nothing is awaited at {}", self.engine.motor.actividad()),
        }
    }

    fn at(&self) -> String {
        self.engine.motor.actividad()
    }

    /// Answers right until the engine is somewhere whose name starts with `stage`.
    fn until(&mut self, stage: &str) {
        for _ in 0..400 {
            if self.at().starts_with(stage) {
                return;
            }
            self.answers(true);
        }
        panic!("never reached {stage}: at {}", self.at());
    }
}

/// An explanation that touches every group of key words, or none of them.
fn explanation(keys: &[Vec<String>], right: bool) -> String {
    if !right {
        return "lo hice así nomás".to_string();
    }
    let words: Vec<&str> = keys.iter().filter_map(|group| group.first()).map(String::as_str).collect();
    format!("lo pensé así: {}", words.join(" y "))
}

fn said_by_tutor(turn: &Turn) -> String {
    turn.lines.iter().map(|line| line.say.as_str()).collect::<Vec<_>>().join(" | ")
}

#[test]
fn a_session_runs_from_the_greeting_to_the_report() {
    let contract = contract();
    let mut student = Student::new(Goal::Homework);

    // The opening: a greeting a model may reword, and the plan as a question.
    let opening = student.turns[0].clone();
    assert!(opening.lines[0].say.contains("Mateo") && opening.lines[0].reword, "{opening:?}");
    assert!(opening.lines.last().unwrap().say.contains("Tarea de Fracciones"), "{opening:?}");
    assert!(opening.lines.iter().all(|line| !line.echoes));
    assert_eq!((opening.converse.clone(), opening.closed), (None, false));

    // "Yes" starts the screening: the engine names it, and the platform adds
    // the statement of the first question, which the engine only shows.
    let first = student.says("sí, empecemos");
    assert_eq!(student.at(), "tamizaje:1");
    assert_eq!(first.converse, None);
    let question = first.lines.last().unwrap();
    assert!(question.say.contains('¿'), "{question:?}");
    assert_eq!(question.show.as_ref().unwrap()["kind"], "fraction_circle");
    assert!(said_by_tutor(&first).contains("Pregunta 1 de 5"));

    // Five questions: right, wrong, "no sé", right, right.
    student.answers(true);
    assert_eq!(student.at(), "tamizaje:2");
    student.answers(false);
    assert_eq!(student.at(), "tamizaje:3");
    let gave_up = student.says("no sé");
    assert_eq!((student.at().as_str(), &gave_up.converse), ("tamizaje:4", &None), "{gave_up:?}");
    student.answers(true);
    let last = student.answers(true);
    // Right, then wrong: the student is at level 1 and discovers level 2.
    assert_eq!(student.at(), "etapa1:2:teoria", "{}", said_by_tutor(&last));
    // Below the homework's level, the screening closes with the plan, word for
    // word: what is reinforced before the homework, and why.
    let plan = "He analizado cómo te fue en los ejercicios, y antes de que hagamos la tarea, te voy a \
                ayudar a reforzar las fracciones equivalentes, las sumas y restas con el mismo denominador \
                y las sumas y restas con distinto denominador. Esto es importante para que aprendas a \
                hacer la tarea por tu cuenta.";
    assert!(last.lines.iter().any(|line| line.say == plan && !line.reword), "{}", said_by_tutor(&last));

    // Discovery: the theory moves on with "sigue"; a worked example is spoken step by step.
    student.until("etapa1:2:no_asistido");
    let example = student.turns.last().unwrap().clone();
    assert!(example.lines.len() > 3, "the statement and each step are lines: {example:?}");
    student.until("etapa2:2");

    // Practice: a wrong answer gets the engine's hint and the exercise stays.
    let wrong = student.answers(false);
    assert_eq!(student.at(), "etapa2:2:1");
    assert!(said_by_tutor(&wrong).contains("Te dejo una pregunta para pensar"), "{wrong:?}");
    assert_eq!(wrong.converse, None);
    let right = student.answers(true);
    assert_eq!(student.at(), "etapa2:2:2", "{}", said_by_tutor(&right));

    // To the end, answering right, with the breaks the engine gives.
    for _ in 0..600 {
        if student.engine.closed() {
            break;
        }
        student.answers(true);
    }
    assert!(student.engine.closed(), "still at {}", student.at());
    let goodbye = student.turns.last().unwrap();
    assert!(goodbye.closed && said_by_tutor(goodbye).contains("Mateo"), "{goodbye:?}");

    // Every line of the session: something to say, and a screen that follows the contract.
    let lines: Vec<&Line> = student.turns.iter().flat_map(|turn| &turn.lines).collect();
    assert!(lines.len() > 100);
    let mut kinds = std::collections::BTreeSet::new();
    for line in &lines {
        assert!(!line.say.trim().is_empty());
        if let Some(visual) = &line.show {
            assert_follows(&contract, visual);
            kinds.insert(visual["kind"].as_str().unwrap().to_string());
        }
    }
    for kind in ["exercise", "fraction_bars", "fraction_circle", "table"] {
        assert!(kinds.contains(kind), "{kind} was never shown: {kinds:?}");
    }
    // Answering what was awaited never needed the model.
    assert!(student.turns.iter().all(|turn| turn.converse.is_none()));

    // The family's report, in the engine's words.
    let report = student.engine.report().unwrap();
    assert!(report.starts_with("¡Hola, Ana! Te saluda Aule, tutor de Mateo."), "{report}");
    assert!(report.contains("Matemáticas"), "{report}");
}

#[test]
fn an_engine_rebuilt_from_its_inputs_is_the_same_engine() {
    let mut student = Student::new(Goal::ExamPrep);
    student.says("sí");
    student.answers(true);
    student.answers(false);
    student.says("no sé");
    student.answers(true);
    student.answers(true);
    // Time does things too: a break asked for, an activity, the break ending
    // on its own, and a hint for an exercise that takes too long.
    student.until("etapa2:2");
    student.says("estoy cansado");
    assert_eq!(student.at(), "pausa");
    student.says("saltos de estrella");
    student.now += 6 * 60_000;
    let back = student.says("ya volví");
    assert!(said_by_tutor(&back).contains("seguimos"), "{back:?}");
    assert_eq!(student.at(), "etapa2:2:1");
    student.now += 10 * 60_000;
    let late = student.says("mmm espera");
    assert!(said_by_tutor(&late).contains("te está tomando un ratito"), "{late:?}");
    student.answers(false);
    student.says("no sé");
    student.answers(true);
    assert!(student.records.iter().filter(|record| record.input == Input::Tick).count() >= 2);

    let view = |engine: &Engine| serde_json::to_value(engine.motor.vista()).unwrap();
    for upto in [1, 2, student.records.len() / 2, student.records.len()] {
        let rebuilt = Engine::replay(setup(Goal::ExamPrep), bank().unwrap(), &student.records[..upto]);
        if upto == student.records.len() {
            assert_eq!(view(&rebuilt), view(&student.engine));
            assert_eq!(rebuilt.step(student.now), student.engine.step(student.now));
        }
        assert_eq!(rebuilt.stored(), upto);
    }

    // The rebuilt engine goes on exactly like the live one.
    let mut rebuilt = Engine::replay(setup(Goal::ExamPrep), bank().unwrap(), &student.records);
    for said in ["3/4", "no sé", "¿qué significa simplificar?", "estoy cansado"] {
        student.now += 20_000;
        let live = student.engine.said(student.now, said, None, false);
        assert_eq!(rebuilt.said(student.now, said, None, false), live, "{said}");
        assert_eq!(view(&rebuilt), view(&student.engine), "{said}");
    }

    // What is stored reads back as the same inputs.
    for record in &student.records {
        let stored = serde_json::to_value(&record.input).unwrap();
        assert_eq!(serde_json::from_value::<Input>(stored).unwrap(), record.input);
    }
    assert_eq!(serde_json::to_value(Input::Start { homework: 0 }).unwrap(), json!({ "kind": "start" }));
    assert_eq!(
        serde_json::to_value(Input::Chat { text: "hola".into(), intent: Intencion::Charla }).unwrap(),
        json!({ "kind": "chat", "text": "hola", "intent": "charla" })
    );
}

/// Every string anywhere in a JSON value.
fn strings(value: &Value, found: &mut Vec<String>) {
    match value {
        Value::String(text) => found.push(text.clone()),
        Value::Array(items) => items.iter().for_each(|item| strings(item, found)),
        Value::Object(fields) => fields.values().for_each(|field| strings(field, found)),
        _ => {}
    }
}

/// Every field name anywhere in a JSON value.
fn names(value: &Value, found: &mut std::collections::BTreeSet<String>) {
    match value {
        Value::Array(items) => items.iter().for_each(|item| names(item, found)),
        Value::Object(fields) => {
            for (name, field) in fields {
                found.insert(name.clone());
                names(field, found);
            }
        }
        _ => {}
    }
}

/// The step must not carry what the engine keeps from the student: the
/// expected answer, the key words of the explanation, the criteria.
fn assert_no_answer(student: &Student) {
    let step = student.engine.step(student.now);
    let text = step.to_string();
    let mut fields = std::collections::BTreeSet::new();
    names(&step, &mut fields);
    let allowed = [
        "stage",
        "progress",
        "route",
        "name",
        "detail",
        "state",
        "card",
        "elapsed_seconds",
        "closed",
        "mode",
        "title",
        "statement",
        "visual",
        "options",
        "asks_answer",
        "asks_explanation",
        "is_exercise",
        "note",
        "hints_allowed",
        "format_help",
        // inside a visual
        "kind",
        "fractions",
        "numerator",
        "denominator",
        "label",
        "labelled",
        "groups",
        "count",
        "fill",
        "from",
        "to",
        "step",
        "marks",
    ];
    for field in &fields {
        assert!(allowed.contains(&field.as_str()), "unexpected field {field} at {}", student.at());
    }
    let mut shown = Vec::new();
    strings(&step, &mut shown);
    let card = student.engine.card();
    // What the engine itself puts in front of the student.
    let visible = card
        .as_ref()
        .map(|card| format!("{} {} {}", card.enunciado, card.nota.clone().unwrap_or_default(), card.titulo))
        .unwrap_or_default();
    match student.engine.motor.esperando() {
        Esperando::Respuesta { respuesta, opciones, criterio, claves, .. } => {
            if opciones.is_empty() {
                // The answer is nowhere as a value of its own, and nowhere at
                // all unless the engine's own statement names it.
                assert!(!shown.contains(&respuesta), "the answer {respuesta} is a field at {}", student.at());
                if respuesta.contains('/') && !visible.contains(&respuesta) {
                    assert!(
                        !text.contains(&respuesta),
                        "the answer {respuesta} is in the step at {}",
                        student.at()
                    );
                }
            } else {
                // The options are shown; which one is right is not. (A
                // drawing may label a bar with the same fraction.)
                assert_eq!(step["card"]["options"], json!(opciones));
                let mut rest = step.clone();
                rest["card"]["options"] = Value::Null;
                rest["card"]["visual"] = Value::Null;
                let mut outside = Vec::new();
                strings(&rest, &mut outside);
                assert!(!outside.contains(&respuesta), "the right option is marked at {}", student.at());
            }
            if let Some(criteria) = criterio {
                assert!(!text.contains(&criteria));
            }
            for group in claves.iter().filter(|group| group.len() > 1) {
                assert!(!text.contains(&serde_json::to_string(group).unwrap()));
            }
        }
        Esperando::Explicacion { criterio, claves, .. } => {
            assert!(!text.contains(&criterio));
            for group in claves.iter().filter(|group| group.len() > 1) {
                assert!(!text.contains(&serde_json::to_string(group).unwrap()));
            }
        }
        _ => {}
    }
    // The engine's log of rules, its report and its measures are not for the screen either.
    for hidden in ["TAM-", "PIS-", "Te saluda Aule", "primer_intento"] {
        assert!(!text.contains(hidden), "{hidden} at {}", student.at());
    }
}

#[test]
fn the_students_screen_never_gets_the_answer_or_how_it_is_checked() {
    let mut student = Student::new(Goal::Homework);
    assert_no_answer(&student);
    let mut stages = std::collections::BTreeSet::new();
    for turn in 0..800 {
        if student.engine.closed() {
            break;
        }
        // Wrong now and then, so the screening leaves levels to discover, and
        // hints, worked examples and repeats are seen too.
        student.answers(turn % 3 != 1);
        assert_no_answer(&student);
        stages.insert(student.at().split(':').next().unwrap().to_string());
    }
    assert!(student.engine.closed());
    for stage in ["tamizaje", "etapa1", "etapa2", "terminada"] {
        assert!(stages.contains(stage), "{stage} was never seen: {stages:?}");
    }
    let step = student.engine.step(student.now);
    assert_eq!((step["closed"].clone(), step["card"].clone()), (json!(true), Value::Null));
    assert!(step["route"].as_array().unwrap().iter().all(|part| part["state"] == "done"), "{step}");
}

/// A student in the screening, at its first question (3/8 of a circle).
fn in_screening() -> Student {
    let mut student = Student::new(Goal::Homework);
    student.says("sí");
    assert_eq!(student.at(), "tamizaje:1");
    student
}

/// A student practising level 2 on their own.
fn in_practice() -> Student {
    let mut student = in_screening();
    student.answers(true);
    for _ in 0..4 {
        student.answers(false);
    }
    student.until("etapa2:2");
    student
}

#[test]
fn a_tired_student_at_night_rests_and_the_session_closes() {
    // At 22:50 where the family lives, "estoy cansado" ends the session kindly
    // instead of proposing an active break (PAU-07).
    let mut night = setup(Goal::Homework);
    night.start.minute = Some(22 * 60 + 50);
    let mut student = Student::from(night);
    let turn = student.says("estoy cansado");
    let said = said_by_tutor(&turn);
    assert!(said.contains("Ya es tarde") && !said.contains("Pausa activa"), "{turn:?}");
    assert!(turn.closed && student.engine.closed(), "{turn:?}");
}

#[test]
fn a_spoken_answer_is_split_into_the_number_and_how_it_was_worked_out() {
    // The number first, then why: the engine's own reader would take the "3"
    // after the last "es", so the part before "porque" is what is graded.
    let mut student = in_screening();
    let turn = student.says("tres octavos porque el ocho es el total de partes y tres las pintadas");
    assert_eq!(student.at(), "tamizaje:2", "{turn:?}");
    assert_eq!(
        student.records.last().unwrap().input,
        Input::Graded {
            read: Some("3/8".into()),
            correct: true,
            wrong_form: false,
            explained: Some(true),
            unreadable: false
        }
    );
    // The screening says thanks and moves on: never whether it was right.
    let said = said_by_tutor(&turn);
    assert!(said.contains("Gracias") && !said.contains("bien") && !said.contains("correct"), "{said}");

    // Only the number: it is held, and the student is asked once how they got it.
    let mut student = in_screening();
    let turn = student.says("tres octavos");
    assert_eq!(student.at(), "tamizaje:1");
    assert_eq!(said_by_tutor(&turn), ASK_HOW);
    assert_eq!(student.records.last().unwrap().input, Input::Hold { said: "tres octavos".into() });
    let turn = student.says("el ocho es el total de partes y el tres las que están pintadas");
    assert_eq!(student.at(), "tamizaje:2", "{turn:?}");
    assert!(matches!(
        &student.records.last().unwrap().input,
        Input::Graded { read: Some(read), correct: true, explained: Some(true), .. } if read == "3/8"
    ));

    // Asked once, not twice: a second answer without a reason is graded as it is.
    let mut student = in_screening();
    student.says("tres octavos");
    student.says("no sé explicarlo");
    assert_eq!(student.at(), "tamizaje:2");
    assert!(matches!(
        student.records.last().unwrap().input,
        Input::Graded { correct: true, explained: Some(false), .. }
    ));

    // The answer comes at the end of the sentence.
    let mut student = in_screening();
    student.says("conté ocho partes en total y tres pintadas, así que son tres octavos");
    assert!(matches!(
        &student.records.last().unwrap().input,
        Input::Graded { read: Some(read), correct: true, explained: Some(true), .. } if read == "3/8"
    ));

    // A held answer belongs to its exercise: it is not used for the next one.
    let mut student = in_screening();
    student.says("tres octavos");
    student.says("quiero salir del tamizaje");
    assert!(!student.at().starts_with("tamizaje"));
    assert!(
        student
            .engine
            .held
            .as_ref()
            .is_none_or(|held| Some(&held.card) != student.engine.card().as_ref().map(card_key).as_ref())
    );
}

#[test]
fn what_is_not_an_answer_goes_where_the_engine_expects_it() {
    // In the screening there are no hints: asking for one gets the engine's fixed line.
    let mut student = in_screening();
    let turn = student.says("¿me ayudas?");
    assert!(said_by_tutor(&turn).contains("En el Tamizaje no te puedo dar pistas"), "{turn:?}");
    assert_eq!((student.at().as_str(), &turn.converse), ("tamizaje:1", &None));

    // A question about a word is conversation: the model answers, under rules
    // that forbid helping with the exercise or saying whether it is right.
    let turn = student.says("¿qué significa numerador?");
    assert!(turn.lines.is_empty(), "{turn:?}");
    let rules = turn.converse.unwrap();
    assert!(rules.contains("screening") && rules.contains("Never give the current exercise"), "{rules}");
    assert!(rules.contains("do not judge it or say whether it is correct"), "{rules}");
    assert!(rules.contains("no help with solving is allowed"), "{rules}");
    assert!(!rules.contains("Mateo") && !rules.contains("3/8"), "{rules}");
    assert_eq!(student.at(), "tamizaje:1");
    assert_eq!(
        student.records.last().unwrap().input,
        Input::Chat { text: "¿qué significa numerador?".into(), intent: Intencion::AclararPalabra }
    );

    // "No entiendo" is a question too; "no sé" is giving the question up.
    let turn = student.says("no entiendo la pregunta");
    assert!(turn.converse.is_some() && student.at() == "tamizaje:1", "{turn:?}");
    let turn = student.says("ni idea");
    assert_eq!((student.at().as_str(), &turn.converse), ("tamizaje:2", &None));

    // Hearing the statement again needs no model: the platform reads it.
    let turn = student.says("¿me repites la pregunta?");
    assert_eq!(turn.converse, None);
    assert_eq!(turn.lines.len(), 1);
    assert_eq!(turn.lines[0].say, student.engine.card().unwrap().enunciado);

    // Chatter is conversation, and moves nothing.
    let turn = student.says("mi perro se llama Rocky");
    assert!(turn.lines.is_empty() && turn.converse.is_some(), "{turn:?}");
    assert_eq!(student.at(), "tamizaje:2");

    // The student may leave the screening, as the engine told them.
    let turn = student.says("me siento abrumado, quiero salir");
    assert!(said_by_tutor(&turn).contains("Dejamos el Tamizaje aquí"), "{turn:?}");
    assert!(!student.at().starts_with("tamizaje"));

    // In practice there are hints: "no sé" and "ayúdame" both get the next one.
    let mut student = in_practice();
    let turn = student.says("no sé");
    assert!(said_by_tutor(&turn).contains("Te ayudo con una pregunta"), "{turn:?}");
    assert_eq!(turn.converse, None);
    let turn = student.says("dame una pista");
    assert_eq!((student.at().as_str(), &turn.converse), ("etapa2:2:1", &None));
    assert!(!turn.lines.is_empty());

    // Tired: the engine's break, with its activities on the screen.
    let turn = student.says("estoy cansado");
    assert_eq!(student.at(), "pausa");
    assert_eq!(turn.lines.last().unwrap().show.as_ref().unwrap()["kind"], "table");
    // In the break, naming an activity chooses it; anything else is talk. Being
    // sleepy never picks the star jumps: a calm activity is proposed instead.
    let turn = student.says("tengo sueño");
    let said = said_by_tutor(&turn);
    assert!(said.contains("Respiración del globo") && !said.contains("Saltos de estrella"), "{turn:?}");
    let turn = student.says("¿cuánto falta?");
    assert!(turn.lines.is_empty(), "{turn:?}");
    assert!(turn.converse.unwrap().contains("active break"));

    // "Ya volví" before doing any activity is answered, then one is proposed,
    // a calm one since the break began with "estoy cansado"; said after the
    // activity, it ends the break.
    let mut student = in_practice();
    student.says("estoy cansado");
    let turn = student.says("ya volví");
    let said = said_by_tutor(&turn);
    assert!(said.contains("Antes de seguir") && said.contains("Respiración del globo"), "{turn:?}");
    assert_eq!(student.at(), "pausa");
    student.says("ya volví");
    assert_ne!(student.at(), "pausa");

    // In the theory, "sigue" moves on and a question does not.
    let mut student = in_screening();
    student.answers(true);
    for _ in 0..4 {
        student.answers(false);
    }
    assert_eq!(student.at(), "etapa1:2:teoria");
    let card = student.engine.card().unwrap().enunciado;
    let turn = student.says("¿y por qué se llaman equivalentes los dos?");
    assert!(turn.converse.is_some(), "{turn:?}");
    assert_eq!(student.engine.card().unwrap().enunciado, card);
    student.says("entendido, sigue");
    assert_ne!(student.engine.card().unwrap().enunciado, card);
}

#[test]
fn a_typed_answer_is_an_answer_and_nothing_else() {
    let mut student = in_practice();
    let at = student.at();
    // Not a number: the engine asks for it again, with no model and no hint.
    student.now += 1000;
    let turn = student.engine.said(student.now, "hola", None, true);
    assert!(said_by_tutor(&turn).contains("No te entendí la respuesta"), "{turn:?}");
    assert_eq!((student.at(), turn.converse), (at.clone(), None));
    // "Estoy cansado" in the answer box is not a request for a break.
    let turn = student.engine.said(student.now, "estoy cansado", None, true);
    assert_eq!((student.at(), turn.converse), (at, None));

    // The screening wants the explanation in its own box.
    let mut student = in_screening();
    let turn = student.engine.said(1000, "3/8", None, true);
    assert_eq!(said_by_tutor(&turn), ASK_HOW);
    let turn = student.engine.said(2000, "3/8", Some("el 8 es el total y el 3 las pintadas"), true);
    assert_eq!(student.at(), "tamizaje:2", "{turn:?}");

    // An explanation that was written is not asked for again, even a thin one.
    let mut student = in_screening();
    let turn = student.engine.said(1000, "3/8", Some("lo vi en el dibujo"), true);
    assert_ne!(said_by_tutor(&turn), ASK_HOW);
    assert_eq!(student.at(), "tamizaje:2", "{turn:?}");
}

#[test]
fn strange_input_does_not_break_the_engine() {
    let mut student = in_screening();
    // A number too long for exact fractions is not an answer: it is talk.
    for said in [
        "99999999999999999999/3",
        "9223372036854775807 9223372036854775807/9223372036854775807",
        "1/0",
        "////",
        "🙂🙂🙂",
        "tres octavos tres octavos tres octavos porque porque porque",
        "es es es son son da da igual",
    ] {
        let turn = student.says(said);
        assert!(!turn.closed, "{said}");
    }
    let mut student = in_practice();
    for said in ["99999999999999999999", "0/0 porque sí", "-3/-8", "1 1 1/2"] {
        student.says(said);
    }
    assert!(student.at().starts_with("etapa"));
    assert!(has_long_number("es 1234567") && !has_long_number("es 123456 y 3/8"));
}

#[test]
fn a_line_that_answers_the_students_own_words_is_marked() {
    // Whatever the student says in their own words reaches the engine as
    // text or chat. Lines that follow are marked, so the agent does not treat
    // them as fixed text; and the engine never repeats the words themselves.
    let marker = "zanahorias moradas";
    let mut student = Student::new(Goal::Explore);
    let mut marked = 0;
    for _ in 0..3 {
        for said in [format!("me gustan las {marker}"), format!("¿qué son las {marker}?")] {
            let turn = student.says(&said);
            for line in &turn.lines {
                assert!(!line.say.contains(marker), "{line:?}");
                marked += usize::from(line.echoes);
            }
            assert!(turn.converse.as_deref().is_none_or(|rules| !rules.contains(marker)));
        }
        student.answers(true);
    }
    assert!(marked > 0);
    // Lines for a graded answer, a hint or a break are the engine's own.
    let mut student = in_practice();
    for turn in [student.answers(false), student.says("no sé"), student.says("estoy cansado")] {
        assert!(turn.lines.iter().all(|line| !line.echoes), "{turn:?}");
    }
    // The report does not quote the student either, except a topic they asked for.
    assert!(!student.engine.report().unwrap_or_default().contains(marker));
}

#[test]
fn only_what_the_bank_covers_is_run_by_the_engine() {
    let objective = |kind: &str, subject: Value, topic: Value| json!({ "kind": kind, "subject": subject, "topic": topic, "due": "2026-11-19" });
    let due = NaiveDate::from_ymd_opt(2026, 11, 19);
    let math = json!("matematica");
    assert_eq!(
        goal(Some(&objective("homework", math.clone(), json!("Fracciones"))), "es"),
        Some((Goal::Homework, due))
    );
    assert_eq!(
        goal(Some(&objective("exam_prep", math.clone(), json!("suma de fracciones equivalentes"))), "es"),
        Some((Goal::ExamPrep, due))
    );
    // No subject: the topic decides.
    assert_eq!(
        goal(Some(&objective("explore", Value::Null, json!("fracción"))), "es"),
        Some((Goal::Explore, due))
    );
    // No date is fine: the engine asks the student for it.
    let undated = json!({ "kind": "homework", "subject": "matematica", "topic": "fracciones", "due": null });
    assert_eq!(goal(Some(&undated), "es"), Some((Goal::Homework, None)));

    for (objective, language) in [
        // An exam already sat needs the exam itself, which the platform does not have.
        (Some(objective("exam_review", math.clone(), json!("fracciones"))), "es"),
        (Some(objective("homework", math.clone(), json!("decimales"))), "es"),
        (Some(objective("homework", math.clone(), Value::Null)), "es"),
        (Some(objective("homework", json!("ciencia"), json!("fracciones de la luz"))), "es"),
        // The engine speaks Spanish only.
        (Some(objective("homework", math.clone(), json!("fracciones"))), "en"),
        (None, "es"),
    ] {
        assert_eq!(goal(objective.as_ref(), language), None, "{objective:?} {language}");
    }

    // Each kind starts the engine on its own path.
    for (kind, said) in [
        (Goal::Homework, "tu Tarea de Fracciones"),
        (Goal::ExamPrep, "prepararnos para tu Evaluación de Fracciones"),
        (Goal::Explore, "aprender algo nuevo de Fracciones"),
    ] {
        let opening = engine(kind).open(0, 0);
        assert!(said_by_tutor(&opening).contains(said), "{opening:?}");
    }
}

#[test]
fn the_opening_is_the_same_until_something_happens() {
    let mut engine = engine(Goal::Homework);
    let opening = engine.open(0, 0);
    assert_eq!(engine.unsaved(), [Record { at_ms: 0, input: Input::Start { homework: 0 } }]);
    engine.saved();
    // A tutor that asks again gets the same lines, and the engine is not started twice.
    assert_eq!(engine.open(5000, 0), opening);
    assert!(engine.unsaved().is_empty());

    // Later, a tutor that reconnects is told where the session is.
    engine.said(6000, "sí", None, false);
    engine.saved();
    let again = engine.open(9000, 0);
    assert_eq!(again.lines.len(), 1);
    assert_eq!(again.lines[0].say, engine.card().unwrap().enunciado);
    assert!(engine.unsaved().is_empty());
}

/// A session that starts from what an earlier one left.
fn next_session(goal: Goal, kept: Kept) -> Student {
    let mut setup = setup(goal);
    setup.start.kept = kept;
    Student::from(setup)
}

#[test]
fn a_student_who_was_screened_is_not_screened_again() {
    let mut first = in_screening();
    first.answers(true);
    first.answers(true);
    for _ in 0..3 {
        first.answers(false);
    }
    assert!(first.at().starts_with("etapa1:3"), "{}", first.at());
    first.says("me gustaría aprender de zanahorias moradas");
    let kept = first.engine.kept();
    assert_eq!(kept.levels.get("Fracciones"), Some(&2));
    assert_eq!(kept.sessions, 1);
    assert!(kept.unfinished_screenings.is_empty());

    // What is kept is levels and ids: no name, nothing the student said.
    let stored = serde_json::to_value(&kept).unwrap();
    let text = stored.to_string();
    for word in ["Mateo", "Ana", "fútbol", "zanahorias"] {
        assert!(!text.contains(word), "{word} is kept: {text}");
    }
    let fields: Vec<&str> = stored.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(
        fields,
        ["levels", "minutes_per_level", "sessions", "unfinished_screenings", "used_exercises"]
    );
    let kept: Kept = serde_json::from_value(stored).unwrap();

    // The next session goes straight to the level after the one reached.
    let mut second = next_session(Goal::Homework, kept.clone());
    let started = second.says("sí");
    assert_eq!(second.at(), "etapa1:3:teoria", "{}", said_by_tutor(&started));
    assert!(!said_by_tutor(&started).contains("Pregunta 1 de 5"));
    assert!(!said_by_tutor(&started).contains("Tamizaje"));
    assert_eq!(second.engine.kept().sessions, 2);

    // A session rebuilt from its inputs starts from the same profile.
    second.until("etapa2:3");
    second.answers(true);
    let mut setup = setup(Goal::Homework);
    setup.start.kept = kept;
    let rebuilt = Engine::replay(setup, bank().unwrap(), &second.records);
    assert_eq!(rebuilt.step(second.now), second.engine.step(second.now));
    // ...and not from nothing: without the profile the same inputs give another session.
    let blank = Engine::replay(self::setup(Goal::Homework), bank().unwrap(), &second.records);
    assert_ne!(blank.step(second.now), second.engine.step(second.now));
}

#[test]
fn a_screening_left_half_way_is_taken_up_where_it_stopped() {
    // The engine's rule (TAM-06): out with no wrong answer yet, the screening
    // goes on next time from the last level answered, with another question.
    let mut first = in_screening();
    first.answers(true);
    first.says("quiero salir del tamizaje");
    let kept = first.engine.kept();
    assert_eq!(kept.unfinished_screenings.len(), 1, "{kept:?}");

    let mut second = next_session(Goal::Homework, kept);
    let started = second.says("sí");
    let said = said_by_tutor(&started);
    assert!(said.contains("La vez pasada empezamos el Tamizaje"), "{said}");
    assert!(said.contains("Pregunta 1 de 5") && !said.contains("son 5 preguntas, de la más fácil"), "{said}");
    assert_ne!(second.engine.card().unwrap().id, Some("n1-t1".to_string()), "another question of that level");

    // Closed by the agent in the middle of the screening: the same.
    let mut cut = in_screening();
    cut.answers(true);
    cut.answers(true);
    let mut third = next_session(Goal::Homework, cut.engine.kept());
    assert!(said_by_tutor(&third.says("sí")).contains("Pregunta 3 de 5"));
}

#[test]
fn every_graded_exercise_is_evidence_for_the_learner_model() {
    // The screening: one answer each, right or not.
    let mut student = in_screening();
    student.answers(true);
    student.answers(false);
    student.says("no sé");
    student.says("¿qué significa simplificar?");
    student.answers(true);
    student.answers(true);
    let credits: Vec<(&str, f64)> =
        student.engine.outcomes().iter().map(|outcome| (outcome.exercise.as_str(), outcome.credit)).collect();
    assert_eq!(credits, [("n1-t1", 1.0), ("n2-t1", 0.0), ("n3-t1", 0.0), ("n4-t1", 1.0), ("n5-t1", 1.0)]);
    assert_eq!(student.engine.outcomes()[0].skill, Some("fracciones.concepto-numerador-y-denominador"));
    assert_eq!(student.engine.outcomes()[4].skill, Some("fracciones.fraccion-de-una-cantidad"));

    // Practice: full credit at the first try, half after a wrong answer or a hint.
    student.until("etapa2:2");
    let before = student.engine.outcomes().len();
    student.answers(true);
    student.answers(false);
    student.answers(true);
    student.says("dame una pista");
    student.answers(true);
    // An answer nobody could read is not an attempt.
    student.now += 1000;
    let unread = student.engine.said(student.now, "hola", None, true);
    student.keep(unread);
    student.answers(true);
    let practice: Vec<f64> =
        student.engine.outcomes()[before..].iter().map(|outcome| outcome.credit).collect();
    assert_eq!(practice, [1.0, 0.5, 0.5, 1.0]);
    assert!(student.engine.outcomes()[before..].iter().all(|outcome| outcome.skill.is_some()));
    assert!(student.engine.outcomes().iter().any(|outcome| outcome.choice));

    // Wrong through every hint and the worked example: the engine goes back
    // to the theory, and the exercise counts as not solved.
    let before = student.engine.outcomes().len();
    for _ in 0..12 {
        if student.at().starts_with("etapa1") {
            break;
        }
        student.answers(false);
    }
    assert!(student.at().starts_with("etapa1"), "{}", student.at());
    let failed: Vec<f64> = student.engine.outcomes()[before..].iter().map(|outcome| outcome.credit).collect();
    assert_eq!(failed, [0.0]);

    // A rebuilt engine has the same evidence, so it can be recorded from the stored inputs.
    let rebuilt = Engine::replay(setup(Goal::Homework), bank().unwrap(), &student.records);
    assert_eq!(rebuilt.outcomes(), student.engine.outcomes());
}

#[test]
fn every_exercise_of_the_bank_practises_a_skill_of_the_curriculum() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../curriculum/math-primaria.json");
    let catalog: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let known: Vec<&str> =
        catalog["skills"].as_array().unwrap().iter().map(|skill| skill["id"].as_str().unwrap()).collect();
    for (_, _, skill) in SKILLS {
        assert!(known.contains(&skill), "{skill} is not in the catalog");
    }
    let bank = bank().unwrap();
    let all: Vec<&Ejercicio> = bank
        .niveles
        .iter()
        .flat_map(|level| level.tamizaje.iter().chain(&level.ejercicios).chain(&level.simulacion))
        .chain(bank.tareas.iter().flat_map(|homework| &homework.ejercicios))
        .collect();
    assert!(all.len() > 80);
    let skill = |id: &str| {
        let exercise = all.iter().find(|exercise| exercise.id == id).unwrap_or_else(|| panic!("no {id}"));
        skill_of(exercise).unwrap()
    };
    for exercise in &all {
        assert!(skill_of(exercise).is_some_and(|skill| known.contains(&skill)), "{}", exercise.id);
    }
    for (id, expected) in [
        ("n1-e10", "fracciones.concepto-numerador-y-denominador"),
        ("n2-t2", "fracciones.comparar-distinto-denominador"),
        ("n2-e03", "fracciones.equivalentes-y-simplificar"),
        ("n2-e09", "fracciones.equivalentes-y-simplificar"),
        ("n3-t1", "fracciones.sumar-igual-denominador"),
        ("n3-e03", "fracciones.restar-igual-denominador"),
        ("n3-e04", "fracciones.numeros-mixtos-e-impropias"),
        ("n3-e08", "fracciones.numeros-mixtos-e-impropias"),
        ("n4-e03", "fracciones.sumar-distinto-denominador"),
        ("n4-e08", "fracciones.restar-distinto-denominador"),
        ("n5-e03", "fracciones.fraccion-de-una-cantidad"),
        ("n5-e06", "fracciones.problemas-con-fracciones"),
        ("n5-e09", "fracciones.problemas-con-fracciones"),
        ("tar-2", "fracciones.numeros-mixtos-e-impropias"),
        ("tar-4", "fracciones.restar-distinto-denominador"),
    ] {
        assert_eq!(skill(id), expected, "{id}");
    }
}

#[test]
fn time_acts_without_the_student_speaking() {
    // Before the session started, time does nothing and starts nothing.
    let mut idle = engine(Goal::Homework);
    assert_eq!(idle.pass(60_000), Turn { lines: Vec::new(), converse: None, closed: false });
    assert!(!idle.started() && idle.unsaved().is_empty());

    let mut student = in_practice();
    let exercise = student.engine.card().unwrap();
    let inputs = student.records.len();
    // A moment later: nothing to say, nothing stored.
    student.now += 5_000;
    let quiet = student.engine.pass(student.now);
    assert_eq!((quiet.lines.len(), quiet.converse.clone()), (0, None));
    assert!(student.engine.unsaved().is_empty());

    // Past the exercise's time: the engine's hint, with nobody having spoken.
    student.now += 10 * 60_000;
    let late = student.engine.pass(student.now);
    let late = student.keep(late);
    assert!(said_by_tutor(&late).contains("te está tomando un ratito"), "{late:?}");
    assert_eq!(late.converse, None);
    assert_eq!(student.records[inputs..], [Record { at_ms: student.now, input: Input::Tick }]);
    // It was not an answer: the same exercise, no attempt, and only one hint by time.
    assert_eq!(student.engine.card().unwrap().enunciado, exercise.enunciado);
    assert!(student.engine.outcomes().iter().all(|outcome| outcome.exercise != exercise.id.clone().unwrap()));
    student.now += 10 * 60_000;
    assert!(student.engine.pass(student.now).lines.is_empty());
    // The hint counts when the exercise is then solved.
    student.answers(true);
    assert_eq!(student.engine.outcomes().last().unwrap().credit, 0.5);

    // A break ends on its own, and the exercise is said again.
    student.says("estoy cansado");
    assert_eq!(student.at(), "pausa");
    student.now += 4 * 60_000;
    assert!(student.engine.pass(student.now).lines.is_empty(), "still in the break");
    student.now += 61_000;
    let back = student.engine.pass(student.now);
    let back = student.keep(back);
    assert!(said_by_tutor(&back).contains("seguimos"), "{back:?}");
    assert_eq!(back.lines.last().unwrap().say, student.engine.card().unwrap().enunciado);
    assert!(student.at().starts_with("etapa2"));
    let rebuilt = Engine::replay(setup(Goal::Homework), bank().unwrap(), &student.records);
    assert_eq!(rebuilt.step(student.now), student.engine.step(student.now));
}

/// A whole session of `minutes`, answered right at a steady pace: when it
/// closed, in minutes, how many breaks the engine gave, and whether the
/// homework was done.
fn length_and_breaks(minutes: u32) -> (u64, usize, bool) {
    let mut setup = setup(Goal::Homework);
    setup.start.minutes = minutes;
    let mut student = Student::from(setup);
    student.says("sí");
    student.answers(true);
    for _ in 0..4 {
        student.answers(false);
    }
    for _ in 0..600 {
        if student.engine.closed() {
            break;
        }
        student.answers(true);
    }
    assert!(student.engine.closed(), "{minutes}: still at {}", student.at());
    let breaks = student
        .turns
        .iter()
        .flat_map(|turn| &turn.lines)
        .filter(|line| line.say.starts_with("¡Pausa activa!"))
        .count();
    let done = student.engine.report().is_some_and(|report| report.contains("hemos hecho la tarea"));
    (student.now / 60_000, breaks, done)
}

#[test]
fn the_engines_session_is_as_long_as_the_platforms() {
    // Inside what the engine's rules allow: 30 minutes to an hour and a half.
    for (platform, engine) in [(1, 30), (20, 30), (30, 30), (45, 45), (60, 60), (90, 90), (120, 90)] {
        let settings = settings(platform);
        assert_eq!(settings.sesion_maxima_min, engine, "{platform}");
        assert!(settings.sesion_recomendada_min <= settings.sesion_maxima_min);
    }
    // A short session has no break and closes by itself before its time is
    // up (the engine does not start what it cannot finish); a 45-minute one
    // has the break at 30; a long one goes past that, with the break at 30,
    // until the homework is done. Getting three in a row right at the first
    // try ends a level's practice early, so this student is done before 60.
    let (length, breaks, _) = length_and_breaks(30);
    assert!(length <= 31 && breaks == 0, "{length} minutes, {breaks} breaks");
    let (length, breaks, _) = length_and_breaks(45);
    assert!((31..=46).contains(&length) && breaks == 1, "{length} minutes, {breaks} breaks");
    let (length, breaks, done) = length_and_breaks(90);
    assert!((47..=60).contains(&length) && breaks == 1 && done, "{length} minutes, {breaks} breaks, {done}");
}

/// The engine's lines while it waits for a photo of the homework.
const ASK_FOR_THE_PHOTO: &str = "Ahora quiero ver tu tarea, para saber qué practicar. Muéstramela a la cámara, y si no la tienes, dime «no tengo».";

/// A homework session whose tutor can read a photo of the homework, at the
/// end of a screening that leaves the student at level 1.
fn waiting_for_the_photo() -> Student {
    let mut student = Student::opened(setup(Goal::Homework), HOMEWORK_LEVEL);
    student.says("sí");
    student.answers(true);
    for _ in 0..4 {
        student.answers(false);
    }
    assert_eq!(student.at(), "pedir_tarea");
    student
}

#[test]
fn without_a_photo_the_session_goes_on_with_the_banks_homework() {
    let mut student = waiting_for_the_photo();
    assert_eq!(student.records[0].input, Input::Start { homework: 1 });
    assert_eq!(
        serde_json::to_value(&student.records[0].input).unwrap(),
        json!({ "kind": "start", "homework": 1 })
    );
    // The screening closes without the plan: the homework's level comes first.
    let said = said_by_tutor(student.turns.last().unwrap());
    let expected = format!("¡Terminamos el calentamiento! Gracias por pensar conmigo. | {ASK_FOR_THE_PHOTO}");
    assert!(said.ends_with(&expected), "{said}");
    assert!(!said.contains("He analizado"), "{said}");

    let none = student.says("no tengo");
    let said = said_by_tutor(&none);
    let expected = "¡No pasa nada! | Vamos a practicar con ejercicios míos, como los de una tarea de fracciones. | \
                    He analizado cómo te fue en los ejercicios, y antes de que hagamos la tarea, te voy a ayudar a \
                    reforzar las fracciones equivalentes, las sumas y restas con el mismo denominador y las sumas \
                    y restas con distinto denominador.";
    assert!(said.starts_with(expected), "{said}");
    assert_eq!(none.converse, None);
    assert_eq!(student.at(), "etapa1:2:teoria");

    // Rebuilt from its inputs, the same session: the capability is one of them.
    let rebuilt = Engine::replay(setup(Goal::Homework), bank().unwrap(), &student.records);
    assert_eq!(rebuilt.step(student.now), student.engine.step(student.now));
}

#[test]
fn a_tutor_that_cannot_read_a_photo_gets_the_session_as_before() {
    let mut student = Student::new(Goal::Homework);
    assert_eq!(serde_json::to_value(&student.records[0].input).unwrap(), json!({ "kind": "start" }));
    // An input stored before the capability existed reads as none.
    assert_eq!(
        serde_json::from_value::<Input>(json!({ "kind": "start" })).unwrap(),
        Input::Start { homework: 0 }
    );
    student.says("sí");
    student.answers(true);
    for _ in 0..4 {
        student.answers(false);
    }
    assert_eq!(student.at(), "etapa1:2:teoria");
    assert!(!student.turns.iter().flat_map(|turn| &turn.lines).any(|line| line.say.contains("a la cámara")));
}
