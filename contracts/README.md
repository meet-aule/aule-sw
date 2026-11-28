# Contracts

The events Aule's components send each other, as JSON Schema. This folder is the single source of truth: the Node platform and the Python agent both validate against these files, so a change here that one side does not follow fails its tests.

```text
envelope.schema.json   the envelope every event uses (CloudEvents 1.0, structured JSON)
events/                one schema per event type and version, for the envelope's `data`
examples/              one valid example per event type, used by the tests of both sides
visuals/               what the tutor shows on a screen: one schema and an example per kind
choices/               answers the student can tap under the tutor's question, with examples
```

## Rules

- **Names:** `<thing>.<what_happened>.v<N>`, past tense: `session.ended.v1`.
- **Versions:** adding an optional field keeps the version. Removing or renaming a field, changing a type or making a field required needs a new version (`v2`) next to the old one, until no consumer reads the old one.
- **No unknown fields:** every event schema sets `additionalProperties: false`.
- **Privacy:** events never carry a child's words, audio, transcripts or model scores. They carry IDs, timestamps, counts and fixed categories. If a consumer needs more, it asks the platform through an authenticated API.
- **Every event type has an example** in `examples/`, as a full envelope.

## Check

```bash
pnpm install
pnpm test                               # Node: schemas compile, examples validate
cd apps/agent && uv run pytest          # Python: same examples, plus the agent's event builder
```


## Visuals

### Progressive board pilot

Set `AULE_PROGRESSIVE_BOARD=1` on the voice worker to enable the Playground
pilot. It uses the existing `show` tool, session audio and monochrome SVG
renderer. The step-by-step interaction is inspired by
[Whiteboard AI Tutor](https://github.com/molly554/whiteboard-ai-tutor).

The linked learner's screen handles the LiveKit RPC `aule.board.v1`. A read
returns its revision, visible rows or rectangle, the tutor's mark and the
learner's selected part. Every change must match that revision. A tap, a new
press to speak, a new drawing, hiding the screen or a reconnect invalidates
outstanding changes. An interrupted turn keeps the drawing on the screen.
Each new learner turn reads the screen again. All board state lives in the
room and tab for the session's lifetime.

[Steps](board/step.v1.schema.json) and [acknowledged views](board/view.v1.schema.json)
bound the data on this path. A bar can have up to twelve cells and a board
holds up to four bars. Rectangles use whole centimetres. The
[sample lessons](board/lesson.v1.example.json) compare one half to two quarters
and work through an eight-by-three rectangle. The existing visual stream
serves screens with an older client.

To check in Safari, start a voice session with the pilot enabled. Ask for a
single bar showing one half, answer the tutor, then ask to add two quarters.
Tap the third cell of the second bar and ask why it is unshaded. Ask for the
rectangle, tap its right side and ask about its length. Hold the talk button
while another change is pending and check that the last drawing stays visible.
The agent and Playground regression tests exercise the same fixtures,
including an interruption before moderation finishes and a stale delivery
after a new press.

### Other visuals

`visuals/visual.v1.schema.json` describes what the tutor can put on the student's screen: the statement of an exercise, fraction bars, a number line, an array of dots, a table, a bar chart or a rectangle with its sides. It is a description, not a picture. The agent's `show` tool takes exactly this shape, checks it and sends it to the room on the text-stream topic `aule.visual`; each screen draws it itself, in black on white, so it costs nothing to render and works on e-ink. A bar or a circle has its fraction written next to it unless the fraction says `labelled: false`, for when the fraction is what the student has to find. A new kind needs its example here, a drawing in every screen that shows visuals, and a line in the tool's description.

## Choices

`choices/choices.v1.schema.json` describes the answers a student can tap under the question the tutor has just asked: one to four short options, and `multiple` when several may be marked and sent together. The session engine offers its own (its questions with known answers, and an exercise's options); the tutor's model offers them with its `offer_choices` tool, which takes two to four, and they pass the gate on what the tutor says before any screen gets them. The agent sends them to the room on the text-stream topic `aule.choices` once the question has been said, and the screen draws them under that line. A tapped option is the student's turn: the screen sends its words as a typed message, so it passes the input gates like anything typed; several marked go as one turn, joined by commas («1/2, 2/4»).
