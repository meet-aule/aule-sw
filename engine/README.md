# The session engine

What decides a tutoring session: which stage the student is in, which exercise
comes next, when a hint is due and when the session ends. It is a state machine
with no input or output of its own and no language model. A model only words
what the engine decided, judges an answer when asked and reads a photo of a
notebook. **The model never decides the course of a session.**

It was written for Aule's first web demo and brought here so that the tutor,
the platform and the playground follow the same rules. Its lines are said out
loud by the tutor, so none asks the student to type or press a button. Changes
to the rules of the demo are marked `[PROPUESTA]` in the code.

| Path | What |
|---|---|
| `crates/aule-core` | The engine (`motor.rs`), the model of a session, checking of answers, the report for the family. No IO |
| `crates/contenido` | The bank of exercises for fractions (5th grade, five levels) as TOML in `data/`, and the drawings as SVG |
| `docs/spec-demo-web.md` | The rules, each with an id (`TAM-02`, `E2-03`, `PIS-01`...). The code cites the id of the rule it implements |

## The course of a session

Objective of the session → **Tamizaje** (five questions, one per level, no hints)
→ for each level up to the target: **Etapa 1: Descubrimiento** (theory, worked
and assisted examples, the student explains it back) then **Etapa 2: Refuerzo**
(up to five exercises on their own, ending early once three in a row are right
at the first try; hints, then a step-by-step of a similar exercise)
→ the **Tarea**, the simulation of an evaluation or its correction → the report.

With the setting `foto_tarea` on, a homework objective whose level nobody
loaded asks to see the homework at the camera once the student's level is
known, and the level read in the photo, outside the engine, becomes the
target. Without a photo the bank's homework is used, as before (TAR-05 to
TAR-07).

Where the engine asks something whose answers it knows, the message that asks
carries them (`Mensaje::opciones`, from `Motor::opciones`) for a screen to show
as buttons: «Sí» to «¿Empezamos?», the four activities of a break, «No tengo mi
tarea» whenever it asks for the homework's photo, «Sí, fracciones» to the topic
it proposes and «Sí» and «No» to «¿te parece si seguimos aprendiendo…?».
Tapping one is saying it: its words come back as `Entrada::Texto`. Only answers
the engine follows are offered, so «¿Empezamos?» has no «No», which would start
the session all the same. An exercise's options are on its card.

## Language

The code, its comments and its rules are in Spanish, unlike the rest of this
repository. The vocabulary is part of the specification (Alumno, Tamizaje,
Nivel objetivo, Pistas...) and is used as written.

Instructions addressed to the model (`ContextoChat::reglas`) are authored in
English. Stage labels, exercise statements and fixed spoken lines remain in their
original language; the voice tutor applies its final output-language instruction.

## Running the tests

```bash
cd engine
cargo test --locked
```

## Measuring whole sessions

`crates/contenido/examples/medir.rs` runs whole sessions with scripted
students (one who gets everything right, one who fails half or all, one who
does not explain, one who gets tired, one who asks questions, one who asks for
help), an hour long as on the platform, and prints per student: whether the
session ended, turns and minutes, words the tutor says per turn of the
student, and lines that do not fit a spoken session (typing, buttons,
WhatsApp, a date nobody gave), or that repeat.

```bash
cd engine
cargo run --release -p contenido --example medir             # the table
cargo run --release -p contenido --example medir -- --lineas # and the lines it flags
VER="falla todo" cargo run --release -p contenido --example medir  # one student's session
```

The names in the bank and the tests are made up.
