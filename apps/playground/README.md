# Playground

A web page to talk to the Aule tutor from a browser, with your microphone and your camera. It is for the people running a server: a way to hear the tutor and try changes before any device or child is involved.

It is a small Node server with no database. It serves the page and has one endpoint, which trades the access code for a LiveKit token. The token is good for one new room and asks the [agent](../agent/README.md) to join it as an operator session.

When the tutor shows something (an exercise, fraction bars, a number line...), the page draws it under the video from the description it receives; `public/visuals.js` is that drawing code, a plain function from the description to SVG.

The page's screens follow the Figma file «Login-Aule» v8: the parent's on paper (who is here, the ways in, the emailed code, the authorisation, a short interview, the child's name), the student's in the device's black on white (what today's session is for, the microphone before it, the session). [FIGMA.md](FIGMA.md) maps each screen, component, token and icon to the code, and says where the page differs from the file.

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
sign-in. An unknown page opened by a browser returns to the start page. Unknown
API routes, files and write requests keep their error responses. These redirects
are not cached and do not accept a destination from the request.

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
- **Hold to talk** appears when the tutor sets the participant attribute `aule.turns` to `manual`. The microphone is then closed except while the button (or the space bar) is held: pressing calls the tutor's `start_turn`, letting go calls `end_turn`, and losing the button or the window calls `cancel_turn`. The microphone switch is the device's mute: while it is off nothing is sent.

- **Typing** to the tutor works at any time, next to speaking. A typed message passes the same safety gates as a spoken one.
- **Report for the family**: with the team box ticked and a platform, the page shows, after the session ends, the summary and next step the review wrote for the family.
