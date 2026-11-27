# Platform

What Aule knows and decides outside the conversation: children and what their guardians consented to, sessions, the learner model, memory and the supervisor. One Rust crate, two processes:

```bash
aule-platform serve     # the API
aule-platform worker    # session reviews, retention, housekeeping
aule-platform migrate   # only bring the database up to date
aule-platform import-skills curriculum/math-primaria.json
aule-platform version   # which build this is (also --version); needs no settings
```

`serve` and `worker` migrate on start, so either is enough for an empty database. [ARCHITECTURE.md](../../ARCHITECTURE.md) explains how the pieces think together.

## Modules

| Module | What it does |
|---|---|
| `learning` | The skill model (`skill_model`, pure), the history it is replayed from, calibrated question difficulty, the candidates for the next session |
| `memory` | Statements about a child with pgvector embeddings; recall by meaning, or by date without an embedding model |
| `supervisor` | The brief before a session, guidance during it, the review after it |
| `ahead` | The plan for a child's next session, written right after a review and kept until a session asks the same question ([below](#the-plan-written-ahead)) |
| `families`, `signin` | Families, guardians, children, append-only consent; sign-in by emailed code |
| `passkeys` | The team console's passkeys, checked with webauthn-rs: the ceremonies in progress, a team member adding, listing and deleting their own, and signing in with one |
| `devices` | Registration, claim codes, signed check-in and sessions, firmware |
| `events`, `notices`, `push` | The outbox and its delivery; what families are told; pushes through Firebase Cloud Messaging |
| `sessions` | Starting a session (its room and the token to join it), the agent's API for one session, the review job and the job that plans the next session |
| `engine` | A session run by the session engine (`engine/`): what the student said becomes the engine's inputs, what the engine answers becomes lines for the tutor and steps for the page |
| `jobs` | The Postgres job queue and the housekeeping |
| `llm`, `livekit`, `mail`, `auth`, `config`, `error` | Claude with a forced structured answer, rooms opened through LiveKit's server API and the tokens to join them, the two kinds of caller, settings, the error shape |

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

The family app reaches the guardian's routes it calls, and no others, through
[the playground's pass-through](../playground/README.md#the-family-apps-api),
which takes a guardian's bearer only.

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
| `GET /v1/me/plan` | The family's plan and what is left of it: `plan` (`trial`, `paid`, `granted`, `none`, `team` or `free`), when it ends, the sessions `used`, `allowed` and `left` in its `period`, the price, and `team`: whether the signed-in person is on Aule's team |
| `GET /v1/notices`, `POST /v1/notices/{id}/read` | What the family has been told |
| `PUT`, `DELETE /v1/push/tokens` | The app registers this phone for pushes each time it starts, and forgets it on sign-out. Body: `{"token", "platform"}` with `android`, `ios` or `web` |

A family's token lasts 30 days from its last use: a request with one that has
fewer than 29 days left sets it to 30 days from then (`auth::Caller`), so a
session is written once a day at most and a parent who opens the app within a
month never needs another code. Signing out and erasing the family still end it;
an ended one stays ended, and the team's sessions of 12 hours keep their end.

Every way of signing in also takes an optional `source`: the code of the link
a family came from, which the playground passes on from `?src=` on its page. A
new family keeps it when it is a short code of lower-case letters, digits and
hyphens that starts with a letter, 24 at most (`signin::source_code`, and a
check in the database). Anything else is dropped and the sign-in goes on; a
family that already exists keeps the one it came with.

### Children and learning (guardian for their family, or operator)

| Route | What it does |
|---|---|
| `POST /v1/families/{id}/children` | A child's profile. `grade` is `P1` to `P6` or `S1` to `S5`. A signed-in guardian may send what they consent to with it, `consents: {voice, memory, transcripts, policy_version, locale?}`, written in the same transaction as the child and recorded as `POST /v1/children/{id}/consents` records each answer: `voice` must be `true` and `memory` and `transcripts` answered, or the answer is 400 and no child is made. The operator's token gets 400 for it: the operator records answers one at a time, saying how |
| `GET`, `PUT`, `DELETE /v1/children/{id}` | Read, replace or erase a child and everything derived from them. `tutor_name` (1 to 20 letters, default `Aule`), `tutor_persona` (`calido`, `jugueton`, `aventurero` or `tranquilo`) and `tutor_persona_note` (one line, up to 200 characters; empty removes it) say how the tutor presents itself, and keep their value when left out. `subjects` are the school subjects the family wants reinforced, from the list `GET /v1/me` returns; left out of a `PUT`, they keep their value. `relationship` is what the signed-in guardian is to the child (see [People, as FHIR R4](#people-as-fhir-r4)); it keeps its value when left out, an empty text removes it, and `GET` returns the caller's own (`null` when not stated, or for the operator). A `PUT` with `consents` is refused (400): an answer has its own route |
| `POST /v1/children/{id}/consents` | Grant or take back `voice`, `transcripts` or `memory` |
| `GET /v1/children/{id}/skills` | What the child knows now, and what the model would work on next |
| `POST /v1/children/{id}/attempts` | Answers reported by a guardian (the operator can also import past records) |
| `POST /v1/children/{id}/corrections` | "They already know this": override a skill |
| `GET /v1/children/{id}/memories?query=` | What is remembered, closest to the query first |
| `DELETE /v1/children/{id}/memories/{memory_id}` | Forget one thing |
| `GET /v1/children/{id}/reviews` | Notes from past sessions |
| `GET /v1/children/{id}/sessions?limit=` | The child's sessions for the family's app, newest first, the one going on now and those that never started included: `{sessions: [{id, status, created_at, started_at, ended_at, end_reason, engine, language, objective, on_device, reviewed}]}`. `status` is `created`, `active` or `ended`; `objective` is its `kind` and `subject` (or `null`), never the topic or day typed for it; `on_device` says a device ran it, `reviewed` that its review has run. Never what was said. 20, or `limit` from 1 to 50 (400 otherwise). For the child's own guardians only: the operator's token gets 403 |
| `GET /v1/children/{id}/sessions/facts?limit=` | For the playground's home, the child's latest sessions as facts, newest first: when, how long (`seconds`, `null` when the housekeeping closed it), what for (the objective's `kind` and `subject`), up to three skills by catalog name, exercises tried and right, breaks, how it ended; never what was said, the topic typed or the review. Child sessions that started and ended; 3, or `limit` from 1 to 10 |
| `GET /v1/sessions/{id}` | Lifecycle only for the child's guardian or operator: status, fixed end reason, language, engine flag and remaining seconds; resume requires active status and current voice consent |
| `POST /v1/sessions/{id}/end` | Owner stops a session, including after voice consent is revoked. First close wins and queues one review |
| `POST /v1/sessions` | A session and its room token. The platform opens the room through LiveKit's server API and asks for the tutor there, so the agent's token and the family's note never reach the person: their token only lets them into the room. 503 when LiveKit does not open it. A guardian can only start a child's session. Optional `objective`: what the family says the session is for, `{kind: homework, exam_prep, exam_review or explore, subject (one of the subjects, or other), topic (up to 200 characters), due (a date)}`; the supervisor plans for it first. Optional `engine: true` asks for the [session engine](#sessions-run-by-the-session-engine) to run the session; the response's `engine` says whether it does |
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
last non-agent participant disconnects. The platform opens a room before the
person joins it, and the tutor waits there. A room nobody joins within 30
seconds is closed: the session never starts, and the tutor closes it with
`end_reason: "device_offline"`, so it counts for nothing and the family can
start another at once. A first join later than that, with the same token,
opens a room with no tutor in it; the client should end that session and start
another rather than wait (the playground says the tutor could not come in, and
its «Terminar» does that). A client should retry with
the same room, participant identity and still-valid token. It must not call the
session creation endpoint on every network retry: that creates another session. A
successful rejoin while the room and tutor remain running preserves their
state and uses the existing session's allowance. The session's normal time
limit, consent checks and explicit end still apply.

This grace period covers short transport interruptions, not a device reboot,
an expired token or a crashed tutor. The firmware's LiveKit transport and
recovery still need implementation and tests on a board; the signed device
route alone does not prove that a device can reconnect. Clients should show
that they are reconnecting, retry with bounded backoff, and preserve the
physical microphone switch. Do not replay buffered speech after reconnecting.

### Aule's team

The operator's token, or a signed-in guardian whose address is in
`AULE_ADMIN_EMAILS` (`auth::Staff`); a family's token gets 403. The team's
console (`apps/admin`) signs its members in with codes of their own, or with a
passkey (the first four routes, which need no token). What the team reads about
the families is what it needs to look after them: never what a child said.

A team member's passkeys for the console take more than that
(`auth::TeamMember`): a session the team's sign-in opened, which lasts 12 hours,
and never the operator's token or a 30-day session, a team member's own from
the playground included; anything else is the same 403. Only the passkey's
public half is kept (`team_passkeys`), and the platform checks every ceremony
with webauthn-rs, for the relying party `AULE_ADMIN_PASSKEY_RP_ID` and the one
origin `AULE_ADMIN_PASSKEY_ORIGIN`, with user verification required. A
ceremony is kept in the platform's memory for 5 minutes (the browser gets 4)
and works once, so a restart drops the ones in progress.

A passkey sign-in needs no address: the passkey says whose it is, and its owner
must still be in this platform's `AULE_ADMIN_EMAILS`. The answer names the
owner's address, for the console to check against its own list too. It opens
the same 12-hour session a code does, tied to the passkey: deleting the
passkey ends every session it opened. It keeps the counter and backup state
the library read. A counter that did not go up, once the signature is checked,
means a copy of the key is in use, as the library warns: the passkey is
deleted, with the sessions it opened, and its owner is mailed. A sign-in the
browser says ran in a frame of another site is refused too; the library
checks that only when a passkey is made. Every refusal is logged with its
reason in fixed words, and nothing of the passkey.

Passkeys are optional: a member who has one still gets codes. Making them
required is the owner's decision, to be made in `signin::team_start` and
`team_verify`; a member who lost every device would then need the operator to
delete their rows in `team_passkeys`.

| Route | What it does |
|---|---|
| `POST /v1/auth/team/start` | `{email}`: a six-digit code for the team's console, mailed only to an address in `AULE_ADMIN_EMAILS` that has a guardian account. Every address gets the same `204`. These codes are kept apart from a family's, so asking for one leaves nothing a family's sign-in can read or use up: they have their own five an hour |
| `POST /v1/auth/team/verify` | `{email, code}`: `{token, expires_in_hours: 12}` for the code `team/start` mailed, a session of 12 hours instead of a family's 30 days. It never makes an account; anything else, a wrong or used code included, is the same `403`, and five wrong tries burn the code |
| `POST /v1/auth/team/passkey/options` | What the browser needs to sign in with a passkey, `{ceremony, options: {publicKey}}`, for `PublicKeyCredential.parseRequestOptionsFromJSON`: the same for everyone, with an empty allow list (the browser's picker shows whose passkeys they are), user verification required, and no forced autofill |
| `POST /v1/auth/team/passkey/verify` | `{ceremony, credential}`, with `credential` as the browser's `credential.toJSON()` (16 KiB at most): `{token, expires_in_hours: 12, email}`, the session a code opens, for the team member whose passkey signed, and their address for the console's own check. Anything else is the same `403`: an unknown, used or expired ceremony, a ceremony the browser says ran in a frame of another site, a passkey nobody has, a user handle that is not its owner's, an owner no longer on the team, or one the library refuses (user verification, origin, RP id, signature, a change of backup eligibility, or a counter that did not go up, which also deletes the passkey) |
| `POST /v1/admin/passkeys/options` | What the browser needs to create a passkey for the caller, `{ceremony, options: {publicKey}}`, for `PublicKeyCredential.parseCreationOptionsFromJSON`: discoverable, with user verification, attestation `none`, and the caller's own passkeys excluded. The ceremony is bound to this session, which must have been opened in the last 15 minutes (`409` otherwise: sign in again); a session has one at a time, and a new one replaces it. The user handle is random, the same for all of a member's passkeys, never their guardian id; the name shown is their address. `400` at 10 passkeys |
| `POST /v1/admin/passkeys` | `{ceremony, label, credential}`, with `credential` as the browser's `credential.toJSON()` (16 KiB at most): the passkey, kept once the library has checked it. `201 {id, label, created_at, last_used_at}`, and the member is mailed that a passkey of that name was added, where mail is set up. `409` when the session's sign-in is no longer from the last 15 minutes, as at the start: the ceremony outlives what was left of it. `400` for a name that is not 1 to 60 characters on one line, a ceremony that is unknown, used, expired or another session's, a credential the browser says is not discoverable, one the library refuses, one already registered to anyone, or an eleventh |
| `GET /v1/admin/passkeys` | The caller's own passkeys, newest first: `{passkeys: [{id, label, created_at, last_used_at}]}`. Never a credential id, a key, a handle, a counter or a flag |
| `DELETE /v1/admin/passkeys/{id}` | Deletes one of the caller's own, and every session it opened: `204`. Someone else's is the same `404` as one that never was. A team session is enough: deleting gives nobody a way in |
| `GET /v1/admin/families` | The families, newest first, each with its guardians' addresses, how many children, its plan now (`standing`, as `/v1/me/plan` has it), the link it came by (`source`) and how much it used Aule in the last 7 and 30 days. With nothing asked, the newest 300. `q` finds a family by its name or a guardian's address (any part, whatever the case; 100 characters at most), `source` by a link code and `status` by the plan it has now (`trial`, `paid`, `granted`, `none`, `team` or `free`); an empty one is no filter. `limit` (1 to 300) and `before`, the `next` of the page before, page through them. `total` is how many match `q` and `source`, and null with a `status`: a plan is worked out family by family, so a search by plan looks at 300 at most, and its page can come back short with a `next` that goes on from where it stopped. `sources` is every link code with its number of families, the most first (100 at most) |
| `GET /v1/admin/families/{id}` | One family's page: its name, link and sign-up date; its guardians (name, address, language, how they get notices; 10 at most, oldest first); its children (nickname, age from the year of birth, grade, and for `voice`, `transcripts` and `memory` the current answer, `granted`, with when and how it was given: `at` and `source`, null when never answered; 20 at most); its plan now (`standing`), its `trial` (from the first session that counts, whatever the plan now), every plan it has had, paid or granted, with the note and who on the team granted it (`granted_by`, null for the operator's token; 50 at most, newest first: a grant the team ended shows the days it ran); and its `sessions`: how many `started`, the latest start, and how many are `open`. Never a child's notes, interests or tutor, the id of a guardian or a child, who recorded a consent, a card's token, or anything said in a session. 404 for a family that is not there |
| `GET /v1/admin/families/{id}/sessions` | Its sessions, newest first, started or not: when, `seconds` (null for one that never started or that the housekeeping closed), `status`, `end_reason`, `engine`, `via` (`web` or `device`), the child's nickname and the audience. 20 to a page, or `limit` from 1 to 50; `before`, the `next` of the page before, goes on. No id, room, token, objective or anything said |
| `GET /v1/admin/families/{id}/notices` | The notices it was sent, newest first: `kind`, when, about which child, and when they were read, mailed and pushed; never their words. Paged like its sessions |
| `GET /v1/admin/sessions/open` | Who is in a session now, newest first: the family and its id, the child's nickname (null for the operator's own tests), `status` (`created` while starting, `active`), when it was made and started, `engine`, `via` and `overdue`: open longer than the session's length and 50 minutes more (`overdue_after_minutes`), so more likely stuck than running; the housekeeping closes it after 3 hours. `open`, `starting` and `overdue` count every open session, the team's tests too; the list stops at 100 (`more`). Before a deploy that restarts the playground or the agent, `open` should be 0 |
| `POST /v1/admin/families/{id}/grant` | Gives the family the plan for `days` (1 to 366) from now, with an optional `note` of up to 500 characters. Records who on the team granted it |
| `DELETE /v1/admin/families/{id}/grant` | Ends what the team granted, from now. A paid plan is not touched |
| `GET /v1/metrics/weekly?weeks=12` | The pilot's four numbers, for the families that signed up each week (Monday to Sunday, in the configured local time) and by the link they came from: how many there are and how many `started` (a session of 10 minutes or more; one the housekeeping closed has no known length). A number that takes time counts only the families whose time for it is over, so a week still running does not read low: `repeated` (3 sessions in the 7 days from their first) out of `week1_over`, those whose 7 days, and so their trial, are over; `week4` (a session on days 21 to 27 from their first) out of `week4_over`, those whose fourth week is over; and `paying`, out of `week1_over` too. Nobody can pay in the app yet, so a plan the team granted once a family's trial was over counts as paid, even one given as a gift, unless the team ended it within a day. Sessions count as they do for the plan, and the team's own families (`AULE_ADMIN_EMAILS`) are left out. Next to the cohorts, two numbers about children rather than families, in the same weeks and from child sessions only, counted as for the plan: `children.back_in_week1`, those with a second session within 7 days of their first, out of `children.week1_over`, those whose 7 days are over, and `children.back_so_far` out of `children.with_a_session`, all whose first session falls in those weeks; and `talk.median_child_turns_per_minute`, the median of the child's turns per minute (from start to end, breaks included) over the sessions started in those weeks with a known length (one decimal, `null` when there is none), with how many `talk.sessions` that is. Counts and link codes only |
| `GET /v1/metrics/daily?days=14` | One object per day, newest first: sessions (started, never started, under a minute, median length, seconds to start), how the talk was shared, exercises (posed, not checkable, correct, failed, first-try rate, hints, and how many had their answer said by the tutor while still open), turns stopped by each safety gate, sessions warned and closed for not working, what the agent measured, what reached the family, and `cost_usd`: what the day's sessions cost by service (the tutor's model, speech to text, the voice, the platform's own model calls), in total and per hour of session, from the measured usage and the dated list prices in `metrics.rs`. Counts, rates, durations and dollars only |

### Operator only

| Route | What it does |
|---|---|
| `POST /v1/families` | A family and its first guardian, without sign-in |
| `PUT /v1/skills` | Loads skills into the catalog (`aule-platform import-skills <file>` does the same from a file) |
| `GET /v1/sessions/{id}/supervisor` | The plan and guidance of one session and, once it has been reviewed, `review`: the summary and next step written for the family, and `exercises`: each checked exercise with its answer, tries, hints and outcome |

### Agent

| Route | What it does |
|---|---|
| `GET /v1/agent/session` | Marks the session as running; returns the student's profile as `instructions`, with the plan when it is already written (it is when it was [written ahead](#the-plan-written-ahead)); in a session the engine runs, with only what the plan says about the student ([below](#what-the-agent-gets)), `student_name` and `session_number` (how many sessions the student had started before this one) for written lines, `student_age` (from the year of birth) and `student_grade` for the physical-safety gate, which judges for the child's age, and `tutor` (`name`, `persona`, `note`): how the tutor presents itself to this child. The same three travel in the dispatch metadata as `tutor_name`, `tutor_persona`, `tutor_persona_note`, with the agent's token as `platform_token`; the platform hands that metadata to LiveKit when it opens the room, and LiveKit gives it to the agent's job only. In a session the engine runs it also starts the engine and returns `script`: its opening lines. Optional `?homework=` (0 to 2): what the agent can do with a photo of the homework; see [below](#a-photo-of-the-homework) |
| `POST /v1/agent/session/turns` | Reports turns; returns guidance written since the last call, and `plan` (text for the tutor, or null) when the plan was finished after the tutor started. `stop` is `"warn"` after 2 turns in a row in which the student is plainly not working, `"end"` after 4: the tutor says a fixed line for each, once, and on `"end"` closes the session with `end_reason: "not_working"`. The family gets a notice when the close is asked for. `pause` is `"offer"` when a break is due: `AULE_BREAK_EVERY_MINUTES` of work have passed (default 30) or the supervisor read tiredness, no exercise is open and more than 10 minutes remain; the request's optional `breaks_taken` tells the platform a break happened, and an offer not taken in 2 minutes counts as declined. In a session the engine runs, `guidance` stays empty, `pause` stays null (the engine gives its own breaks), and `script` is present when an answer was typed on the page since the last report |
| `POST /v1/agent/session/said` | Only in a session the engine runs: what the student said, and what the tutor does next. See [below](#sessions-run-by-the-session-engine) |
| `POST /v1/agent/session/homework` | Only while the engine waits for a photo of the homework: what the agent read in it. See [below](#a-photo-of-the-homework) |
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
| `families` | `Group` (`type: person`, `actual: true`) | Its members are the family's children. Siblings are children of the same family; they are not stored as a relationship. `source`, the link it signed up from, is Aule's own |
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

`.env.example` at the repository root lists them. Only `DATABASE_URL` and `AULE_ADMIN_TOKEN` are required: without LiveKit keys no session can be created (with them `LIVEKIT_URL` is required too: rooms are opened through LiveKit's server API there, at the address the agent connects to, and never through the public one), without mail settings nobody can sign in and notices stay in the app, without a Firebase service account there are no pushes, without `ANTHROPIC_API_KEY` plans come from the learner model alone and there is no guidance or review, and without `AULE_EMBEDDINGS_URL` memories are recalled by date.

The embedding model must return 1024 dimensions (`bge-m3` does). Another size needs a migration.

## Develop

Use Rust 1.94 or newer (required by SQLx 0.9) and PostgreSQL 17 with pgvector.
webauthn-rs, for the team's passkeys, links the system's OpenSSL, so a build
also needs its headers and pkg-config: `apt install pkg-config libssl-dev` on
Debian or Ubuntu, `brew install openssl@3 pkg-config` on macOS. The image
installs them itself.

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

## The plan written ahead

The supervisor takes several seconds to write a session's plan, and the tutor does not wait for it: it greets with the student's profile and gets the plan with the answer to its first turns. So that the plan is there from the first word, it is written ahead.

- **When:** the review of a session queues a second job, `plan_ahead`. It writes the plan for the child's next session, for what the family asked this time, and keeps it with the review (`session_reviews.next_brief`). One plan is kept for a child: the one that follows the latest review.
- **Which session takes it:** a kept plan answers one question and carries its key, a hash of the supervisor's instructions and of all it reads to plan: the student, the objective, the skills the learner model offers and the reason for each, the memories and the step the last review suggested. A session that would ask the same question takes the plan, within the first moments of its start, and the supervisor is not asked. The learner model's probabilities and the order they put the skills in are left out of the key: they move a little every day while the question stays.
- **Otherwise** the plan is written at the session's start, as it always was. That happens when the family asks for something else, when a review has become due or the learner model offers other skills, when the profile or the memories changed, when the plan has waited 7 days, and at a child's first session.
- **Consent:** a plan written with the child's memories is kept only if the guardian still agrees to them when it is stored. Taking that consent back, or deleting one memory, deletes the kept plan. None is written for a child without consent for voice.
- **Cost:** one plan more for each reviewed session, counted with that session; the session that takes it asks for none. Only the supervisor's plans are kept: without a supervisor nothing is.

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
| `homework` | `Tarea`, with `due` as its date. The exercises are the bank's own homework, not the student's; with a [photo of the homework](#a-photo-of-the-homework), only those up to its level |
| `exam_prep` | `Preparacion`, with `due` as the date of the exam: the engine simulates it |
| `explore` | none: the engine's `Extracurricular`, with the topic as the family's suggestion |
| `exam_review` | not run by the engine: its `Correccion` needs the exam the student sat (the questions they missed, what they answered), which the platform does not have |

The child becomes the engine's profile (`Perfil`): the nickname is the student's name, the interests choose the setting of the exercises, and the family's first guardian is who the report greets. The day is the session's own, in the server's timezone setting.

### What the agent gets

The supervisor's plan is not the tutor's to follow in these sessions: the engine decides what is worked on and asks every question. Of the plan, `instructions` and the late `plan` carry only its "About this student" lines, or nothing when it has none. Given the whole plan, the tutor's model set the plan's activities against the engine's ("Mira la barra… cuenta todas las partes", the plan's first activity word for word, in the middle of the engine's explanation), and then judged the child's next answer against its own question. The plan is still written and kept whole, for the review and for the team.

A line is `{"say", "show", "reword", "echoes"}`:

- `say` is the engine's text, word for word.
- `show` is a visual of [`contracts/visuals`](../../contracts/README.md), or `null`. Each drawing of the engine is translated to the closest kind (bars, circles, counters, a table for the activities of a break, the statement as an `exercise`); one with no faithful kind, such as a number line cut into fractions, is not approximated. A bar or a circle the engine draws without a label is sent with `labelled: false`, because a screen would otherwise write the fraction next to it, and that is often the answer.
- `reword` is true when the engine would have a model word the line; `say` is then its scripted fallback.
- `echoes` is true for lines that answer something the student said in their own words (text and conversation, as opposed to a graded answer, a hint or a break). The engine does not repeat those words today, but the agent should not treat such a line as fixed text.
- `choices`, only on a line that asks something whose answers are known, is what the student can tap under it, as [`contracts/choices`](../../contracts/README.md) has it: `{"options": ["Sí"], "multiple": false}`. They are the engine's own words: its questions' (`Motor::opciones`: «Sí» to «¿Empezamos?», a break's four activities, «No tengo mi tarea» while it waits for the homework's photo, «Sí, fracciones» and «Sí» or «No» when it proposes the topic), and an exercise's options, under the last line of each turn the engine says while that exercise waits for one of them (its statement, a hint after a wrong one), but not while an answer is held for how it was worked out. Only the last line of a turn has them. A tapped option comes back as `said`, as if the student had said it.

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
- `awaits` is there only while the engine waits for something the agent has to act on, and says what: `"homework_photo"` (see [below](#a-photo-of-the-homework)). The same goes for every `script`. Without it, the answer is as above.

`POST /v1/agent/session/turns` keeps working: turns are stored and reviewed. `pause` is always null: breaks are the engine's, at 30 and 60 minutes of a session long enough to have them and when the student says they are tired, and they arrive as lines. The supervisor does not read the session while it runs: the engine decides what the tutor does next, so its advice was never written, and two thirds of its reads were spent here. So `guidance` stays empty and `stop` stays null: a student who is plainly not working is no longer warned and the session is not closed for it. The review after the session still reads all of it. When an answer was typed on the page, the answer to the next report carries `"script": {"lines": [...], "closed": bool}`, once.

### How what the student says is read

Spoken words arrive as one text, and no model reads them:

1. "Estoy cansado" starts the engine's break, and asking to leave the screening leaves it.
2. When an answer is awaited and the text holds one, it is graded with the engine's own checker (value and form). The answer is the number said before "porque" or the end of the first sentence, when there is one there; the whole text is the explanation, checked with the engine's key words. Where an explanation is required and missing, the answer is held and the student is asked once how they worked it out.
3. "No sé" is a wrong answer where there are no hints (the screening, the simulated exam) and a request for a hint elsewhere. "No entiendo" in the screening is a question, not an answer.
4. In the guided moments (a date, "¿empezamos?", the theory) text that moves the session on goes to the engine as text.
5. Anything else is conversation: the engine is told its intent, from its own deterministic classifier, and `converse` is returned. Asking for help or for the answer gets the engine's hints, or its fixed line where there are none; asking to hear the exercise again gets its statement.
6. Conversation does not bring the answer the engine waits for, and by voice a misheard number is conversation too. The third time running at a step that waits for an answer or an explanation, the engine says its question again, as the whole turn (`converse` is `null`); an answer, a hint asked for or any other step starts the count again. In the theory it moves on by itself instead.

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

`state` is `done`, `current` or `pending`; `card` is `null` between exercises. The step never carries the expected answer, the key words of an explanation or its criteria: it is built field by field from what the engine shows a student. While the engine waits for a photo of the homework the step also has `"awaits": "homework_photo"`, so the page can point at the camera. While it waits for the answer to one of its own questions, the step has what its line offered to tap, `"choices": {"options": [...], "multiple": false}`; an exercise's options stay on its card.

### A photo of the homework

Off unless the setting `AULE_ENGINE_HOMEWORK` is 1 and the agent says it can read a photo when it starts the session: `GET /v1/agent/session?homework=1`. Nothing, or 0, is no photo; 2 is for also working through the homework itself, which the engine does not do yet, so today it counts as 1. The session gets the lesser of what the agent says and the setting, fixed when the engine starts: a tutor that reconnects does not change it.

In a homework session the engine then asks to see the homework at the camera once it knows the student's level: after the screening, which closes without the plan, or at the start when the level is already known. While it waits, `awaits` is `"homework_photo"`, and everything the student says goes to the engine, which answers it itself: «no tengo» goes on without the photo, anything else is reminded of the camera, and the third turn without a photo goes on without it. A tutor that reconnects is given that reminder as its script.

`POST /v1/agent/session/homework` takes what the agent read, and returns what `said` returns:

```json
{ "outcome": "read", "level": 3, "confidence": 0.82 }
```

- `outcome` is `read`, `other_subject`, `no_homework`, `unreadable`, `unavailable` or `shown`. `level` (1 to 5, the highest in sight) and `confidence` (0 to 1) go with `read`, and only with it.
- Any other field is a 400, so the photo itself never reaches the platform. What is stored, as an input of the engine, is the outcome, the level and the confidence in percent.
- A photo that cannot be read, read with a confidence under 70%, or without a homework in it is asked for again; at the second one the session goes on without it, with the bank's homework as before. So does a homework that is not fractions, which the student and the family are told.
- A level is the homework's target: the plan is told and reported then, and the bank's homework keeps only its exercises at that level or below. When none is left, the engine says the homework is ready to do and the objective is complete.
- 409 when the session has ended, the engine does not run it, or it does not wait for a photo; `shown` is a 409 for now, since no session works through the homework yet.

To turn it off, set `AULE_ENGINE_HOMEWORK=0`. To go back to an image from before it, set 0 and wait for the open sessions to end first: an older image cannot rebuild a session that stored a `homework` input.

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

Migration 0023 adds nullable `session_reviews.next_brief`, the plan for the
child's next session ([written ahead](#the-plan-written-ahead)): its key, the
plan and when it was written. Reviews from before keep null.

Migration 0022 adds `team_passkeys`, the passkeys the team signs in to its
console with: for each one, the team member's guardian account (it is erased
with it), the credential id, the public key with its counter and flags as
webauthn-rs keeps them, the member's name for it, and when it was made and last
used. Nothing in it is secret. No row exists until a team member adds one. It
also adds nullable `guardian_sessions.passkey_id`, the passkey that signed a
session in, so that deleting a passkey ends the sessions it opened; every
session from before keeps null.

Migration 0021 adds nullable `families.source`, the link a family signed up
from, with a check on its form; families from before keep null.

Migration 0020 adds nullable `sessions.end_reason`. Existing sessions keep null;
new closures persist the same fixed reason published in `session.ended.v1`, now
including `provider_error`. No transcript is returned by the lifecycle endpoint.

All four only add to the schema, and still an image from before one of them
does not start on a database that has run it: every command migrates first,
and sqlx refuses a database with a migration the image does not know
(`VersionMissing`). To roll the image back past one, undo it and delete its row
from `_sqlx_migrations` first, newest first. For 0023, `alter table
session_reviews drop column next_brief` (the plans written ahead are lost:
each child's next plan is then written at the session's start) and `delete
from _sqlx_migrations where version = 23`; for 0022, `alter table
guardian_sessions drop column passkey_id`, `drop table team_passkeys` (the
team's passkeys are lost: each member should also delete theirs from their
devices) and `delete from _sqlx_migrations where version = 22`; for 0021,
`alter table families drop column source` (the links families came from are
lost) and `delete from _sqlx_migrations where version = 21`.

## Email format and opting out

Codes and family notices are UTF-8 `multipart/alternative`: plain text plus HTML,
with escaped content, inline styles and no remote images or tracking pixels.
`cargo run --example mail-preview` (or `-- en`) prints a synthetic HTML preview
without sending mail. Synthetic mobile previews: [Spanish](screenshots/mail-es.png)
and [English](screenshots/mail-en.png). The SMTP sender remains `AULE_MAIL_FROM`; use the company
address, `Aule <admin@meetaule.com>`.

Family notices include an Open Aule action and an unsubscribe button. The
button reaches `AULE_MAIL_PUBLIC_URL/unsubscribe` (default: the public session
page). Deploy the playground route **before** the platform and worker start
sending these links. A GET only shows confirmation; a POST validates a signed
capability and turns off that guardian's existing `notices_by_email` preference.
Summaries and attention notices remain in the app, push preferences stay as
configured, and sign-in/security codes keep working. Re-enabling is the existing
authenticated `PUT /v1/me` setting, not an action available to the email token.

Tokens expire in 90 days, contain no email address or child details, and use a
purpose-separated HMAC under the existing operator secret. Rotating that secret
invalidates old links. The public handler forwards no browser credentials, has
bounded bodies and a timeout, and returns no-store/no-referrer pages. No database
migration or new secret is needed.

Notices also include List-Unsubscribe and List-Unsubscribe-Post headers. For mail
clients to offer RFC 8058 one-click unsubscribe, the SMTP provider must DKIM-sign
both headers; verify that in a delivered test message when configuring delivery.
The HTML button works independently. Sign-in and passkey emails never get list
headers or a notice unsubscribe action.
