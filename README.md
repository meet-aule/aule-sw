# Aule Server

<p>
  <a href="https://github.com/meet-aule/aule-hw"><img src="https://img.shields.io/badge/Hardware-aule--hw-1f6feb.svg" alt="Aule hardware"></a>
  <a href="https://github.com/meet-aule/aule-fw"><img src="https://img.shields.io/badge/Firmware-aule--fw-2da44e.svg" alt="Aule firmware"></a>
  <a href="https://github.com/meet-aule/aule-sw"><img src="https://img.shields.io/badge/Server-Aule-d97706.svg" alt="Aule server"></a>
  <a href="https://github.com/meet-aule/aule-app"><img src="https://img.shields.io/badge/App-aule--app-8250df.svg" alt="Aule app"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="Apache 2.0"></a>
</p>

**Aule is the open-source AI tutor.** This repository runs its browser tutor and provides the APIs for families and devices.

A tutor for children should not stop working when a company changes its plans. So the server is open too: you can run it at home, at a school, or use the one Aule hosts.

## What it does

- **The voice tutor.** A [LiveKit Agents](https://github.com/livekit/agents) worker joins the session's room, listens, thinks and answers out loud. It keeps turns short and patient, asks before it explains, and does not hand out answers.
- **The browser experience.** Families sign in, manage students and consent, and start voice or typed sessions with exercises and a device-style display. The team has an administration panel. Reload recovery can rejoin a still-running tutor within the room's departure window.
- **Devices.** Links a new device to its family, issues per-device credentials and room tokens, and serves firmware updates over the air, speaking the bootstrap protocol of [xiaozhi-esp32](https://github.com/78/xiaozhi-esp32) that the [firmware](https://github.com/meet-aule/aule-fw) is built on.
- **Families.** The API used by the browser and intended for the planned [mobile app](https://github.com/meet-aule/aule-app): setup, progress, invitations, consent, privacy settings and deleting a child's data.
- **A model of what each child knows.** An open learner model estimates, skill by skill, what a child has mastered and what they are forgetting, and picks what to work on next. It needs no language model and can be corrected by a parent or a teacher.
- **A supervisor.** A second model plans each session, follows it without slowing the conversation down, and afterwards turns it into progress, memories and a note for the family.
- **Memory.** The tutor remembers what matters about a child between sessions, with embeddings computed on your own server.

## Running it yourself

The Compose stack runs the platform, background worker, voice agent, playground,
PostgreSQL with pgvector and local embeddings. It uses Linux host networking;
run a LiveKit server and an HTTPS reverse proxy separately. The browser needs
HTTPS for microphone and camera access.

Copy `.env.example` to `.env` and configure the database, LiveKit, platform,
sign-in and selected model providers before starting. Child sessions also need
both safety gates configured and reachable; see the [agent guide](apps/agent/README.md).

```bash
docker compose up -d --build
docker compose exec embeddings ollama pull bge-m3  # once, for the default embedding model
```

Use the [platform](apps/platform/README.md), [playground](apps/playground/README.md)
and [server operations](infra/server/README.md) guides for settings and deployment.

## Privacy by design

These are requirements for the code that lands here:

- No training on children's data.
- Audio and camera frames are processed for the session and are not recorded by this application. The platform temporarily stores turns for the session review, then deletes them unless the guardian consented to transcript retention; consent withdrawal and account deletion also remove derived data.
- Provider support in code does not establish zero retention or permission to process minors' data. Operators must verify those agreements and account settings before using a provider with children; the [agent guide](apps/agent/README.md#who-it-talks-to) records the remaining checks.
- A device whose microphone switch is off sends nothing: the switch is in hardware, and the server never asks to bypass it.

## Status

In active development. Family sign-in by email code and configured identity
providers, student profiles, consent, plans, sessions, reviews, notices, the
learner model and local vector memory are implemented. Both safety gates are
implemented and fail closed; a child's session cannot start unless their
providers pass the startup checks. Device registration, activation, signed
session requests and firmware-update routes exist, but a physical device has
not been validated end to end by this repository's tests.

The [session engine](engine/README.md) can run supported topics with deterministic
exercises, hints and a report. [ARCHITECTURE.md](ARCHITECTURE.md) separates built
features from gaps and validation limits. The mobile family app is a separate,
planned project; the browser playground is the current family interface.

Operational tooling includes backups, restore checks and internal/external
[health monitors](infra/watch/README.md). Install these scripts separately from
Compose; merging their code does not update a running server.

## Repository layout

```text
apps/
  platform/   the API and the worker: children, consent, sessions, learning, memory, supervisor (Rust)
  agent/      the voice tutor on LiveKit Agents (Python)
  playground/ a web page to talk to the tutor with a microphone and a camera (Node, TypeScript)
contracts/    the events they exchange, as JSON Schema
engine/       deterministic session stages, exercises, hints and report (Rust)
curriculum/   skill catalogs and prerequisites
infra/        deployment, backups, health monitors and edge routing
research/     reproducible experiments, separate from operational learner models
compose.yaml  everything above with its database, next to your LiveKit server
```

```bash
pnpm install --frozen-lockfile && pnpm test  # contracts, curriculum and playground
(cd apps/agent && uv sync --locked && uv run pytest)
(cd engine && cargo test --locked)
(cd apps/platform && cargo test --locked)  # needs DATABASE_URL to PostgreSQL with pgvector
```

Coding agents: read [AGENTS.md](AGENTS.md) first.

The [student performance benchmark](research/student-performance/README.md)
evaluates grade prediction on public data and includes an offline explorer.
It does not outperform repeating the previous grade and is not used by the tutor.

## How the pieces fit

```
aule-hw   the device: board, e-ink, audio, enclosure
aule-fw   firmware: xiaozhi-esp32 + a LiveKit (WebRTC) transport
aule-sw   central server: voice tutor, devices, family API     (this repository)
aule-app  the family app: set up the device, see progress, privacy controls
```

## License

Apache License 2.0. See [LICENSE](LICENSE).

---

Made in Lima, Peru by [Aule](https://meetaule.com) · admin@meetaule.com
