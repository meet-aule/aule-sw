# Agent

Aule's voice tutor: a [LiveKit Agents](https://github.com/livekit/agents) worker in Python. It joins a room when asked by name, listens, and answers out loud. When the person's camera is on, the tutor also gets the latest frame with each turn, so it can look at a notebook.

## What is here

| Module | What it does |
|---|---|
| `worker` | The LiveKit worker: one tutor session per room it is dispatched to, with a time limit |
| `comparison` | Exact comparison of bounded integer, fraction and decimal literals for hints; no exercise state or network |
| `answers` | What of a child's turn goes to the platform's exercise checker, and in what form; pure, no IO |
| `tutor` | The tutor's instructions, and where the gates and the camera plug into a turn |
| `prompts` | Canonical English tutor policy, optional capability rules and the final output-language rule; see the [prompt inventory](PROMPTS.md) |
| `safety` | Who a session is for, and the two safety gates of [ARCHITECTURE.md](../../ARCHITECTURE.md) run together on every turn |
| `moderation` | The content-moderation gate: what the person said and what the tutor is about to say |
| `physical_safety` | The physical-safety gate: whether what the person said needs a nearby adult |
| `replies` | The fixed replies a person hears when a gate stops a turn, in Spanish and English |
| `visuals` | What the tutor can show on the student's screen, checked against the shared contract before it is sent |
| `choices` | Answers the student can tap under the tutor's question, checked against the shared contract and sent once the question has been heard |
| `camera` | The latest camera frame, held in memory and never stored |
| `closing` | The sentences with which a model closes a session (a goodbye, "that's all for today"), left out of its replies while the session engine is still running the session |
| `homework` | What a photo of the homework shows, read by a model for the session engine; nothing it writes is said, and the photo is never kept |
| `prosody` | Whether the voice went up or down at the end of an utterance, measured from the audio by rule, for pronunciation drills |
| `providers` | Builds the speech and language models from the settings |
| `platform` | Gets the student's profile and the supervisor's plan, reports turns and safety flags in the background, applies guidance |
| `config` | Reads and checks the environment |
| `logs` | Keeps the fields in which LiveKit logs what the user said out of the log |
| `events` | Wraps what the agent reports in the shared [contracts](../../contracts/README.md) |

## Who it talks to

A session is for a child unless the server that created the room marked it `{"audience": "operator"}` in the dispatch metadata. The platform asks for the tutor when it opens a session's room, so that metadata, with the agent's token for the platform, never reaches the person. The tutor waits in the room for the person: nothing starts and nothing is said until they are in it. If LiveKit closes the room before anyone comes (30 seconds), the tutor only tells the platform the session ended (`device_offline`), so the family can start another at once. The agent refuses a child's session unless both safety gates are configured and their providers answer when it starts. In an operator's session (an adult on the team, through the [playground](../playground/README.md)) the gates that are configured run and the others are skipped.

The two gates:

- **Content moderation** uses OpenAI's moderation endpoint (`omni-moderation-latest`) with thresholds set for children, plus a short local list of phrases that must not depend on a provider. It checks what the person said before the tutor answers, and the tutor's whole reply before any of it is spoken. The two are not treated alike: the tutor's reply is filtered, and what a child says is not (see below). The list's swear words stop a reply of the tutor, so it holds only words that are swearing wherever they are said: everyday words in Peru such as "pita" (string), "pito" (a whistle), "chunga" (a joke) or "concha" (a shell) are not on it.
- **Physical safety** uses [TypeSafe](https://typesafe.ai)'s Jev model (`jev-1.14.0`). It checks what the person said, with the text of the recent conversation as context, at the same time as moderation; the tutor waits for both. It is told how old the student is as the platform says it: their age, from the year of birth; without one, the ages of their school grade (6-7 for P1, 16-17 for S5); without either, that it is unknown. Nothing else from the profile is sent. The tutor's lines go without the student's name (the greeting, the session engine's opening and the model's own lines say it); what the student says goes as they said it.

Before a child's session starts, each gate asks its provider once whether it answers, while the agent joins the room and asks the platform about the student, so the check adds no wait when the providers answer in time. Moderation reads one word on its endpoint, which is free; the physical-safety gate lists the models its key may use, which runs no model. With the talk button each press sends those requests again (and lists the second reader's models), without waiting for them, so the checks of the turn find their connections open instead of opening one while the child waits; nothing of the student is sent, no verdict depends on it and a failure is ignored. The physical-safety gate's client keeps a single connection, which its warm-up holds while it lasts, so that warm-up gives up after 0.3 seconds and none starts while a check is under way: a check waits for it at most that long, well inside its first try. A gate that is not configured, a refused key, no answer in time or an answer the gate does not take ends the session before the tutor starts: the child hears, and reads in the transcript, the fixed "I can't respond safely right now" line in their language, and the platform records `provider_error`, which the page's end screen explains. Only the voice runs in that session: no model, no speech recognition, and nothing the child says or types is read.

No session lets the room drive it. LiveKit's session host, on by default, would let anyone in the room send the model text that no gate reads and read the tutor's instructions; the agent turns it off in every session it starts.

**What a child says is not filtered** (the owner's decision, 2026-11-26). Whatever moderation finds in it (sexual words, violence, insults, contempt, threats, an attempt to make the tutor drop its rules), the turn reaches the tutor, whose model answers it; the finding is logged by category and nobody is told. Scores took ordinary answers for something else too often: «Abajo es el total de partes, arriba las que están pintadas», the right answer to "explain it in your own words", was stopped as sexual and violence. Three things still come before the tutor's answer, and none is a refusal:

- **A child who may be hurting themselves** hears a caring line, and the family is told. A faint self-harm score is read once more by a second reader before that ([evals/second-reading](evals/second-reading/README.md)).
- **A child who may be telling of abuse** (sexual content that involves a minor) hears a caring line too, and the family is told.
- **A child describing or planning something dangerous** is asked to get a nearby adult, by the physical-safety gate.

What the tutor is about to say is filtered as before: anything found stops the reply.

Both gates fail closed. If a gate fails, is late or answers something the agent does not fully understand, the person hears a fixed reply and the unchecked text is never answered or spoken. The fixed replies depend on what happened: support for self-harm or for a child's sexual safety, a request to get a nearby adult for a physical hazard, a request to rephrase when the physical-safety verdict is uncertain, a redirection when the tutor's own reply was stopped, or a plain "I can't answer safely right now".

With `AULE_EARLY_REPLY=1` the model is asked for a spoken turn's reply at the same time as the gates judge the turn (not with the session engine, which reads the turn first, and not for a turn that takes a camera frame). What it writes is kept apart: nothing of it is said, shown, run as a tool, added to the conversation, reported, logged or timed until both gates let the turn through, and then only if the request is the very one the tutor would make (same conversation, tools and prompt, within ten seconds). A turn the gates stop gets its fixed line as before, and the request is closed before that line is said. The cost is what this changes for the child's data: Anthropic then also receives the words of turns the gates stop, a disclosure of self-harm or abuse included, and is paid for one more request each time. Besides the gates' own providers, which read every turn as before, no other provider receives them, and nothing of the turn is written to Anthropic's prompt cache: the request marks none of it for the cache and carries no camera frame. It is a path for the child's words around the gates, which AGENTS.md rules out, so it is off by default and stays off until the maintainer changes that rule (and ARCHITECTURE.md). LiveKit's own early start is off in every mode: without the talk button (VAD mode) it sent the words to the model before the gates, and the output gate judged text that might never be said. Without the talk button the model is therefore asked only once the gates decide: in the harness (`--mode open-mic`) a reply the model writes then starts about 0.6 seconds later than on `main` at the median, from the end of the child's speech (0.35 seconds later with `AULE_EARLY_REPLY`), while a tool turn's first audio comes sooner. With the talk button LiveKit never started early, so nothing changes there.

With `AULE_VOICE_AHEAD=1`, so that a reply that passes is not then kept waiting for the voice, the voice is given the reply's first sentence while the output gate still judges the reply (`tutor.HeldVoice`): once the model's step is over and has called no tool, so nothing of a step that calls a tool reaches the voice. What the voice makes of it is held, neither heard nor shown, until the gate has approved the whole reply, every paragraph of it; then it is said, and the rest of the reply follows on the same stream. A reply the gate stops and a new press drop it. The voice's provider therefore receives the first sentence of a reply the gate then stops, though nothing of it is played: that is the maintainer's decision, and it is off by default, when the voice gets a reply only once the gate has passed it. A line of the session engine that may repeat the student goes to the voice only once it has passed the gate, whatever the setting. The short lines said while a tool works, fixed and the same for every child, are voiced once, after the opening, and replayed. Such a line is said as soon as the model begins the tool call, which the model's client reports (`providers.TOOL_STARTED`), not once the model has written the call's arguments, which for a drawing takes seconds; the tool still runs once the call is complete, and a call begun by a reply asked early says nothing before the gates let the turn through.

When a gate stops a turn the agent tells the platform which gate, what it did and the categories involved, from a fixed list, at most once per topic every five minutes. Logs and flags carry categories, verdicts and durations only: never what was said, a score, a request or response body, or a key. LiveKit itself writes what the user said in log fields named `lk.pii.*` (the interim transcript when a final one is late, the words of a turn it skips, a tool's arguments); the agent takes those fields off every record before it is written, in the worker process and in each job process (`logs`).

Before real children use it:

- **TypeSafe receives the text of the conversation and the student's age.** The tutor's lines reach it without the student's name, but the student's own words are sent as said. It needs an agreement that covers minors' data, with zero retention and no training, before it is used with real children.
- **OpenAI's moderation endpoint receives what the child says and what the tutor answers.** Its terms must be checked against the requirement in ARCHITECTURE.md that providers allow minors' data with zero retention.
- The check at the start of a session proves that each provider answers and takes the key. TypeSafe's list of models names aliases only, so it cannot say whether `jev-1.14.0` is still served; each verdict checks which model gave it. A provider that goes down after the start gets every turn the fixed reply.
- The verdicts were evaluated on synthetic conversations only ([evals/physical-safety](evals/physical-safety/README.md) and [evals/second-reading](evals/second-reading/README.md), run by hand against the real providers), most of them for an eight-year-old. The gates do not replace an adult nearby.

The agent reports session endings and safety flags to the platform. The platform
publishes `session.ended.v1` for sessions with both a child and a device, and
`safety.flagged.v1` for flags on child sessions, through its transactional outbox.
Browser sessions have no device, so they do not emit that device-session ending
event; their lifecycle is still recorded by the platform.

With the session's end the platform also gets the agent's own numbers, counts and
durations only (`usage`, `timing`): what the model, the hearing and the voice used,
how long the tutor took to answer (`reply_ms`, from the end of speech the voice
detector heard) and, with the talk button, each stage of a turn from the moment the
page's `end_turn` arrives: the commit, the last final transcript (below zero when it
came before the release), the input gates, the model's first chunk and first
sentence, the output gate, the voice's first audio and the tutor's first audio
(`first_audio_ms`), each at p50 and p90. A release whose commit took no words is no
turn and is not timed, and neither is a wait longer than 30 seconds. A final
transcript that comes after its turn was committed, too late for that turn, is
counted (`stt_finals_after_commit`). Each model call is also logged with its token
counts and how many were read from or written to the prompt cache. A request asked
early (`AULE_EARLY_REPLY`) is paid, so its tokens are in the totals, but its stages
are timed only when the tutor uses its reply; `early_calls_dropped` and
`early_input_tokens_dropped` say how many such requests, and how much input, went
unused.

Each call to the model is laid out for that cache just before it is sent (`providers.layout`, around the plugin's own client). The cache is a prefix match over tools, system prompt and messages, in that order, so the system prompt is two marked blocks, the rules (the same for every session of their kind) and the student's part (what is known of them, the plan and the tone, the same all session but for a late plan), and the history, which only grows, is marked where the newest turn ends and where the previous request ended. What changes between turns, the supervisor's guidance and the engine's rules for talk, is read for each request and sent last with the output-language rule after it, unmarked and not kept: at the end of the system prompt, or after the history with `AULE_NOTES_AFTER_HISTORY`. Either way the language rule is the last instruction of every request ([PROMPTS.md](PROMPTS.md)). The tutor still holds the whole prompt as its instructions, updated on every change; a reply is asked with them as they are when it is asked, so a turn whose rules the engine has just changed is answered within them. `tool_choice` is the same on every call, since a change of it drops the cached history.

## When the model fails

A turn the gates let through is never left in silence. When a request for the tutor's reply fails, or is not over within 15 seconds (a hung request is otherwise waited for through each of LiveKit's tries), the student hears a fixed line ("Dame un momentito, se me enredaron las ideas.") and the request is made once more. When that fails too, or at once when the provider refuses the key, the account has no credit left or may not use the model, the student hears a fixed goodbye, the platform records `provider_error` and the session ends. The log then says `tutor model unavailable`, once, as a warning, with the error's type, its HTTP status and why (`authentication`, `billing`, `permission` or `in_a_row`), and nothing of what was said or of what the provider wrote. A step is held whole until it is over, so nothing of a failed one was heard, and a retried reply passes the output gate like any other.

## Mathematical hints and complete replies

Before asserting that one number is smaller, equal or larger than another, the
tutor uses `compare_numbers`. It compares bounded number literals with exact
rational arithmetic, without changing the registered exercise or revealing its
answer. Unsupported inputs return an unverified result. This is a tool for
comparisons, not a general calculator or a guarantee that every model statement
is correct; model adherence still needs evaluation.

The final reply is moderated as a whole, including every paragraph. Blank lines
are not treated as a boundary between reasoning and speech. Provider thinking
stays outside the text stream, and text from a step that calls tools remains
suppressed. A blocked or unavailable output gate still releases only a fixed
reply, never the unchecked paragraphs.

## Checking answers

While an exercise the tutor posed is open, the agent checks the child's answer
to it in code, not only when the model remembers to: once the turn has passed
every input gate, and before the model is asked. The model reads the result in
the conversation as a `check_answer` call and its output, as if it had made the
call itself. A turn the gates stop, a goodbye, a turn the session engine
answers and the show-work button are never checked in code. With
`AULE_EARLY_REPLY=1` no reply is asked early while an exercise is open, since
a request made before the check could not hold it; a reply asked before an
exercise opened (a pose of the reply before, still running) is dropped unheard
once the turn is checked, and asked again with the check in it. With nothing
open, early replies work as before. On the turns it checks, the check adds one
round trip to the platform before the model is asked, part of `first_audio_ms`.

The platform's reader of answers misreads some things today (a number said in
words such as "treinta y uno", an article read as 1, a question that uses the
exercise's numbers), so `answers` sends only two kinds of turn:

- a plain request for help with the exercise ("no sé", "no entiendo", "I don't
  understand", "dame una pista"), sent as the fixed "no sé" or "I don't know";
- an answer written in digits, as the child wrote it, without the exercise when
  they said it again.

To the platform a "no sé" is a hint spent, or a probe failed with the learner
model told, so a line is sent as one only when it says nothing else. "Ayuda",
"no puedo" or "I can't" are not help phrases, "no se" before a verb ("no se
ve", "no se escucha") is not "no sé", and a line with thanks, "sin ayuda", "por
qué", or any word beyond the ones that go with a request for help ("Ayúdame,
tengo miedo", "No sé, mi mamá dice que soy tonto", "I can't hear you") stays
with the model. So does the whole turn after one the gates stopped, or after
any other fixed line of the tutor's: "no sé" to "pide ayuda a un adulto" is
not about the exercise.

Everything else is left to the model, which is told to pass answers in digits:
questions, numbers said in words, reasoning with the exercise's own numbers,
negative numbers, answers to algebra. With speech recognition that writes
numbers as words, a spoken answer is therefore checked by the model; a request
for help is still checked in code. When a child brings an exercise with their
answer before any is open, the answer is checked right after the tutor poses
that exercise, if their words state it as posed.

A right answer to a smaller step the tutor asked ("6" after "¿cuánto es 3 por
2?" in 25 + 3 × 2) is not an answer to the exercise, and the platform would
count it as a wrong try. A lone value of one of the exercise's steps is
therefore left to the model, which is told to follow the checker only when the
reply answers the computation posed. Only the steps of the usual method are
known: a child who works with others (12 as the common bottom of 1/2 + 1/3)
and says one alone is checked as giving a wrong answer, and so is a model that
checks a step itself. So is a line about something else with one number in
digits ("tengo 10 años"), as when the model passes it itself. The fix belongs to
the platform's reader.

An answer to something else the tutor asked is no try at the exercise either,
and the platform would count it as one. So code checks nothing while the tutor
is off the exercise, and the model checks with its own `check_answer`, as it
does whatever code leaves to it:

- after a check whose answer has the tutor work a similar example with other
  numbers first (the platform's worked example, after the last hint), and after
  a pose the platform did not take (a comparison, say), while the exercise
  stays open behind it, until that exercise is posed again;
- in a turn after the tutor said or showed numbers other than the exercise's
  own and the values of its steps, in digits or in words: a worked example, a
  simpler one, a question of its own, the child's wrong answer said back. "Un",
  "una", "uno", "one" and "los dos" are not read as numbers.

The checker is called at most once per child turn and exercise: the model's own
`check_answer` on a turn already checked gets the same answer back. A failure or
a timeout (1.5 s) gives "Not checked: carry on by yourself." and is not retried.
Each turn keeps its own check, and the tools of a reply read the turn that
reply answers, even when a message is typed, or the button pressed, while that
turn is checked: no check is lost, made twice or given to another turn's reply.
What goes to the platform is the child's own words, which it may record with the
attempt, so it goes only after every gate let the turn through. The logs carry
how the turn was read and how long the check took: never the words, nor the
checker's answer.

The policy's one rule on analogies ([prompts.py](src/aule_agent/prompts.py))
keeps the exercise's operations, their order and each number in its role: when
the exercise adds, everything in the story is put together, and nothing is
bought, spent, eaten or given away. Worked examples use different numbers.

## The homework photo

When the session engine waits for a photo of the child's homework (`awaits: "homework_photo"` in its answer), the button that shows work sends the camera's fresh frame to `homework`, never to the tutor's model. The tutor says «Veamos.» and answers the page at once. In the background one `claude-sonnet-5-5` call gets the frame and the question, which is the approved words (`homework.QUESTION`) with the session's course in them (`homework.question`):

- the frame is a JPEG of at most 1024 px, made in memory and sent once, with nothing marked for the prompt cache and nothing else in the request: no name, no conversation;
- thinking is off (`between_tools`), effort low, at most 256 tokens, and the answer is JSON in a fixed schema: what the photo shows, the highest level of the course's exercises in sight and how sure the model is;
- a refusal, an answer cut short, JSON that is not exactly the schema's, a value out of range or no answer within 8 seconds is `unavailable`, which carries no level.

Nothing the model writes is said or shown. The platform is told the outcome, and for a read the level and the confidence (`POST /v1/agent/session/homework`, 3 seconds), and the tutor says the engine's lines; when the platform does not take it, the fixed «No pude mirar tu tarea. ¿Me la muestras otra vez?», and the child can show it again. The frame is dropped once read. What the child says meanwhile waits for the engine to hear of the photo, up to 11 seconds. The log has each read's outcome and time, never the level, the confidence or the image, and the read's tokens are counted with the tutor's model calls, at the same price.

The agent always tells the platform it reads photos (`GET /v1/agent/session?homework=1`), with the talk button or without it: the web page has both the button and a camera. The platform caps what it is told (`AULE_ENGINE_HOMEWORK`, 0 by default) and grants nothing to a session on a device, which has no camera; an older platform ignores it, so nothing changes until the platform asks for a photo. What a photo is read against comes from the platform with the start (`homework`: the engine's topic and what each of its levels is about, from its bank), taken only when it is exactly that (`homework.course_from`). So the levels are described once, in the engine's level files, and a bank for another topic needs no change here; a platform that sends no course gets no photo read. Before it is turned on: one real call to the model, and an evaluation of about 50 labelled photos for accuracy, latency and the engine's threshold of 70.

## Answers to tap

Under a question with a few possible answers the page can show them as buttons ([`contracts/choices`](../../contracts/README.md), on the text-stream topic `aule.choices`). Tapping one is the student's turn: the page sends its words as a typed message, so it passes both input gates like anything typed (`Tutor.typed`) and reaches the session engine or the model as typed words do; several marked go as one turn, joined by commas («1/2, 2/4»).

- **The session engine's** come with its lines (`script.Line.choices`): its fixed words, like the lines themselves, so they are not judged. They are sent once their line has been said to its end, and never for a line that was cut off, that the gate replaced (one that may repeat the student) or that belongs to an answer of the engine that is over.
- **The model's** come from its `offer_choices` tool (two to four short options, and `multiple`), in free sessions and in the turns the engine leaves to the model. They are checked as a visual is: against the contract, then by the gate on what the tutor says, before anything goes to the page; a refusal tells the model why. They are kept until that reply is over, and sent only if the reply passed the output gate with words in it and was heard to its end: a question the gate replaced with a fixed line, one the student cut off or a reply with no words gets none.

Only counts and kinds are logged: never an option.

## Pedagogy regression experiment

The [synthetic pedagogy evaluator](evals/pedagogy/README.md) runs the conversational tutor, tools and safety gates against fixed math scenarios, then compares one proposed instruction change on reserved cases. Paid calls require an explicit live run and share a persistent USD 20 ceiling. A second judge checks that the tutor's examples keep the exercise's meaning, and the report counts whether every turn that code reads as an answer in digits or a request for help was checked in code. The report measures tutoring behavior on scripted text turns; it does not establish learning gains in children or cover voice and IoT. CI runs only its offline tests.

## Intonation

Speech-to-text loses the tune of what was said, so `prosody.measure` takes it from the audio: whether the voice went up, down or stayed level at the end of an utterance, by rule (YIN pitch tracking in numpy, a few milliseconds of CPU per second of audio). A pronunciation drill compares it with `prosody.expected_pattern` of the sentence ("Is it raining?" rises). It is a pure function that does not log, store or send audio, and it is not wired into the tutor yet. It was checked on macOS synthetic voices, native and Spanish-accented, reading short sentences; not yet on real children's voices.

## Settings

### AI observability

Off unless `POSTHOG_API_KEY`, a PostHog project token (`phc_…`), and
`POSTHOG_HOST`, PostHog's EU ingestion (`https://eu.i.posthog.com`, where Aule's
project is), are both set: nothing is sent until then. A value that cannot be
used, such as another host or a personal (`phx_`) key, turns it off with one line
in the worker's log at start, which names the variable and never its value; the
worker runs as before. No token is built into the image or the browser.

Each request of the tutor's model (LiveKit's metrics), and each reading of one
of the tutor's replies by the safety second reader, is a PostHog
`$ai_generation` event with the model's name, token counts, latency and time to
the first token, whether it failed (`$ai_error` is only ever `provider_error`)
or was cut off (`aule_cancelled`), the component (`aule_component`: `tutor` or
`safety_review`) and, for the tutor, which request it was (`aule_request`:
`warm_up`, `early` for one asked while the input gates judged the turn, or
`turn`). LiveKit's prompt counts include the cache; they are sent in Anthropic's
exclusive convention so that PostHog can price them. A request cut off before
its end reports no usage and has no token counts at all: its cost is unknown,
not zero. A request LiveKit retries is not a failed generation, and a failed one
names the model. A reading stopped because its turn ended is a cancellation, not
an error. Costs are estimates per request, not an invoice.
Each push-to-talk turn the session times stage by stage (see above) and the
tutor's model answered is also one `$ai_trace` event when the tutor's first
audio starts, with what each stage took in whole milliseconds (`aule_commit_ms`
to `aule_first_audio_ms`, the latter also as `$ai_latency`). A turn the model
did not answer, such as one the input gates stop, sends none: its stages, with
no model in them, would say so. Whether the turn's answer was checked is left
for later.

The events are pseudonymous. Each turn of the child (a push-to-talk turn, a
typed message or work shown to the camera) draws a random trace id
(`$ai_trace_id`), kept nowhere else, which each step of its reply, the second
reader's reading of that reply and the turn's `$ai_trace` share; a call outside
a turn, such as the warm-up, gets one of its own. There is no session id and no
person: one fixed `distinct_id`, no person profiles. No names, ages, account,
room or platform ids, prompts, replies, tool arguments, images or error messages
are sent. Each event still has its time, which Aule's own records of a session
have too, and a session's requests grow by what each turn adds to the
conversation, so their times and token counts could put a session's turns back
in order. PostHog is therefore declared as a provider: its DPA, the privacy
policy and the international transfer to the EU in the ANPD registration.

No event carries what was said, but which events a turn has, and when, can
still tell something about it, and the declaration says so:

- A turn the input gates stop asks the tutor's model nothing, so it sends
  nothing, not even an `$ai_trace`, like a turn the session engine answers or
  a goodbye: between the events of the turns around it, it is a gap, as a
  pause would be. With `AULE_EARLY_REPLY` (off) it sends the request asked
  early, which the stop usually cuts off (`aule_cancelled`) and which no
  `$ai_trace` follows.
- The second reader's readings of what the child said are not sent: that one
  happened, and how it went, would tell that moderation was unsure of a
  child's words, and when. Their time is still part of the turn's
  `aule_gates_in_ms`, so a slow input gate can hint at one.
- A reading of one of the tutor's replies is sent with its turn: it tells that
  moderation was unsure of that reply, and its counts, its time and whether it
  failed can tell whether the gate then stopped the reply. A failed reading
  always stops it. Without a reading, a reply the output gate stops sends what
  one it lets through does, the same stages included.

An allowlist (`observability.metadata_only`) runs on every event after the SDK
has added its own properties (the system, the library, context tags, session
ids) and keeps only the keys above. Privacy mode is on; GeoIP, exception
autocapture and feature flags are off. The client keeps at most 100 events and
sends them with a one-second timeout and no retries. Every callback catches its
own errors and logs their type only, so analytics never changes a reply or a
gate's decision, and nothing on the voice loop waits for the network: the SDK's
system details are worked out once when the job's process starts (`prewarm`),
and a flush runs in a thread of its own with a deadline. A session's last
events are sent after its own close, which reports the requests it stops,
waiting at most a few seconds.

This covers the Python tutor and the second reader's readings of its replies
only: not the Rust supervisor, embeddings, moderation, TypeSafe or the speech
services. There are no tool spans, and no content-based PostHog evaluation is
possible.

The tests catch the production client's requests at the HTTP layer and check
the host, the exact allowlist and that nothing of the SDK, a session or a person
is sent (`tests/test_observability.py`); over whole sessions with early replies
off and on, one trace id per turn, one `$ai_trace` per timed turn the model
answered, the same stages for a reply the output gate stops as for one it lets
through, and nothing of a turn the input gates stop (but the request asked
early) or of a reading of the child's words
(`tests/test_observability_session.py`); and the last events after the
session's close (`tests/test_worker_join.py`). They do not show receipt by a
live project.

Before turning it on: in the PostHog project, discard client IP data and keep
PostHog AI data processing off; sign PostHog's DPA, and add this use to the
privacy policy and the ANPD registration, with what the events can tell
(above). Then run a synthetic operator session and check, in PostHog's AI
observability, `aule_component=tutor` events with the model, cache counts and
latency, and no content.

References: [manual capture](https://posthog.com/docs/ai-observability/installation/manual-capture),
[privacy mode](https://posthog.com/docs/ai-observability/privacy-mode)
and the [Python SDK](https://posthog.com/docs/libraries/python).

### Environment

Environment variables; `.env.example` at the repository root lists them all.

| Variable | Meaning |
|---|---|
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | The LiveKit server |
| `AULE_STT` | `assemblyai`, `deepgram` or `openai` |
| `AULE_TTS` | `cartesia`, `elevenlabs`, `inworld` or `openai` |
| `ANTHROPIC_API_KEY` | The language model is Claude |
| `ASSEMBLYAI_API_KEY`, `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`, `ELEVEN_API_KEY`, `INWORLD_API_KEY`, `OPENAI_API_KEY` | Only for the providers chosen above |
| `OPENAI_API_KEY` | Also turns on the content-moderation gate, whichever speech providers are chosen |
| `TYPESAFE_API_KEY` | Turns on the physical-safety gate |
| `POSTHOG_API_KEY`, `POSTHOG_HOST` | Optional AI observability: a PostHog project token (`phc_…`) and `https://eu.i.posthog.com`, both or neither |
| `AULE_TTS_VOICE` | Optional voice id |
| `AULE_LLM_MODEL` | Default `claude-sonnet-5-5`. `claude-haiku-5-5` is also set up to speak, with its thinking off; production keeps the default |
| `AULE_LANGUAGE` | `es` (default) or `en`; a session can ask for the other |
| `AULE_SESSION_MAX_MINUTES` | Default 15 |
| `AULE_AGENT_NAME` | Default `aule-tutor` |
| `AULE_PLATFORM_URL` | Optional. Where the [platform](../platform/README.md) is; without it the tutor has no memory of the student |
| `AULE_EARLY_REPLY` | `1` asks the model for a turn's reply while the input gates still judge the turn, so the two waits overlap. Default: the model is asked once both gates let the turn through, as before. Not to be turned on before the maintainer changes AGENTS.md: see [Who it talks to](#who-it-talks-to) |
| `AULE_VOICE_AHEAD` | `1` gives the voice a reply's first sentence while the output gate judges the reply, so the two waits overlap. Default: the voice gets a reply once the gate has passed it, as before. See [Who it talks to](#who-it-talks-to) |
| `AULE_NOTES_AFTER_HISTORY` | `1` puts the supervisor's guidance and the engine's rules for talk, and the output-language rule after them, after the conversation, as a system message (`claude-sonnet-5-5` only), so a change of them leaves the cached conversation readable. Default: at the end of the system prompt, as before. Check in a live session that the tutor never talks about them first (#56) |

The worker refuses to start if a setting is missing and says which. Without both gate keys it starts, warns, and accepts operator sessions only. Once it runs, it asks each configured gate's provider whether it answers and says in its log which one does not and why: a refused key names the setting to check, never its value. A gate with a key always runs: there is no setting to turn it off. Before using a provider with children, check that its terms allow minors' data with zero retention.

## Develop

```bash
uv sync
uv run ruff check . && uv run ruff format --check .
uv run pytest
uv run python -m aule_agent.worker dev
```

`uv run python tests/latency_harness.py --turns 120 --mix free` (or `--mix engine`) measures how long the tutor takes to answer a push-to-talk turn, from the release of the button to the first frame of its answer. The real worker, session, tutor and gates run; every provider is a stand-in with delays drawn from `tests/fakes.py`, no paid service is called and no connection leaves the machine. It prints JSON, with counters that must stay at zero (audio before the input gates, a sentence heard that no gate approved, the child's words in a log, an answer checked before the input gates, for a stopped turn or twice against one exercise, a request to the model before the gates while an exercise was open). `--exercises` is the share of free sessions whose platform opens the exercise the model poses, so that the child's answers are checked in code after the gates (half by default; `--exercises 0` runs the sessions as before). `--mode open-mic` drives sessions without the talk button, timed from the end of the child's speech; `--playout-speed 1 --gap 2,8` plays the tutor in real time and leaves the child time to think, so that idle connections close as they would; `--second-reader` sets how often moderation is unsure and the second reader reads a turn or a reply (5 % and 2 % by default). `tests/test_latency_invariants.py` runs the same kind of sessions faster and proves the safety invariants on them.

`uv run python -m aule_agent.worker check` asks the gates' providers once, with the worker's settings, as a worker does when it starts, and exits 0 only when a child's session could start. It calls the real providers (the free moderation endpoint and TypeSafe's list of models) and joins no room. The agent's image has no `uv`: there it is `python -m aule_agent.worker check`.

The contracts are read from `contracts/` at the repository root, or from `AULE_CONTRACTS_DIR` when the agent runs outside the repository (for example, in a container).

### Participant departure

For child sessions, `RoomOptions.close_on_disconnect` is disabled. A 120-second
grace period preserves the tutor through a page reload; the original session
clock keeps running. Departure interrupts output and clears uncommitted input;
the same participant returning cancels the grace timer. An explicit web end
closes the platform session and deletes the room. Operator sessions keep the
SDK's immediate disconnect behavior.

Cleanup reports fixed end reasons for the deadline, inactivity, a goodbye,
provider failure or a participant that did not return. A previously recorded
platform closure reason wins. Provider exceptions and conversation contents
are never included in these status messages. Tests use synthetic participants;
no physical IoT device has been validated for the reload UI.
