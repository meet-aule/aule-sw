# Agent

Aule's voice tutor: a [LiveKit Agents](https://github.com/livekit/agents) worker in Python. It joins a room when asked by name, listens, and answers out loud. When the person's camera is on, the tutor also gets the latest frame with each turn, so it can look at a notebook.

## What is here

| Module | What it does |
|---|---|
| `worker` | The LiveKit worker: one tutor session per room it is dispatched to, with a time limit |
| `tutor` | The tutor's instructions, and where the gates and the camera plug into a turn |
| `safety` | Who a session is for, and the two safety gates of [ARCHITECTURE.md](../../ARCHITECTURE.md) run together on every turn |
| `moderation` | The content-moderation gate: what the person said and what the tutor is about to say |
| `physical_safety` | The physical-safety gate: whether what the person said needs a nearby adult |
| `replies` | The fixed replies a person hears when a gate stops a turn, in Spanish and English |
| `visuals` | What the tutor can show on the student's screen, checked against the shared contract before it is sent |
| `camera` | The latest camera frame, held in memory and never stored |
| `prosody` | Whether the voice went up or down at the end of an utterance, measured from the audio by rule, for pronunciation drills |
| `providers` | Builds the speech and language models from the settings |
| `platform` | Gets the student's profile and the supervisor's plan, reports turns and safety flags in the background, applies guidance |
| `config` | Reads and checks the environment |
| `events` | Wraps what the agent reports in the shared [contracts](../../contracts/README.md) |

## Who it talks to

A session is for a child unless the server that created the room marked it `{"audience": "operator"}` in the dispatch metadata. The agent refuses a child's session unless both safety gates are configured. In an operator's session (an adult on the team, through the [playground](../playground/README.md)) the gates that are configured run and the others are skipped.

The two gates:

- **Content moderation** uses OpenAI's moderation endpoint (`omni-moderation-latest`) with thresholds set for children, plus a short local list of phrases that must not depend on a provider. It checks what the person said before the tutor answers, and the tutor's whole reply before any of it is spoken.
- **Physical safety** uses [TypeSafe](https://typesafe.ai)'s Jev model (`jev-1.14.0`). It checks what the person said, with the text of the recent conversation as context, at the same time as moderation; the tutor waits for both.

Both fail closed. If a gate fails, is late or answers something the agent does not fully understand, the person hears a fixed reply and the unchecked text is never answered or spoken. The fixed replies depend on what happened: a redirection, support for self-harm or for a child's sexual safety, a request to get a nearby adult for a physical hazard, a request to rephrase when the physical-safety verdict is uncertain, or a plain "I can't answer safely right now".

When a gate stops a turn the agent tells the platform which gate, what it did and the categories involved, from a fixed list, at most once per topic every five minutes. Logs and flags carry categories, verdicts and durations only: never what was said, a score, a request or response body, or a key.

Before real children use it:

- **TypeSafe receives the text of the conversation.** It needs an agreement that covers minors' data, with zero retention and no training, before it is used with real children.
- **OpenAI's moderation endpoint receives what the child says and what the tutor answers.** Its terms must be checked against the requirement in ARCHITECTURE.md that providers allow minors' data with zero retention.
- A session starts when both gates are configured; the agent does not probe that the providers answer before it starts. If one is down, every turn gets the fixed reply.
- The physical-safety gate is told the age is unknown: the dispatch does not carry the child's age yet.
- The verdicts were evaluated on synthetic conversations only ([evals/physical-safety](evals/physical-safety/README.md) and [evals/second-reading](evals/second-reading/README.md), run by hand against the real providers). The gates do not replace an adult nearby.

Not built yet: publishing `session.ended` and `safety.flagged` as events.

## Intonation

Speech-to-text loses the tune of what was said, so `prosody.measure` takes it from the audio: whether the voice went up, down or stayed level at the end of an utterance, by rule (YIN pitch tracking in numpy, a few milliseconds of CPU per second of audio). A pronunciation drill compares it with `prosody.expected_pattern` of the sentence ("Is it raining?" rises). It is a pure function that does not log, store or send audio, and it is not wired into the tutor yet. It was checked on macOS synthetic voices, native and Spanish-accented, reading short sentences; not yet on real children's voices.

## Settings

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
| `AULE_TTS_VOICE` | Optional voice id |
| `AULE_LLM_MODEL` | Default `claude-sonnet-5-5` |
| `AULE_LANGUAGE` | `es` (default) or `en`; a session can ask for the other |
| `AULE_SESSION_MAX_MINUTES` | Default 15 |
| `AULE_AGENT_NAME` | Default `aule-tutor` |
| `AULE_PLATFORM_URL` | Optional. Where the [platform](../platform/README.md) is; without it the tutor has no memory of the student |

The worker refuses to start if a setting is missing and says which. Without both gate keys it starts, warns, and accepts operator sessions only. A gate with a key always runs: there is no setting to turn it off. Before using a provider with children, check that its terms allow minors' data with zero retention.

## Develop

```bash
uv sync
uv run ruff check . && uv run ruff format --check .
uv run pytest
uv run python -m aule_agent.worker dev
```

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
