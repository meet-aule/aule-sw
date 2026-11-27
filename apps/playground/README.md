# Playground

Aule's browser interface for families and students. Families sign in, set up a
student and consent, and start tutoring sessions with voice, typing, exercises
and an optional camera. The team works from its own console at
https://admin.meetaule.com ([apps/admin](../admin/README.md)), and the home
shows the team a link to it. A separate access-code API supports operator tests.

The Node server serves the page, handles sign-in and cookies, and calls the
[platform](../platform/README.md) for accounts, consent, plans, session lifecycle
and progress. It has no database of its own. Family sessions are child sessions:
the [agent](../agent/README.md) requires both safety gates. Access-code operator
sessions use a separate path and do not replace family authorization.

In a session, Aule's face is at the centre of the screen, on a stage, with one line under it that says whose turn it is. The face is a cuy with glasses in pixel art: a character (`public/cuy.js`) for the [wobnimo](https://github.com/Pouryaak/wobnimo) mascot engine, shown in pixels by `public/pixels.js`, whose mouth moves while Aule's voice sounds (FIGMA.md D37). `npx wobnimo check public/cuy.js` checks the character and `npx wobnimo preview public/cuy.js` draws it in every state. When the tutor shows something (an exercise, fraction bars, a number line...), the page draws it on the stage from the description it receives, and the face moves to a band at its bottom until the next drawing, a new exercise or the end; `public/visuals.js` is that drawing code, a plain function from the description to SVG. FIGMA.md D30.

The page's screens follow the Figma file «Login-Aule» v8, with the owner-requested usability adaptations documented in D42–D43: the parent's on paper (one entry with email and providers, the emailed code with a name only for a new account, the authorisation, the child's name and, if the family likes, their grade), then the child's in the device's black on white (the hand-off «¿Eres tú?», what today's session is for, the microphone before it, the session). [FIGMA.md](FIGMA.md) maps each screen, component, token and icon to the code, and says where the page differs from the file.

Family screens and the guide use a subtle, static CSS paper texture (FIGMA.md
D38), disabled for increased contrast, forced colours and printing. The PNG
installation icons are losslessly compressed: their pixel data and transparency
are preserved, and all four together weigh 4,274 bytes.

### A child's first steps

- **The road there.** New and returning families use the same entry, with the email field beside the configured providers. The code screen asks for the parent's name only after a valid code for a new account; the platform rechecks that code when creating the account. Consent and the child's profile stay separate, with both storage choices unticked. The shortest new-family path to the microphone check is 7 screens by email (formerly 9), 6 by Google (formerly 7); choosing a subject adds the same details screen as before. Optional interests and expectations remain on the home after the first session. The entry and its code step have a layout of their own: the title over one card of ways in and, from 960 px, the pixel cuy dancing in a panel beside it. They alone are near-dark where the system asks for dark, and on paper otherwise; the one switch is the `prefers-color-scheme` block of `public/style.css`. The card's ways in are rows of one size: Google's is the page's own with Google's button unseen over it, and GitHub, Apple and Facebook always show, as «Pronto» where the server does not have them yet. FIGMA.md D34, D42, D45, D46.
- **The hand-off.** «Empezar su primera sesión» hands the browser to the child: «Ahora le toca a {nombre}.», «¿Eres tú?» and the name, with «Sí, soy yo» and «No soy yo» (which opens Configurar for the name). It follows César's A02; FIGMA.md D25.
- **The microphone check (A05).** A05 asks the browser for the microphone alone. A bar moves with its level, and once a voice has been heard the line beside Aule's face says «Te escucho.»; with no voice it gives one hint at a time, and a microphone the browser will not give is named (blocked, missing or busy) with «Intentar otra vez». «Probar el sonido» plays the chime Aule joins with. The level is worked out in the browser by an AnalyserNode that is not connected to anything: no sound leaves the device, is played back or kept. The check never holds back «Empezar la sesión». FIGMA.md D26.
- **The camera, off until it is needed.** A05's camera starts off and the browser is asked for it only when it is turned on; there it only shows what it sees. A session never turns it on by itself, as it joins or as the tutor comes in. «Mostrar mi tarea» works in two steps: the camera turns on and the stage shows all of what it sees, on this device only, while the child points it at their work; «Listo» publishes that same camera (the browser is not asked twice) and asks the tutor to look, and the camera goes off 1.5 s after the picture; «Cancelar», or 30 seconds with nothing, turns it off. The keyboard goes to the line that says what to do, never to «Listo», and with hold to talk Space never presses the camera's buttons. No picture leaves the device until «Listo»; then one frame is used and none is stored. With a tutor that takes no pictures, the session's «Cámara» turns it on and off once the tutor is in. FIGMA.md D12, D31.
- **The first turn.** On a first run (the child said «Sí, soy yo» in this visit, or the family's trial has not started) the session's title is A16's «Hola, soy Aule» and «Soy tu tutor. Soy una inteligencia artificial.». With hold to talk, a line right above the button teaches holding until the first good hold (fixed with the button on every phone held upright, and in the right-hand column on a short screen from 560 px, so nothing covers the session's controls); it waits while the child aims the camera. A press too short to carry a voice gets a hint. FIGMA.md D27, D28.
- **When Aule does not arrive.** After 15 seconds the session says so, with «Intentar otra vez», which closes the attempt and goes back to A05. A session Aule never came to does not count: the platform's plan counts only a session its tutor started, and the page gives the day's session back when such a session is closed (`api/session/end`, at most `PLAYGROUND_DAILY_SESSIONS` times a day). FIGMA.md D29.

The words of these steps are in `public/first-steps.js`, in Spanish and English, written in the student's language, from A04 and A05 to the session's line under Aule's face and its own words around the stage («La sesión empezó.», «Terminar», «Enviar», the conversation's «Tú»): one short sentence an element, and, for a microphone or a camera only an adult can fix, a smaller line for the adult under the child's (FIGMA.md D33). `public/session-messages.js` has the endings' and the recovery's words, one sentence each too. First run is held in the page's memory only: nothing new goes into the browser's storage.

### What a family sees after a session

The student's ending screen shows the same pixel-art cuy at rest above its title and explanation, with the return or reconnect controls below. It reuses the session's character and renderer, without loading another image or opening a room.

Back on the home, each student's row says what their last three sessions were: the day and the minutes, the skills practised or what the session was for, how many exercises were practised (not how many were right: a child lands on the home too), the breaks, and an ending that was not the ordinary one («Hoy · 6 min Sumar hasta 20 · 3 ejercicios · 1 pausa»). «Ver resúmenes» under each child opens a separate reading screen (`public/reviews.js`), with the latest five summaries and their next steps, an empty state while none are ready, and refresh/retry. It reuses the guardian-scoped `api/student/known` read, renders only the summaries as text, and clears them on leaving or signing out; stale responses cannot populate another child's screen. Configurar keeps the profile and memory controls. The home itself still shows only facts, never the review's words. FIGMA.md D43. The lines come from `api/student/sessions`, which reads the platform's guardian-scoped `GET /v1/children/{id}/sessions/facts` and keeps only those facts: never the transcript, anything said or typed, the topic written on A04 · Detalles or the review's words (`src/students.ts` `latestSessions`, `public/summaries.js`). On a first run the session says so to the child too: «Tu papá o mamá recibe un resumen de lo que hacemos.» FIGMA.md D28, D35.

Mobile examples with synthetic data: [shared entry](screenshots/entry.png) and
[session summaries](screenshots/summaries.png). These are documentation images,
not public assets served to families.

### The cookie notice

The paper screens say once which cookies the page uses: only its own and only the necessary ones, none for advertising: the account's and the session's and, for a family that came by an invitation, that link's until they sign in, with the policy's cookie section linked. It is a slim bar along the bottom edge of a phone or of a screen under 600 px tall, and a card from 481 px; «Entendido» is remembered in this browser (`aule.cookies`), and while it shows the paper screens end just above it, so the footer starts behind it. FIGMA.md D36.

## Settings

| Variable | Meaning |
|---|---|
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Signs the room tokens |
| `AULE_LIVEKIT_PUBLIC_URL` | The LiveKit URL as the browser reaches it (falls back to `LIVEKIT_URL`) |
| `PLAYGROUND_ACCESS_CODE` | At least 16 characters. Whoever has it can start a session through the API; the page does not offer it |
| `PLAYGROUND_PUBLIC_URL` | Optional. Where people reach the page; GitHub, Meta and Apple sign-in come back to it, and are offered only with it and with their settings on the platform |
| `PLAYGROUND_HOST`, `PLAYGROUND_PORT` | Default `127.0.0.1:8090` |
| `PLAYGROUND_BASE_PATH` | Default `/playground` |
| `PLAYGROUND_SESSION_MINUTES` | How long a token lasts. Default 20 |
| `PLAYGROUND_DAILY_SESSIONS` | Daily cap per signed-in account. Default 3; the platform also enforces the family's plan |
| `AULE_FREE_ACCESS` | `1` bypasses plan/trial quotas and the browser's daily cap when set on both platform and playground. Authentication, consent, safety gates and individual session deadlines remain enforced |
| `PLAYGROUND_ENGINE` | `1` asks the platform to run supported topics through the session engine |
| `AULE_AGENT_NAME` | The agent to ask for. Default `aule-tutor` |
| `AULE_PLATFORM_URL`, `AULE_ADMIN_TOKEN` | Required for the family experience. Sessions are created by the [platform](../platform/README.md); sign-in uses emailed codes and configured Google, GitHub, Facebook or Apple providers |
| `PLAYGROUND_CHILD_ID` | Optional, with a platform: a child profile to try the tutor with. Its guardian must have consented to `voice` |

Put it behind a reverse proxy with HTTPS: browsers only give the microphone and the camera to secure pages.

The team's panel moved to its own console, https://admin.meetaule.com. Its old
addresses, `<base path>/admin` and `/admin`, with or without a trailing slash,
answer a 302 to exactly that address, and pass nothing of the request on; the
old `api/admin/*` routes, `admin.js` and `pilot.js` are gone (404). An
unknown page opened by a browser returns to the start page. Unknown API routes,
files and write requests keep their error responses. These redirects are not
cached and do not accept a destination from the request.

### Links per source and the family guide

A link to the page can say where it was shared: `<page>/?src=cesar`. While
nobody is signed in, the page, and the family guide, keep a short lower-case
code (letters, digits and hyphens, starting with a letter, 24 at most) in an
HttpOnly cookie, `aule_source`, for 30 days; anything else in `src` is ignored.
The next sign-in, by any provider, passes it to the platform, which keeps it
on the family it creates, and the cookie is cleared. Every redirect on the way
keeps the query: the bare host's (the Worker in `infra/edge`), the base path's
and the guide's.

The guide for families is `<base path>/guia`, and in English `<base path>/guide`:
two static pages in the paper look, with no script. They are also reached
with a trailing slash or without the base path. They say how to
sign in, the trial, what a session is like, the plan and how to continue after
the trial in the landing's words, and privacy in two sentences; change both
together.

Rooms wait up to two minutes after a network disconnect so LiveKit can rejoin
the same session. This applies both with the platform and to operator sessions
issued by the playground. The page shows its reconnecting state while the SDK
retries; a failed recovery still reports that the connection was lost. Reload
recovery for families is described below; an ended tutor cannot be resumed.

## The family app's API

The family app ([meet-aule/aule-app](https://github.com/meet-aule/aule-app))
reaches the platform, which listens only on its own machine, through this
server: `<base path>/api/v1/<path>` goes on to the platform's `/v1/<path>`. In
production that is `https://playground.meetaule.com/session/api/v1`. The list
is in `src/passthrough.ts`.

- **Only the app's calls.** Signing in by code or with Google, signing out,
  `me`, adding a child, a child's profile, consents, reviews, skills, sessions
  and memories (with `limit`) and forgetting one, the skill catalog, a
  session's state and ending it, the notices and the family's devices. Anything
  else is a 404 that reaches nothing: starting a session, the team's routes,
  the metrics, the agent's, the devices' own (`ota`) and the health check, and
  so is another method or an address that is not quite one of these. Each part
  of an address is a word of its route or an id; a query is the route's own
  number, once, or a 400.
- **Only the bearer.** Of the request's headers only `Authorization` (`Bearer`
  and a session's token) and `Content-Type` go on, with the page's own
  `User-Agent`; a cookie, an address or anything else the request carried stays
  here, and of the platform's answer only its status, its type and its body
  come back. Without a bearer only signing in goes on (401 otherwise); the
  operator's token is refused with the answer a wrong token gets, and a line in
  the log that says it was tried.
- **Bounded.** A body is JSON of 16 KiB at most (413, and the connection closes)
  sent within 10 seconds (the connection closes otherwise); the platform has 10
  seconds to answer (503 otherwise). The refusals are in the platform's error
  shape, `{"error": {"code", "message"}}`.
- **Nothing of a request is logged**, only a route's shape when the platform
  does not answer: never a token, an id or a body.

The page's Worker (`infra/edge`) passes these addresses on as it does every
other, the bearer and the body included. From Cloudflare to the server the hop
is still plain http, as it is for the page's cookie (`infra/server/README.md`),
so the app's bearer crosses it unencrypted until a tunnel or a certificate at
the origin closes it.

## Boundaries

- The platform owns accounts, consent, transcripts, retention and learning records. The browser server has no database; its cookies carry sign-in, source attribution and encrypted recovery state.
- The page does not record audio or camera frames. Live media and typed turns still reach the tutor and its configured providers; the platform processes turns for review under its retention rules.
- Without a platform, only access-code operator tests are available. Ten wrong access codes in a minute lock that code endpoint until the minute passes.
- A browser device-screen simulation does not validate physical firmware, a hardware microphone switch or an IoT network connection.

## Develop

Node 24 runs the TypeScript sources directly.

```bash
pnpm install --frozen-lockfile
pnpm --filter @aule/playground typecheck
pnpm --filter @aule/playground test
node --env-file=../../.env src/server.ts
```

## Testing as on the device

- **Device screen** («Modo tinta», a switch under the session's stage, shown only to Aule's team and on for them) shows the drawing as the device's panel would: the panel's frame, snapped to black, white and one grey, with a flash on every redraw, and the exercise in hand drawn as well as written. It does not imitate ghosting. Families never see it (FIGMA.md D32).
- **Hold to talk** appears when the tutor sets the participant attribute `aule.turns` to `manual`. The microphone is then closed except while the button (or the space bar) is held; Space talks wherever the focus is not on another control, and on «Mostrar mi tarea», «Listo» and «Cancelar» too (Enter presses those): pressing calls the tutor's `start_turn`, letting go calls `end_turn`, and losing the button or the window calls `cancel_turn`. The microphone switch is the device's mute: while it is off nothing is sent. While the button is held, a bar inside it follows the microphone's level, measured in the browser.

- **Typing** to the tutor works at any time, next to speaking. A typed message passes the same safety gates as a spoken one.
- **Answers to tap** come under Aule's question when it has a few possible answers: the engine's (such as «Sí» to «¿Empezamos?», a break's activities or «No tengo mi tarea») or the tutor's model's, once the question has been said. A tap is the student's turn, sent as a typed message, so it passes the same safety gates; where several may be marked, «Listo» sends them as one turn, joined by commas. Once answered, or once the conversation moves on, they cannot be pressed. FIGMA.md D44.
- **Report for the family**: with the team box ticked and a platform, the page shows, after the session ends, the summary and next step the review wrote for the family.

### Reload recovery and session endings

A signed-in family can reload, select the same student and choose «Seguir con
la sesión» within the room's 120-second departure window: that student goes
straight to A05, which asks «¿Seguimos donde nos quedamos?» (FIGMA.md, D22).
The agent stays alive with its conversation context; an abandoned partial
push-to-talk turn is cancelled. Resume uses the same room and participant
identity, with no agent dispatch, no new platform session, no extra quota charge
and no clock reset. Another tab that is still connected must leave before resume
succeeds. Choosing a new session («Empezar otra sesión») explicitly closes the
previous one first, then asks A04 what the new one is for, as any new session is.

The browser holds an encrypted HttpOnly/Secure/SameSite=Strict cookie scoped to
the app. It contains only room routing, the student identifier, a hashed sign-in
owner and the original deadline, never a room JWT, dispatch metadata, names or
transcripts. There is no BFF ticket cache to lose on a restart or evict when full.
AES-256-GCM authenticates the cookie; HKDF derives a separate key from the existing
LiveKit credentials and binds the ticket to the app's base path. These use
[Node's crypto primitives](https://nodejs.org/docs/latest-v24.x/api/crypto.html).
No new secret, database, volume or service is needed.

Each recovery still rechecks family authorization, voice consent, remaining time
and the live tutor. The ticket is routing, never permission to join: platform
revocation or closure wins even if an old cookie is replayed. Tickets expire five
minutes after the deadline so the final reason can be read; those extra minutes
never allow a resume. Rotating the LiveKit credentials, changing the base path or
deploying this format over the old RAM tickets invalidates old tickets. Deploy
when rooms are idle. A tutor restart still loses its in-memory conversation;
this recovers a live tutor across a BFF restart, not an ended tutor. Operator
access-code sessions do not support reload recovery.

When signalling or media reconnects, a held microphone is muted locally at once.
Pending microphone starts and delayed releases cannot submit the interrupted
turn. On return the page asks the tutor to cancel partial input, then a fresh
press starts a new turn; automatic turns still respect the microphone switch.
The original clock continues. Tests cover HTTP recovery after recreating the BFF,
tampered tickets, revocation, and delayed microphone/RPC promises on the page.
These synthetic checks do not validate a physical IoT board or mobile radio.

`LIVEKIT_URL` is also the server-side RoomService address (converted to HTTP);
the browser still uses `AULE_LIVEKIT_PUBLIC_URL`. Session lifecycle responses are
`no-store`. The page explains known endings on the student's end screen
(FIGMA.md, D23) using fixed Spanish/English text in `public/session-messages.js`;
it never renders raw provider errors. Old sessions may have no stored reason.

### Email unsubscribe

`/unsubscribe?token=…` under the configured base path is public and needs no
account cookie. GET/HEAD only show confirmation. POST forwards the signed,
notice-only capability to the platform; it never forwards cookies or the
operator credential. The page is Spanish/English, works without JavaScript,
and never caches or includes third-party assets. Deploy this route before the
platform/worker release that puts it in notice emails.
