// Aule's face: the cuy is a character the mascot's engine accepts with nothing
// to fix, the arithmetic that shows it in pixels, and its wiring in the page.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { cuy } from "../public/cuy.js";
import { SPRITE, pixelsFor } from "../public/pixels.js";

const pub = new URL("../public/", import.meta.url);
const read = (name) => readFile(new URL(name, pub), "utf8");
const html = await read("index.html");
const css = await read("style.css");
const app = await read("app.js");

test("the cuy passes the engine's own check, with no error and no warning", async () => {
  const cli = join(dirname(createRequire(import.meta.url).resolve("wobnimo/package.json")), "dist", "cli.js");
  // With an error the check exits with 1 and still prints its report.
  const report = await promisify(execFile)(process.execPath, [cli, "check", fileURLToPath(new URL("cuy.js", pub)), "--json"]).then(
    ({ stdout }) => JSON.parse(stdout),
    (failed) => JSON.parse(failed.stdout),
  );
  const problems = report.issues.filter(({ level }) => level === "error" || level === "warning");
  assert.deepEqual(problems.map(({ where, message }) => `${where}: ${message}`), []);
  assert.equal(report.ok, true);
});

test("the cuy acts out every state the page asks its face for", () => {
  assert.equal(cuy.id, "cuy");
  const bones = new Set(cuy.bones.map((bone) => bone.name));
  for (const part of cuy.parts) assert.ok(bones.has(part.bone), `a part is on "${part.bone}"`);
  for (const anchor of ["top", "mouth", "ear", "feet"]) assert.ok(cuy.anchors[anchor], anchor);
  // app.js MASCOT_STATE and A05's check, and the pause inside an answer.
  const asked = [...app.matchAll(/(?:waiting|initializing|listening|thinking|speaking|missing|left|reconnecting): "(\w+)"/g)].map(([, state]) => state);
  assert.deepEqual([...new Set(asked)].sort(), ["listening", "sad", "sleeping", "speaking", "surprised", "thinking"]);
  for (const state of ["listening", "speaking", "sleeping", "sad", "surprised", "thinking"]) assert.ok(cuy.acting[state], state);
  // It wears the glasses of Aule's icon: two rings and their bridge.
  assert.equal(cuy.parts.filter((part) => part.shape === "frame" && part.material === "rims").length, 2);
});

test("a face is drawn at about SPRITE pixels and enlarged a whole number of times", () => {
  // The stage, from a phone to a desktop, on a screen with two pixels for each of the page's.
  for (const box of [120, 160, 200, 240]) {
    const { side, times, line } = pixelsFor(box, 2);
    assert.ok(Number.isInteger(times) && times >= 2, `${box}: ${times} times`);
    assert.ok(side * times <= box && side * times > box - times, `${box}: it fills its box`);
    assert.ok(Math.abs(side * 2 - SPRITE) <= SPRITE / 4, `${box}: ${side * 2} pixels a side`);
    assert.equal(line, 0.5);
  }
  assert.deepEqual(pixelsFor(240, 2), { side: 40, times: 6, line: 0.5 });
  assert.deepEqual(pixelsFor(240, 1), { side: 80, times: 3, line: 1 });
  // A screen finer than the engine draws: as with two.
  assert.deepEqual(pixelsFor(240, 3), pixelsFor(240, 2));
  // The band beside a drawing: still pixels where there are enough of them, the face as it is where not.
  assert.deepEqual(pixelsFor(52, 2), { side: 26, times: 2, line: 0.5 });
  assert.equal(pixelsFor(52, 1), null);
  // A box that is not showing has no size.
  assert.equal(pixelsFor(0, 2), null);
});

test("both faces are the mascot in a box, with the engine's jelly if the cuy cannot load", () => {
  for (const [id, box] of [
    ["mascot", "mascot"],
    ["check-face", "check-face"],
  ]) {
    const tag = new RegExp(`<div class="${box} face-box">\\s*<wobnimo-mascot id="${id}" character="mochi" state="\\w+" floor="0" aria-hidden="true"></wobnimo-mascot>\\s*</div>`);
    assert.match(html, tag, id);
  }
  assert.match(app, /for \(const face of \[\$\("mascot"\), \$\("check-face"\)\]\) \{\s*face\.spec = cuy;\s*pixelate\(face\);\s*\}/);
  // The filter the style sheet names is in the page, and takes no room.
  assert.match(html, /<svg class="filters" width="0" height="0" aria-hidden="true" focusable="false">\s*<filter id="flat"/);
  assert.match(css, /\.face-box\.pixels > wobnimo-mascot \{[^}]*filter: url\(#flat\) drop-shadow\(var\(--line\) 0 0 var\(--device-ink\)\)/);
  assert.match(css, /\.filters \{\s*position: absolute;\s*\}/);
  // A box shows as a grid, so the small face sits in its middle.
  assert.match(css, /\.tutor\.has-mascot \.mascot \{\s*display: grid;\s*\}/);
  assert.match(css, /\.mic-check\.has-mascot \.check-face \{\s*display: grid;\s*\}/);
});

test("the mouth moves while Aule's voice sounds, and what is heard stays a level", () => {
  // Only the tutor's voice is followed, and it is let go when the track or the session ends.
  assert.match(app, /if \(participant\?\.kind === ParticipantKind\.AGENT\) followVoice\(track\);/);
  assert.match(app, /if \(track\.kind === Track\.Kind\.Audio && participant\?\.kind === ParticipantKind\.AGENT\) forgetVoice\(\);/);
  assert.match(app, /leaving\.disconnect\(\);\s*forgetVoice\(\);/);
  // In a pause of the answer the face rests. Until the voice has been heard once, and where it cannot be
  // measured, the face talks for the whole of «speaking», as it did.
  assert.match(app, /let voiceAt = -Infinity;/);
  assert.match(app, /const pause = state === "speaking" && Number\.isFinite\(voiceAt\) && !voiceSounds;\s*const face = pause \? "idle" : \(MASCOT_STATE\[state\] \?\? "idle"\);/);
  // The meter is A05's: an analyser that is never connected to the speakers.
  const follow = app.slice(app.indexOf("function followVoice(track)"), app.indexOf("function forgetVoice()"));
  assert.match(follow, /voiceMeter = startMeter\(new MediaStream\(\[track\.mediaStreamTrack\]\), null, \(level, now\) => \{/);
  assert.doesNotMatch(follow, /destination|fetch\(|publishData|sendText|localStorage/);
});
