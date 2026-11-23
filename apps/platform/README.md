# Platform

What Aule knows and decides outside the conversation: children and what their guardians consented to, sessions, the learner model, memory and the supervisor. One Rust crate, two processes:

```bash
aule-platform serve     # the API
aule-platform worker    # session reviews, retention, housekeeping
aule-platform migrate   # only bring the database up to date
aule-platform import-skills curriculum/math-primaria.json
```

`serve` and `worker` migrate on start, so either is enough for an empty database. [ARCHITECTURE.md](../../ARCHITECTURE.md) explains how the pieces think together.

## Modules

| Module | What it does |
|---|---|
| `learning` | The skill model (`skill_model`, pure), the history it is replayed from, calibrated question difficulty, the candidates for the next session |
| `memory` | Statements about a child with pgvector embeddings; recall by meaning, or by date without an embedding model |
| `supervisor` | The brief before a session, guidance during it, the review after it |
| `families`, `signin` | Families, guardians, children, append-only consent; sign-in by emailed code |
| `devices` | Registration, claim codes, signed check-in and sessions, firmware |
| `events`, `notices`, `push` | The outbox and its delivery; what families are told; pushes through Firebase Cloud Messaging |
| `sessions` | Room tokens, the agent's API for one session, the review job |
| `engine` | A session run by the session engine (`engine/`): what the student said becomes the engine's inputs, what the engine answers becomes lines for the tutor and steps for the page |
| `jobs` | The Postgres job queue and the housekeeping |
| `llm`, `livekit`, `mail`, `auth`, `config`, `error` | Claude with a forced structured answer, room tokens, the two kinds of caller, settings, the error shape |

## API

`AULE_FREE_ACCESS=1` temporarily lets signed-in families start sessions without
plan quotas or trial expiry. Set it on the platform and playground together.
The page shows free unlimited access and bypasses its own daily session cap.
Usage is still measured; existing subscriptions and trial history are not
rewritten. Setting it back to `0` (the default) restores the usual plans.
Authentication, consent, family isolation, staff permissions, safety gates and
each session's duration limit still apply.

Three kinds of caller use `Authorization: Bearer ...`:

- the **operator**, with `AULE_ADMIN_TOKEN`, for running the server;
- a **guardian**, with the token they get by signing in, who reaches only their own family;
- the **agent**, with the token of one session.

Devices do not use a bearer token: they sign with the key burned into them.

### Sign-in and account (guardian)

| Route | What it does |
|---|---|
| `POST /v1/auth/start` | Sends a six-digit code to an email address. Answers the same whether or not the address has an account |
| `POST /v1/auth/verify` | Trades the code for a token. A new address becomes a new family and must send `name` |
| `GET /v1/auth/google` | The Google client an app must ask credentials for. 503 when Google sign-in is not set up |
| `POST /v1/auth/google` | Trades a Google ID token (`credential`) for a token. Same account as the emailed code for that address; a new address becomes a new family, named from the Google account unless `name` is sent |
| `POST /v1/auth/signout` | Ends this session |
| `GET`, `PUT /v1/me` | The guardian, their children, unread notices; language and whether notices are emailed or pushed |
| `DELETE /v1/me` | Erases the family and everything derived from it. Needs the email typed again |
| `GET /v1/notices`, `POST /v1/notices/{id}/read` | What the family has been told |
| `PUT`, `DELETE /v1/push/tokens` | The app registers this phone for pushes each time it starts, and forgets it on sign-out. Body: `{"token", "platform"}` with `android`, `ios` or `web` |

### Children and learning (guardian for their family, or operator)

| Route | What it does |
|---|---|
| `POST /v1/families/{id}/children` | A child's profile. `grade` is `P1` to `P6` or `S1` to `S5` |
| `GET`, `PUT`, `DELETE /v1/children/{id}` | Read, replace or erase a child and everything derived from them. `tutor_name` (1 to 20 letters, default `Aule`), `tutor_persona` (`calido`, `jugueton`, `aventurero` or `tranquilo`) and `tutor_persona_note` (one line, up to 200 characters; empty removes it) say how the tutor presents itself, and keep their value when left out. `subjects` are the school subjects the family wants reinforced, from the list `GET /v1/me` returns; left out of a `PUT`, they keep their value. `relationship` is what the signed-in guardian is to the child (see [People, as FHIR R4](#people-as-fhir-r4)); it keeps its value when left out, an empty text removes it, and `GET` returns the caller's own (`null` when not stated, or for the operator) |
| `POST /v1/children/{id}/consents` | Grant or take back `voice`, `transcripts` or `memory` |
| `GET /v1/children/{id}/skills` | What the child knows now, and what the model would work on next |
| `POST /v1/children/{id}/attempts` | Answers reported by a guardian (the operator can also import past records) |
| `POST /v1/children/{id}/corrections` | "They already know this": override a skill |
| `GET /v1/children/{id}/memories?query=` | What is remembered, closest to the query first |
| `DELETE /v1/children/{id}/memories/{memory_id}` | Forget one thing |
| `GET /v1/children/{id}/reviews` | Notes from past sessions |
| `POST /v1/sessions` | A session and its room token. A guardian can only start a child's session. Optional `objective`: what the family says the session is for, `{kind: homework, exam_prep, exam_review or explore, subject (one of the subjects, or other), topic (up to 200 characters), due (a date)}`; the supervisor plans for it first. Optional `engine: true` asks for the [session engine](#sessions-run-by-the-session-engine) to run the session; the response's `engine` says whether it does |
| `GET /v1/sessions/{id}/step` | Where a session the engine runs is, for the student's screen. 409 when the engine does not run the session or it has ended |
| `POST /v1/sessions/{id}/answers` | An answer typed on that screen: `{"answer", "explanation"?}`. Returns the new step; the tutor collects what to say about it with its next report of turns |
| `GET /v1/skills` | The skill catalog |

### Devices

| Route | Caller | What it does |
|---|---|---|
| `POST /v1/devices` | operator | Registers devices as they are made: serial, HMAC key, model |
| `POST /v1/firmware` | operator | Publishes a firmware version for a model. A version is never replaced |
| `GET /v1/devices` | guardian, operator | The family's devices |
| `POST /v1/devices/claim` | guardian | Links the device that shows this code, optionally to a child |
| `PUT`, `DELETE /v1/devices/{id}` | guardian, operator | Choose the child who uses it; unlink it |
| `POST /ota/` | device | Check-in: the time, newer firmware if there is any, and the code to show while it is not linked |
| `POST /ota/activate` | device | Signs the challenge that came with the code. 200 once linked, 202 while waiting for a guardian |
| `POST /ota/session` | device | Starts a session for its child. Signed with a fresh timestamp; each signature works once |

`/ota/` and `/ota/activate` follow the check-in and activation protocol of xiaozhi-esp32. `/ota/session` is Aule's own: the body is `{"serial_number", "timestamp", "hmac"}`, where `hmac` is HMAC-SHA256 of `session:<serial>:<timestamp>` under the device's key, in hex.

### Reconnecting to a session

Rooms issued for the web and devices stay open for up to 120 seconds after the
last non-agent participant disconnects. A client should retry with the same
room, participant identity and still-valid token. It must not call the session
creation endpoint on every network retry: that creates another session. A
successful rejoin while the room and tutor remain running preserves their
state and uses the existing session's allowance. The session's normal time
limit, consent checks and explicit end still apply.

This grace period covers short transport interruptions, not a device reboot,
an expired token or a crashed tutor. The firmware's LiveKit transport and
recovery still need implementation and tests on a board; the signed device
route alone does not prove that a device can reconnect. Clients should show
that they are reconnecting, retry with bounded backoff, and preserve the
physical microphone switch. Do not replay buffered speech after reconnecting.

### Operator only

| Route | What it does |
|---|---|
| `POST /v1/families` | A family and its first guardian, without sign-in |
| `PUT /v1/skills` | Loads skills into the catalog (`aule-platform import-skills <file>` does the same from a file) |
| `GET /v1/sessions/{id}/supervisor` | The plan and guidance of one session and, once it has been reviewed, `review`: the summary and next step written for the family, and `exercises`: each checked exercise with its answer, tries, hints and outcome |
| `GET /v1/metrics/daily?days=14` | One object per day, newest first: sessions (started, never started, under a minute, median length, seconds to start), how the talk was shared, exercises (posed, not checkable, correct, failed, first-try rate, hints, and how many had their answer said by the tutor while still open), turns stopped by each safety gate, sessions warned and closed for not working, what the agent measured, what reached the family, and `cost_usd`: what the day's sessions cost by service (the tutor's model, speech to text, the voice, the platform's own model calls), in total and per hour of session, from the measured usage and the dated list prices in `metrics.rs`. Counts, rates, durations and dollars only |

### Agent

| Route | What it does |
|---|---|
| `GET /v1/agent/session` | Marks the session as running; returns the student's profile as `instructions`, with the plan when it is already written, `student_name` and `session_number` (how many sessions the student had started before this one) for written lines, and `tutor` (`name`, `persona`, `note`): how the tutor presents itself to this child. The same three travel in the dispatch metadata as `tutor_name`, `tutor_persona`, `tutor_persona_note`. In a session the engine runs it also starts the engine and returns `script`: its opening lines |
| `POST /v1/agent/session/turns` | Reports turns; returns guidance written since the last call, and `plan` (text for the tutor, or null) when the plan was finished after the tutor started. `stop` is `"warn"` after 2 turns in a row in which the student is plainly not working, `"end"` after 4: the tutor says a fixed line for each, once, and on `"end"` closes the session with `end_reason: "not_working"`. The family gets a notice when the close is asked for. `pause` is `"offer"` when a break is due: `AULE_BREAK_EVERY_MINUTES` of work have passed (default 30) or the supervisor read tiredness, no exercise is open and more than 10 minutes remain; the request's optional `breaks_taken` tells the platform a break happened, and an offer not taken in 2 minutes counts as declined. In a session the engine runs, `guidance` stays empty, `pause` stays null (the engine gives its own breaks), and `script` is present when an answer was typed on the page since the last report |
| `POST /v1/agent/session/said` | Only in a session the engine runs: what the student said, and what the tutor does next. See [below](#sessions-run-by-the-session-engine) |
| `POST /v1/agent/session/flags` | Reports that a safety gate stopped a turn: the gate, what it did, fixed categories |
| `POST /v1/agent/session/exercises` | The tutor states the exercise it is about to ask, as arithmetic (`expression`: `"3/4 + 1/8"`, optional `skill_id` and `form`: `any`, `simplified` or `mixed`) or as secondary-school algebra: an equation in one unknown of the first or second degree (`"2x + 3 = 11"`), two linear equations (`"x + y = 10; x - y = 2"`), a polynomial to expand (`"(x + 2)(x - 3)"`) or, when it is already expanded, to factor (`"x^2 - 5x + 6"`), or a value (`"3x^2 - 1 para x = 2"`). The platform works out the answer exactly and keeps it; the response says whether this one is to find out what the student can do (`probe`) and what to do (`say`). 400 when it is nothing it can check, such as an irrational root. 409 in a session the engine runs, as is the next route: the engine poses and checks its own exercises |
| `POST /v1/agent/session/answers` | What the student answered (`said`, their words). Returns `verdict` (`correct`, `wrong_form`, `incorrect`, `dont_know`, `unreadable`, or `not_an_answer` when the words are about another calculation or a question of the student's own, which counts as no try), the number that was `read`, a named `misconception` when the mistake is a known one, and what to do next (`stage`, `next`, `say`). `reveal` carries the answer only once the exercise is closed and has to be worked out together |
| `POST /v1/agent/session/end` | Closes the session and queues its review. `metrics` (optional) is what the agent measured: an object of short names and numbers, such as `first_word_ms`; anything else in it is dropped |

Errors are `{"error": {"code": "...", "message": "..."}}`.

## People, as FHIR R4

The tables that hold people follow FHIR R4's resources, so an export can be
written without changing them. Nothing is served as FHIR yet.

| Table | FHIR R4 | How |
|---|---|---|
| `families` | `Group` (`type: person`, `actual: true`) | Its members are the family's children. Siblings are children of the same family; they are not stored as a relationship |
| `children` | `Patient` | `nickname` is `name.text`, `birth_year` is `birthDate` (a year alone is a valid FHIR date), `language` is `communication.language` |
| `guardians` | `RelatedPerson`, one per child | `name`, and `email` as `telecom` with `system: email`; `patient` is the child |
| `guardian_children` | `RelatedPerson.relationship` | A code of `http://terminology.hl7.org/CodeSystem/v3-RoleCode`: `MTH`, `FTH`, `STPMTH`, `STPFTH`, `GRMTH`, `GRFTH`, `AUNT`, `UNCLE`, `SIB`, `GUARD` or `FAMMEMB`. No row: the guardian has not said. Who may see a child does not depend on it |
| `consent_records` | `Consent` | One per purpose and answer; `granted` is `provision.type` `permit` or `deny` |
| `devices` | `Device` | |

A teacher or a tutor outside the family would be a `Practitioner` with a
`PractitionerRole`; there is none yet. The tutor's memory keeps nothing about
the people in a child's life.

## Events

Events are written to an outbox in the same transaction as the change they describe and delivered by the worker, at least once. Their shape is fixed by [`contracts/`](../../contracts/README.md), and the tests check every event the platform writes against those schemas.

| Event | When |
|---|---|
| `device.claimed.v1` | A family linked a device |
| `session.ended.v1` | A child's session on a device ended |
| `safety.flagged.v1` | A safety gate stopped a turn in a child's session |
| `session.reviewed.v1` | The supervisor finished reviewing a child's session |

The platform consumes its own events to write notices: a summary after each reviewed session, and one short, fixed-text note per session when a gate that listens to the child answered with support or asked for an adult. A new notice is also emailed and announced with a push. The push carries fixed text and the notice's id, never the child's name or what happened, because a locked phone shows it to whoever holds it.

With `AULE_EVENTS_WEBHOOK_URL` set, each event is also posted there as a CloudEvent with `X-Aule-Signature: sha256=<HMAC of the body>`.

## Settings

`.env.example` at the repository root lists them. Only `DATABASE_URL` and `AULE_ADMIN_TOKEN` are required: without LiveKit keys no session can be created, without mail settings nobody can sign in and notices stay in the app, without a Firebase service account there are no pushes, without `ANTHROPIC_API_KEY` plans come from the learner model alone and there is no guidance or review, and without `AULE_EMBEDDINGS_URL` memories are recalled by date.

The embedding model must return 1024 dimensions (`bge-m3` does). Another size needs a migration.

## Develop

Use Rust 1.94 or newer (required by SQLx 0.9) and PostgreSQL 17 with pgvector.

```bash
cargo fmt --check && cargo clippy --all-targets -- -D warnings
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres cargo test
```

The tests in `tests/api.rs` run the API against a real Postgres with pgvector, each in its own temporary database, with scripted stand-ins for the language model and the embedding model.

### Changing the schema

The code reads and writes the database through SeaORM entities in `src/entity/`.
To add a table or a column, change its entity, then write the migration from it:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres cargo run --example migration -- add_something
```

It runs the migrations in a throwaway database, lets SeaORM add what the
entities have and the migrations do not, and writes those statements as the
next file in `migrations/`. `tests/schema.rs` fails while an entity has
something no migration creates, and prints the statements.

Read the file before committing it. It only adds tables, columns, unique keys
and foreign keys; a changed type, a rename, a removal or a check constraint is
written by hand, and a required column on a table that has rows needs a default.
When an entity leaves out a unique key the table has, the sync would drop it:
the command then writes nothing and the test fails, both naming it, and the fix
is `#[sea_orm(unique)]` on the entity.
The server only runs the files in `migrations/` (never a schema sync), and a
file already applied is never edited.

`migrations/0017_baseline.sql` is the whole schema as 0001 to 0016 left it;
those files are gone. At start, `migrate` (in `src/lib.rs`) marks a database
that ran 0001 to 0016 as having run the baseline, under one lock for the API
and the worker, and refuses one older than that (`infra/server/RESTORE.md`
says how to restore such a backup).

Not every table has an entity yet: the modules move to SeaORM one at a time.

To refit the learner model's parameters from a log of answers:

```bash
cargo run --release --example skill_model_eval -- answers.tsv
```

## Checked exercises

The tutor does not decide whether an answer is right, and while an exercise is open it does not know the answer. It states the exercise as arithmetic; [`exercise.rs`](src/exercise.rs) works it out with exact fractions and reads what the student said ("siete octavos", "7/8", "0,875", "uno y medio"). A wrong answer that matches a known mistake gets its name (adding tops and bottoms, keeping one denominator, the opposite operation, upside down).

[`practice.rs`](src/practice.rs) holds the rules for what happens next, adapted from the rule engine of the earlier text demo:

1. **Find out first.** The first two exercises on a skill get no hints and no "right" or "wrong". Both right: the skill is known, move on.
2. **Teach, then practise.** Otherwise the tutor teaches with a worked example and asks the student to explain it back.
3. **Help that grows.** A wrong answer in practice gets a hint aimed at the mistake, a second one, then a worked example with other numbers. The exercise stays the same. The right amount in the wrong form costs no hint. "No sé" gets the next hint without counting as a wrong answer. Stating the open exercise again keeps its tries and hints.
4. **Stuck is allowed.** After that the exercise is worked out together (only then is the answer given to the tutor), the idea is taught again and practice starts over.
5. **Enough is enough.** Three exercises solved in a row, each from a different angle, and the skill is done for the session.

Each closed exercise on a skill of the curriculum is recorded for the learner model: full credit when solved at the first try, half when it needed hints, none when it had to be worked out together. The review does not add its own reading for those skills.

What it does not check: anything that is not arithmetic on whole numbers, fractions and decimals (comparisons, word problems that are not reduced to an operation, geometry). The tutor carries on unchecked for those.

## Sessions run by the session engine

The session engine in [`engine/`](../../engine/README.md) decides a whole session without a model: a screening, then for each level a discovery stage and practice, then the homework or a simulated exam, and the report for the family. [`engine`](src/engine/mod.rs) runs it for a session, and the tutor says what it decides.

The engine runs a session only when all of this holds; otherwise the session is created as always and `engine` is `false`:

- the request sent `engine: true`;
- the session has a child and its language is Spanish (the engine's texts exist in Spanish only);
- the objective is one the compiled-in bank covers. Today that is fractions in mathematics: `subject` is `matematica` or left out, and `topic` names fractions ("Fracciones", "suma de fracciones").

| The objective's `kind` | The engine's objective (`TipoObjetivo`) |
|---|---|
| `homework` | `Tarea`, with `due` as its date. The exercises are the bank's own homework, not the student's |
| `exam_prep` | `Preparacion`, with `due` as the date of the exam: the engine simulates it |
| `explore` | none: the engine's `Extracurricular`, with the topic as the family's suggestion |
| `exam_review` | not run by the engine: its `Correccion` needs the exam the student sat (the questions they missed, what they answered), which the platform does not have |

The child becomes the engine's profile (`Perfil`): the nickname is the student's name, the interests choose the setting of the exercises, and the family's first guardian is who the report greets. The day is the session's own, in the server's timezone setting.

### What the agent gets

A line is `{"say", "show", "reword", "echoes"}`:

- `say` is the engine's text, word for word.
- `show` is a visual of [`contracts/visuals`](../../contracts/README.md), or `null`. Each drawing of the engine is translated to the closest kind (bars, circles, counters, a table for the activities of a break, the statement as an `exercise`); one with no faithful kind, such as a number line cut into fractions, is not approximated. A bar or a circle the engine draws without a label is sent with `labelled: false`, because a screen would otherwise write the fraction next to it, and that is often the answer.
- `reword` is true when the engine would have a model word the line; `say` is then its scripted fallback.
- `echoes` is true for lines that answer something the student said in their own words (text and conversation, as opposed to a graded answer, a hint or a break). The engine does not repeat those words today, but the agent should not treat such a line as fixed text.

The platform adds lines the engine only puts on a page: the statement of each new exercise (with its drawing), and the statement and steps of a worked example.

`GET /v1/agent/session` returns `"script": {"lines": [...], "closed": false}` with the opening. Asked again before anything was said it returns the same opening; later, a line with what is on the screen.

`POST /v1/agent/session/said` takes `{"said": "...", "explanation": "..."}` (`explanation` only when the caller can tell it apart; both up to 500 characters) and returns:

```json
{ "lines": [{ "say": "...", "show": null, "reword": false, "echoes": false }], "converse": null, "closed": false }
```

- `converse` is `null` when the lines are the whole turn. Otherwise it is the engine's rules for this moment, in Spanish, and the tutor's model answers in its own words after saying the lines: what is on the screen, and what it may not do (in the screening: no help, and never whether an answer is right).
- `closed` is true once the engine has finished the session; the lines are then its goodbye. The agent closes the session as always.
- An empty `said` means that only time has passed: the engine's clock is applied and any line that is due comes back (a hint for an exercise that is taking long, the end of a break, the warning before the last exercises), with `converse: null`. It is never an answer and it stores nothing when nothing was due. The agent may call it on a timer; a line due while nobody speaks is otherwise said with the next thing the student says.
- 409 when the session has ended or the engine does not run it. Reported before the opening was asked for, it returns the opening and does not read what was said.

`POST /v1/agent/session/turns` keeps working: turns are stored and reviewed, and `stop` is decided as before. `pause` is always null: breaks are the engine's, at 30 and 60 minutes of a session long enough to have them and when the student says they are tired, and they arrive as lines. The supervisor still reads the session, but its advice is not written, since the engine decides what the tutor does next. When an answer was typed on the page, the answer to the next report carries `"script": {"lines": [...], "closed": bool}`, once.

### How what the student says is read

Spoken words arrive as one text, and no model reads them:

1. "Estoy cansado" starts the engine's break, and asking to leave the screening leaves it.
2. When an answer is awaited and the text holds one, it is graded with the engine's own checker (value and form). The answer is the number said before "porque" or the end of the first sentence, when there is one there; the whole text is the explanation, checked with the engine's key words. Where an explanation is required and missing, the answer is held and the student is asked once how they worked it out.
3. "No sé" is a wrong answer where there are no hints (the screening, the simulated exam) and a request for a hint elsewhere. "No entiendo" in the screening is a question, not an answer.
4. In the guided moments (a date, "¿empezamos?", the theory) text that moves the session on goes to the engine as text.
5. Anything else is conversation: the engine is told its intent, from its own deterministic classifier, and `converse` is returned. Asking for help or for the answer gets the engine's hints, or its fixed line where there are none; asking to hear the exercise again gets its statement.

An answer typed on the page is only ever an answer: rules 1 and 5 do not apply to it.

### The page

`GET /v1/sessions/{id}/step`, for the operator or a guardian of the child:

```json
{
  "stage": "Tamizaje",
  "progress": "Pregunta 1 de 5",
  "route": [{ "name": "Tamizaje", "detail": "5 preguntas", "state": "current" }],
  "card": {
    "mode": "tamizaje", "title": "...", "statement": "...", "visual": null, "options": [],
    "asks_answer": true, "asks_explanation": true, "is_exercise": true,
    "note": "...", "hints_allowed": false, "format_help": "..."
  },
  "elapsed_seconds": 95,
  "closed": false
}
```

`state` is `done`, `current` or `pending`; `card` is `null` between exercises. The step never carries the expected answer, the key words of an explanation or its criteria: it is built field by field from what the engine shows a student.

### What is stored, and for how long

The engine keeps its state in memory and cannot be serialized, so a session is stored as the inputs that went into it (`session_engine_inputs`), in order, each with the engine's clock when it was applied. Applying them again rebuilds the same engine: after a restart, in the worker, or in another process. The engine's clock is set by the platform from the time since the session's first input; before each input the time that passed is applied, so a hint for an exercise that takes long, the end of a break and the warning before the last exercises happen on time.

The inputs hold what the student said, so they follow the rule of the transcript: deleted after the review unless the guardian agreed to keep transcripts, then when a kept transcript expires, and when that consent is taken back. They are never logged.

### One session length

The engine's session is as long as the platform's (`AULE_SESSION_MINUTES`), inside the engine's own rule of 30 minutes to an hour and a half: 20 becomes 30, 120 becomes 90. The length is fixed when the session is created. The engine closes at that time, warns a few exercises before, and does not start a level it cannot finish, so a short session ends early. With the default of 20 minutes the room closes before the engine's 30: an engine session wants `AULE_SESSION_MINUTES` of 30 or more.

### What is kept between sessions, and what the learner model gets

When a session the engine ran is reviewed, three things are written from its stored inputs:

- **The child's engine profile** (`children.engine_profile`): the level reached in each topic, a screening left half way, the minutes each level took and the ids of the exercises already used. Levels and ids only: no name, and nothing the student said (a topic they asked for stays out). The next engine session of that child starts from it, as it was when the session was created. The engine then follows its own rules: a topic with a known level is not screened again, and a screening left half way is taken up at the last level answered with another question. It is erased with the child.
- **An attempt per graded exercise** in the learner model, with source `engine`, the exercise's id as `question_id`, and credit 1 when solved at the first try without help, 0.5 after a wrong answer or a hint, 0 when the engine gave up on it. A screening or simulated-exam question is one answer: 1 or 0. The supervisor's review adds no reading of its own for those skills.
- The report, below.

Each exercise is recorded under a skill of `curriculum/math-primaria.json`. The engine's levels are wider than the catalog's skills, so the exercise's own arithmetic chooses within the level:

| Level | Exercise | Skill |
|---|---|---|
| 1 | any | `fracciones.concepto-numerador-y-denominador` |
| 2 | a comparison with `<`, `>`, `=` | `fracciones.comparar-distinto-denominador` |
| 2 | anything else | `fracciones.equivalentes-y-simplificar` |
| 3 | two fractions added / subtracted | `fracciones.sumar-igual-denominador` / `fracciones.restar-igual-denominador` |
| 3 | anything else | `fracciones.numeros-mixtos-e-impropias` |
| 4 | two fractions added / subtracted | `fracciones.sumar-distinto-denominador` / `fracciones.restar-distinto-denominador` |
| 5 | a fraction of an amount, alone | `fracciones.fraccion-de-una-cantidad` |
| 5 | anything else | `fracciones.problemas-con-fracciones` |

Only skills present in the platform's catalog are recorded.

When the session is reviewed, the family's summary (`session_reviews.guardian_summary`, and the notice made from it) is the engine's report, word for word. The supervisor's review still records its next step and flags, not its own summary. A session that ended before anything happened has no engine report and is summarized by the supervisor as before.
