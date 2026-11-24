# Playground

A web page to talk to the Aule tutor from a browser, with your microphone and your camera. It is for the people running a server: a way to hear the tutor and try changes before any device or child is involved.

It is a small Node server with no database. It serves the page and has one endpoint, which trades the access code for a LiveKit token. The token is good for one new room and asks the [agent](../agent/README.md) to join it as an operator session.

When the tutor shows something (an exercise, fraction bars, a number line...), the page draws it under the video from the description it receives; `public/visuals.js` is that drawing code, a plain function from the description to SVG.

The page's screens follow the Figma file «Login-Aule» v8, in the order César gave the flows on 24 November: the parent's on paper (whether there is an account, the ways in, the emailed code, the authorisation, a short interview, the child's name), then the child's in the device's black on white (the hand-off «¿Eres tú?», what today's session is for, the microphone before it, the session). [FIGMA.md](FIGMA.md) maps each screen, component, token and icon to the code, and says where the page differs from the file.

### A child's first steps

- **The hand-off.** After the parent saves the child's name, «Empezar su primera sesión» hands the browser to the child: «Ahora le toca a {nombre}.», «¿Eres tú?» and the name, with «Sí, soy yo» and «No soy yo» (which opens Configurar for the name). It follows César's A02; FIGMA.md D25.
- **The microphone check (A05).** A05 asks the browser for the microphone alone. A bar moves with its level, and once a voice has been heard the line beside Aule's face says «Te escucho.»; with no voice it gives one hint at a time, and a microphone the browser will not give is named (blocked, missing or busy) with «Intentar otra vez». «Probar el sonido» plays the chime Aule joins with. The level is worked out in the browser by an AnalyserNode that is not connected to anything: no sound leaves the device, is played back or kept. The check never holds back «Empezar la sesión». FIGMA.md D26.
- **The camera, off until it is needed.** A05's camera starts off and the browser is asked for it only when it is turned on; there it only shows what it sees. A session never turns it on by itself, as it joins or as the tutor comes in: it goes on for «Mostrar mi tarea», or, with a tutor that takes no pictures, with the session's «Cámara» once the tutor is in. FIGMA.md D12.
- **The first turn.** On a first run (the child said «Sí, soy yo» in this visit, or the family's trial has not started) the session's title is A16's «Hola, soy Aule» and «Soy tu tutor. Soy una inteligencia artificial.». With hold to talk, a line above the button teaches holding until the first good hold (on a short screen it stays in the page, under Aule's tile, so it never covers the session's controls), and a press too short to carry a voice gets a hint. FIGMA.md D27, D28.
- **When Aule does not arrive.** After 15 seconds the session says so, with «Intentar otra vez», which closes the attempt and goes back to A05. A session Aule never came to does not count: the platform's plan counts only a session its tutor started, and the page gives the day's session back when such a session is closed (`api/session/end`, at most `PLAYGROUND_DAILY_SESSIONS` times a day). FIGMA.md D29.

The words of these steps are in `public/first-steps.js`, in Spanish and English, written in the student's language. First run is held in the page's memory only: nothing new goes into the browser's storage.

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
| `AULE_AGENT_NAME` | The agent to ask for. Default `aule-tutor` |
| `AULE_PLATFORM_URL`, `AULE_ADMIN_TOKEN` | Optional. With them, sessions are created by the [platform](../platform/README.md) and families sign in with Google, GitHub, Facebook or Apple |
| `PLAYGROUND_CHILD_ID` | Optional, with a platform: a child profile to try the tutor with. Its guardian must have consented to `voice` |

Put it behind a reverse proxy with HTTPS: browsers only give the microphone and the camera to secure pages.

The team's panel is at `<base path>/admin`. `/admin`, `/admin/` and a trailing
slash on the panel redirect to that address; its data still requires a team
sign-in. Besides the daily numbers and the families, with the link each came
from, it shows the pilot's four numbers per week of sign-up and per link, from
the platform's `GET /v1/metrics/weekly`; `public/pilot.js` adds them up. An
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
two static pages in the paper look, with no script. Like the panel, they are
also reached with a trailing slash or without the base path. They say how to
sign in, the trial, what a session is like, the plan and how to continue after
the trial in the landing's words, and privacy in two sentences; change both
together.

Rooms wait up to two minutes after a network disconnect so LiveKit can rejoin
the same session. This applies both with the platform and to operator sessions
issued by the playground. The page shows its reconnecting state while the SDK
retries; a failed recovery still reports that the connection was lost. This
does not resume a session after a page reload or after its tutor has ended.

## What it does not do

- It is not a way for children to use the tutor. The session it opens is marked as an operator's, which is the only kind the agent accepts while the safety gates are missing.
- It stores nothing: no accounts, no audio, no transcripts.
- Ten wrong codes in a minute lock the endpoint for everyone until the minute passes.

## Develop

Node 24 runs the TypeScript sources directly.

```bash
pnpm install
pnpm --filter @aule/playground typecheck
pnpm --filter @aule/playground test
node --env-file=../../.env src/server.ts
```

## Testing as on the device

- **Device screen** (a switch in the session) shows the drawing as the device's panel would: 800 x 480, snapped to black, white and one grey, with a flash on every redraw. It does not imitate ghosting.
- **Hold to talk** appears when the tutor sets the participant attribute `aule.turns` to `manual`. The microphone is then closed except while the button (or the space bar) is held: pressing calls the tutor's `start_turn`, letting go calls `end_turn`, and losing the button or the window calls `cancel_turn`. The microphone switch is the device's mute: while it is off nothing is sent. While the button is held, a bar inside it follows the microphone's level, measured in the browser.

- **Typing** to the tutor works at any time, next to speaking. A typed message passes the same safety gates as a spoken one.
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

The browser holds an opaque HttpOnly/Secure/SameSite cookie, scoped to the app.
The BFF keeps at most 512 entries with room routing, a hashed sign-in owner and
the original deadline, never the original room JWT or transcript. Each recovery
rechecks family authorization, voice consent, remaining time and the live tutor.
Tickets expire five minutes after the deadline so the final reason can be read;
those extra minutes never allow a resume. A BFF restart loses tickets. Operator
access-code sessions do not support reload recovery. No hardware IoT reconnection
flow has been tested by this change.

`LIVEKIT_URL` is also the server-side RoomService address (converted to HTTP);
the browser still uses `AULE_LIVEKIT_PUBLIC_URL`. Session lifecycle responses are
`no-store`. The page explains known endings on the student's end screen
(FIGMA.md, D23) using fixed Spanish/English text in `public/session-messages.js`;
it never renders raw provider errors. Old sessions may have no stored reason.
