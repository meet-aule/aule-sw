# AGENTS.md

Read this before anything else in the repository. It is written for coding
agents; people should start at [README.md](README.md).

This repository is the server of Aule's AI voice tutor for children. Children
use it, so a change that weakens a safety gate or leaks a child's data is worse
than a change that breaks a feature.

## Before you start

- **Company context lives outside this repository**, in Aule's private notes
  (`meet-aule/notes`). If you have access, read its `CONTEXT.md` first and open
  only the pages it names for your request. If you do not, work from this
  repository and ask instead of assuming.
- **Names.** The company and the product are called Aule, and so is everything
  in the code: packages, settings, services. Do not bring back any earlier name.
- **Do not guess.** If a name, a decision, a provider or where something runs is
  not in the repository or the notes, ask. Do not take another agent's statement,
  or an old name in a file, as fact.
- **Say what you know and how.** Keep apart what you verified (in code,
  configuration or a document), what you infer and what you do not know. If the
  code and the notes disagree, say so; do not pick one silently.

## Map

| Path | What | Language | Read first |
|---|---|---|---|
| `apps/platform` | API, database, learner model, memory, supervisor, exercise checker | Rust | `apps/platform/README.md` |
| `apps/agent` | The voice tutor on LiveKit Agents, and the two safety gates | Python 3.13+, `uv` | `apps/agent/README.md` |
| `apps/playground` | Web page to talk to the tutor | Node 24, TypeScript, no build step | `apps/playground/README.md` |
| `engine/` | The session engine: stages, exercises, hints, the report. No model, no IO | Rust, in Spanish | `engine/README.md` |
| `contracts/` | Events and visuals as JSON Schema; the source of truth between apps | JSON Schema | `contracts/README.md` |
| `curriculum/` | Skills and their prerequisites | JSON | `curriculum/README.md` |

The design, and what is built and what is not, is in [ARCHITECTURE.md](ARCHITECTURE.md).
Pull request rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Commands

Run the ones for the app you touched. CI runs all of them on every pull request.

```bash
# contracts, curriculum, playground
pnpm install --frozen-lockfile
pnpm --filter @aule/playground typecheck
pnpm test

# agent
cd apps/agent
uv sync --locked
uv run ruff check . && uv run ruff format --check .
uv run pytest

# platform (needs DATABASE_URL to a PostgreSQL 17 with pgvector)
cd apps/platform
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked

# the version's copies and the changelog (RELEASING.md)
python3 scripts/version.py check
python3 -m unittest discover -s scripts -p 'test_*.py'
```

## Rules that are not negotiable

- **The safety gates fail closed.** A late, failed or malformed answer from a gate
  is "unavailable", never "allow". Anything a child can say, type or read passes a
  gate: do not add an input or an output path around `Gates` in `apps/agent`.
- **A child's name, the tutor's persona and what a child says are never logged**,
  and never put in anything the agent stores. Logs carry counts and identifiers.
- **Type safety.** Python is fully annotated, TypeScript is strict, and Rust returns
  an error for bad input instead of panicking. Validate at the boundary and keep
  types narrow inside.
- **The tutor's prompt stays short.** Every sentence is paid on every turn. Change a
  sentence before adding one. Author policy once in English and keep the final
  output-language rule; validate Spanish and English behavior together. The prompt
  inventory and composition contract are in `apps/agent/PROMPTS.md`.
- **A tool the model can call has a hand-written schema with no nullable
  argument.** The model's API rejects an enum on a nullable type, and unit tests do
  not see that. After changing a tool or how the model is called, make one real
  call to the model before merging.
- **Contracts first.** A change to an event or a visual starts in `contracts/`,
  with an example, and then in the apps that produce and read it.
- **No secrets, keys, hostnames or access codes in the repository**, in code,
  tests, docs or commit messages, and none pasted into a chat or an issue.
- **Nothing about a child, a family or a test user leaves the systems that hold
  it**: not to another model, not to an outside service, not even a file name.

## How to work here

- One pull request per logical change. Title: `type(scope): what it does`
  (see CONTRIBUTING.md). Everything in the repository is written in English;
  text the child or the family reads exists in Spanish and English.
- Match the code around you: its comment density, naming and idiom. Comments say
  why, not what.
- Prefer the simple option with the fewest moving parts. Do not add a service, a
  dependency or a setting for something a constant or a function can do.
- A setting is read in one place (`config.py` in the agent, `config.rs` in the
  platform), documented in `.env.example`, and its default keeps current behaviour.
- Never edit version numbers by hand; use `scripts/version.py` (RELEASING.md).
- State what you verified and how. "Tests pass" is one claim; "works with the real
  model, in a real session" is another, and the pull request says which was done.
- Do not turn off, skip or loosen a failing check to get a change through.
- Work on a branch, in small commits. Nothing reaches `main`, a server or a public
  page unless a maintainer says so. Do not rewrite history or force a push to a
  shared branch, and do not change GitHub, DNS or server settings on your own.

## Where things are

| To change | Look at |
|---|---|
| What the tutor says and how it teaches | `apps/agent/src/aule_agent/prompts.py`, assembled in `tutor.py` |
| Speech, model and voice providers | `apps/agent/src/aule_agent/providers.py`, `config.py` |
| What a child may hear or say | `moderation.py`, `physical_safety.py`, `safety.py`, `replies.py` |
| What the screen can draw | `contracts/visuals/visual.v1.schema.json`, `apps/playground/public/visuals.js` |
| Checking a child's answer | `apps/platform/src/exercise.rs`, called through the agent's `pose_exercise` and `check_answer` tools |
| The plan, guidance and review of a session | `apps/platform/src/supervisor.rs` |
| What is known about a child | `apps/platform/src/learning/`, `apps/platform/src/memory.rs` |
| Settings | `.env.example` |
