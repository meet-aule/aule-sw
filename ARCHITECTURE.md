# Architecture

Aule's server is a platform that knows each child's learning, a voice agent that holds the conversation, and versioned events between them and the outside. This document is the plan the code follows. Not all of it is built; the [status](#status) section says what is.

## Components

```text
                                aule-sw
              ┌───────────────────────────────────────────────────┐
  family app  │ platform (Rust)   families · consent · sessions   │
 ───────────▶ │   serve           learning · memory · supervisor  │
  playground  │   worker          reviews, retention, housekeeping│
 ───────────▶ │                   Postgres + pgvector             │
  console     │                                                   │
 ───────────▶ │                   Staff routes, for the team      │
              └───────▲──────────────────────────┬────────────────┘
        plan, turns,  │                          │ room tokens
        guidance      │                          ▼
              ┌───────┴─────────┐
              │ agent (Python)  │ ◀──────── LiveKit ◀──────── Aule device
              │ LiveKit Agents  │
              └─────────────────┘
```

| Component | Language | Owns |
|---|---|---|
| `apps/platform` | Rust | The API, the database, the learner model, memory, the supervisor, and the worker process that runs jobs |
| `apps/agent` | Python | The conversation: speech, the tutor, the safety gates |
| `apps/playground` | Node, TypeScript | A page for the people running a server to talk to the tutor |
| `apps/admin` | Node, TypeScript | The team's console at admin.meetaule.com: its own sign-in for the team's addresses, and the families, the numbers, the plans and who is in a session now, read through the platform's Staff routes |
| `contracts/` | JSON Schema | The events they exchange |

The platform is one crate that runs as two processes, `serve` (the API) and `worker` (jobs). It is a modular monolith, not a set of microservices: a module reads and writes only its own tables and talks to the others through their public functions.

A store (checkout, subscriptions, invoices) is not part of this repository. It talks to the platform only through events such as `order.paid`, so you can run Aule without one.

## How a session thinks

Three things decide what happens in a session, and only one of them is in the conversation.

**The learner model** (`learning`) estimates, without a language model, the chance that a child answers a question on a skill correctly: a global ability, an offset per skill, a practice term, the difficulty of the question and forgetting over time. It is a pure function of the child's history of answers, so correcting an answer and reading again recomputes everything, and a guardian or teacher can override a skill directly. The same signal that moves the child moves the difficulty of the question, so difficulty calibrates itself as children answer. From this the model offers candidates for the next session: reviews that are due, skills in progress, and new skills whose prerequisites are mastered.

**Memory** (`memory`) is what the tutor knows about a child between sessions: short statements derived from a session, never the transcript, stored with an embedding in pgvector. The embedding model is any OpenAI-compatible endpoint; the compose file runs one locally, so a child's memories do not leave the server to be embedded. A memory that repeats an existing one is not stored twice.

**The supervisor** (`supervisor`) is a second language model that thinks about the child's learning so the tutor can spend its attention on the conversation. It never sits between the child and the tutor:

| When | What it does | Cost to the conversation |
|---|---|---|
| Before | Writes a brief from the learner model's candidates, the child's profile and their memories: what to work on, how to start, what to keep in mind | None: it is written ahead, right after the review of the session before, and a session that asks for the same takes it. Otherwise it is written while the person connects, and the tutor starts with the child's profile and gets the brief with its first turns |
| During | Reads each turn after it happened, with the memories closest to what the child just said, and may write guidance for the tutor's next turns. Not in a session the engine runs, where the engine decides the tutor's next step | None: the agent reports turns in the background and never waits. Guidance arrives one turn late by design |
| After | Reviews the session into evidence for the learner model, memories, a note for the guardian and fixed-category flags, and then writes the brief for the child's next session | None: both are jobs in the worker |

Everything the supervisor returns is validated and cut to size before it is used, a skill it invents is dropped from a plan, and the conversation reaches it as data, never as instructions.

## Data about a child

- A child has no account. `children` holds what the tutor may know: a nickname, year of birth, grade, language, interests and a guardian's notes.
- The profile and the plan reach the agent through the platform, with a token that works for one session. They are never put in room metadata, which every participant can read. The agent's token reaches it with its dispatch, which the platform makes when it opens the room; the token a person joins with is signed but readable and travels in a WebSocket's address, so it carries nothing but the room and the participant.
- `consent_records` is append-only, enforced by the database. Each purpose (`voice`, `transcripts`, `memory`) has its own answer, the current one is the latest row, and the rows survive the erasure of the child as proof of what was agreed.
- Without consent for `voice` no session is created. Without `memory` nothing is remembered. Without `transcripts` the turns of a session are deleted as soon as its review finishes; with it they are deleted after a fixed time of at most 24 hours.
- Taking consent back deletes the data it covered. Erasing a child deletes sessions, turns, answers, memories and reviews with it.

## Events

- **Envelope:** [CloudEvents 1.0](https://cloudevents.io) in structured JSON mode: `id`, `source`, `type`, `time`, `subject`, `data`.
- **Contracts:** one JSON Schema per event type and version in [`contracts/`](contracts/README.md). Every language validates against the same files.
- **Outbox:** a component that changes data and publishes an event writes both in one database transaction. A relay delivers the event afterwards, so nothing is lost if the process dies in between.
- **Inbox:** every incoming webhook is verified, stored with its ID and processed once. A repeated delivery is acknowledged and ignored.
- **Delivery is at least once.** Consumers record the event IDs they have handled and must be safe to run twice.
- **Transport:** Postgres. Jobs and event delivery use the same database as the data, so there is no broker to run. A broker is only worth adding when one Postgres stops being enough.
- **The agent publishes through the platform:** it posts events over authenticated HTTP with the event ID as the idempotency key, and keeps a local retry queue so a session's report survives a platform restart.

### Catalog

Defined today:

| Event | Produced by | Meaning |
|---|---|---|
| `device.claimed.v1` | platform | A family linked a device by proving it has it |
| `session.ended.v1` | platform, from the agent's report | A tutoring session on a device finished |
| `session.reviewed.v1` | platform | The supervisor finished reviewing a session |
| `safety.flagged.v1` | platform, from the agent's report | A safety gate stopped a turn (categories only) |

Planned: `family.registered`, `consent.granted`, `consent.revoked`, `device.online`, `device.offline`, `session.started`, `transcript.ready`, `skill.updated`, `entitlement.granted`, `entitlement.ended`.

## Safety and privacy requirements

These are requirements, not goals. Code that breaks one does not get merged.

1. **Two gates on every child turn, and both fail closed.**
   - Content moderation checks what the child said before the tutor answers and what the tutor is about to say before it is spoken.
   - A physical-safety check ([TypeSafe](https://typesafe.ai) Jev) decides whether the child is describing or planning something that needs a nearby adult: heat, electricity, sharp objects, chemicals, medicines, choking, falls.
   - If either gate cannot answer in time, the child hears a fixed safe reply. An unchecked answer is never spoken.
2. **A child's session does not start without both gates configured and working.**
3. **Events and logs never carry a child's words, audio, transcripts or model scores.** Safety flags carry fixed categories only.
4. **No training on children's data,** by us or by any provider. Only providers whose terms allow minors' data with zero retention are supported out of the box.
5. **Audio is not stored.** Transcripts are kept only with a parent's consent, for a short fixed time, and a parent can delete them.
6. **Devices prove who they are.** Each device has its own credentials, and a family links one with a claim code that proves possession. An identifier such as a MAC address is never enough.
7. **Tokens are scoped.** The agent and each device get credentials limited to their own session, not a shared secret that opens everything.
8. **The hardware microphone switch wins.** The server never asks a device to bypass it.

## Decisions

| Decision | Why |
|---|---|
| Agent in Python | LiveKit Agents is developed in Python first: fixes and plugins land there before the Node port, and it has far more production use |
| Platform and worker in Rust | The learner model was already written in Rust; one binary runs the API and the worker, and it stays small on a cheap server |
| A supervisor beside the tutor, not in front of it | A second model in the path of every turn would add its latency to every answer. Out of the path it can be slower and smarter, and a failure costs nothing |
| Embeddings from a local model by default | A child's memories are the most personal data here; embedding them should not require sending them to a third party |
| JSON Schema contracts | The only way two languages can share types without one depending on the other |
| Modular monolith | A small team can run one service well; boundaries stay in the code, where they are cheap to move |
| Postgres as queue and event log | One database to back up and monitor, and events commit with the data they describe |

## Status

Built:

- Contracts for four events, validated by tests in Node, Python and Rust.
- The platform in Rust:
  - families, children and append-only consent;
  - sign-in for guardians by a code sent to their email, with each guardian limited to their own family, and a family's sign-in renewed as it is used, so it ends only after a month unused;
  - sessions created at token issue with a per-session agent token;
  - the learner model with calibrated difficulty, which starts a child at their own grade;
  - vector memory;
  - the supervisor (before, during, after);
  - devices: registration with a per-device key, linking by claim code plus a signed challenge, signed session requests that cannot be replayed, and firmware offered only when newer, over the xiaozhi-esp32 check-in protocol;
  - the outbox, with delivery to the platform's own consumers and to a signed webhook;
  - notices to guardians, in the app, by email and with a push to their phone (Firebase Cloud Messaging) that says only that there is something to read;
  - a Postgres job queue and the housekeeping that deletes transcripts on time and closes abandoned sessions;
  - a first integration of the session engine (`engine/`): when asked, a child's session on a topic its bank covers is run by the engine, stored as its ordered inputs and rebuilt from them, with its lines handed to the agent, a step for the student's screen, and its report sent to the family as the session's summary The level it finds is kept on the child for the next session, each exercise it grades is evidence for the learner model, and its session length and breaks are the only ones in such a session.
- The agent: a first tutor on LiveKit Agents with the camera as an image on each turn, connected to the platform for the plan, the turn reports and the guidance.
- Visuals: the tutor can show an exercise or a simple diagram on the student's screen. It sends a small description that follows a shared contract, and the screen draws it in black on white; no image is generated. What is written on the screen passes the same gate as what is spoken.
- The two safety gates in the agent: content moderation on what is heard and on what is about to be spoken, and the physical-safety check on what is heard. Both fail closed, a child's session does not start unless both are configured and their providers answer when it starts, and what they stop is reported as fixed categories. The physical-safety check is told the student's age, or the ages of their school grade, and nothing else from their profile; the tutor's lines are sent to it without the student's name. No session lets a participant in the room drive it past the gates (LiveKit's session host is off).
- The playground: family sign-in, student setup and consent, voice and typed sessions, exercises and recovery of a still-running tutor after a browser or BFF restart. The platform remains responsible for authorization, quotas and session deadlines; recovery does not restart the session clock. It is also the family app's way to the platform: a pass-through for the routes the app calls and no others, with a guardian's bearer only.
- The team's console (`apps/admin`): the panel the team used in the playground, which now sends its old address there, at admin.meetaule.com behind its own sign-in by emailed code for the team's addresses only, or by a passkey a team member made there, with the platform's Staff check on every call. The platform is the passkeys' relying party: it checks every ceremony with webauthn-rs and keeps only their public half. Beside the panel's numbers it shows who is in a session now, with one line that says whether a deploy can go, the families with search and filters by link and plan, and a page per family with its consents, plans, sessions and the notices it was sent (their kind and dates). It holds no data of its own, and nothing a child said: the platform's routes for the team never send it.
- A compose file for all of it, next to an existing LiveKit server.

Not built yet:

- The inbox for incoming events, and with it entitlements from a store (`order.paid`).
- Drawing visuals on the device's e-ink screen. Only the playground draws them today.
- The device side of `/ota/session`: the firmware does not have its LiveKit transport yet.
- Firmware signatures. The platform records a SHA-256 per version; verifying the image is left to the device's secure boot.

Not validated:

- The learner model's parameters come from public datasets (ASSISTments 2009 and 2017), not from Aule's children. Its forgetting term showed no measurable effect there. `apps/platform/examples/skill_model_eval.rs` refits them from a log of answers.
- The supervisor has only run against scripted answers in tests. How good its plans, guidance and reviews are with real conversations has not been measured.
- The device routes have only been exercised by tests that play the device. No board has talked to them.
- The family app has not called the platform yet: the pass-through and the routes it reaches have only been exercised by tests that play the app.
- The session engine's routes have only been exercised by tests that play the agent and the page. Its texts were written for a page where the student types, and how they sound spoken, and how well speech is read as answers, has not been tried with a child.
- Automated sign-in and notice tests use a stand-in mail service. Each deployment still needs to verify its configured SMTP delivery; a passing test does not establish inbox delivery.
- No push has been sent through Firebase: the sender was written from its documentation and tested against a stand-in.
- The safety gates have automated tests with stand-ins and [provider evaluations on synthetic conversations](apps/agent/evals/physical-safety/README.md), with a [second-reading evaluation](apps/agent/evals/second-reading/README.md). These do not validate outcomes with children or establish provider agreements. Requirement 4 is not met by code: the physical-safety provider needs an agreement covering minors' data, and the moderation provider's terms need checking, before a real child uses the tutor. "Configured and working" is checked when a child's session starts: each provider must answer and take its key. The physical-safety provider lists only model aliases, so whether its pinned model is still served is known from each verdict, not from that check.
- The curriculum in `curriculum/` is a draft that no teacher has reviewed.
