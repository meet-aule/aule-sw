// A child's first steps (public/first-steps.js): the words of the hand-off,
// A05's check and the coached first turn, and of the talk button and the
// camera they speak of, in Spanish and in English, and the arithmetic that
// decides what they say.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  COACH_HOLD_MS,
  HEARD_MS,
  HINTS_MS,
  KEYS,
  TAP_MS,
  VOICE,
  WINDOW_MS,
  cameraProblem,
  heard,
  isTap,
  levelOf,
  micProblem,
  words,
} from "../public/first-steps.js";

// The spec's words (§7), in its order: César's own for the hand-off, the bar's line and A16.
const SPEC_KEYS = [
  "handoff_lead",
  "handoff_title",
  "handoff_yes",
  "handoff_no",
  "back",
  "check_line",
  "check_prompt",
  "check_heard",
  "check_quiet",
  "check_other_app",
  "retry",
  "mic_blocked",
  "mic_missing",
  "mic_busy",
  "mic_unavailable",
  "sound_test",
  "sound_line",
  "camera_note",
  // Not the spec's: A05's camera, when the browser gives none, in both languages (review of 24 Nov).
  "camera_none",
  "intro_title",
  "intro_line",
  // Not the spec's: the talk button the coach speaks of, and «Mostrar mi tarea», in both languages.
  "talk_hold",
  "talk_hold_key",
  "talk_listening",
  "talk_off",
  "coach",
  "coach_tap",
  "coach_done",
  // The design pass's (24 Nov): the line under Aule's face on the stage, by the tutor's state.
  "state_waiting",
  "state_initializing",
  "state_listening",
  "state_your_turn",
  "state_thinking",
  "state_speaking",
  "state_left",
  "state_reconnecting",
  "show_work",
  // And «Mostrar mi tarea» in two steps: the camera on the stage, then «Listo» or «Cancelar».
  "camera_aim",
  "camera_send",
  "camera_cancel",
  "showing_work",
  "shown_work",
  "camera_blocked",
  "camera_missing",
  "camera_busy",
  "camera_unseen",
];

// How many times a line says the name it is given.
const NAME = "⟨name⟩";
const namings = (key, language) => words(key, language, { name: NAME }).split(NAME).length - 1;

test("every word is there in Spanish and in English, calm, with the name in the same places", () => {
  assert.deepEqual([...KEYS], SPEC_KEYS);
  for (const key of KEYS) {
    const es = words(key, "es");
    const en = words(key, "en");
    for (const [language, text] of [
      ["es", es],
      ["en", en],
    ]) {
      assert.ok(text.trim(), `${key} has words in ${language}`);
      assert.doesNotMatch(text, /[!¡]/, `${key} in ${language} has no exclamation mark`);
      assert.doesNotMatch(words(key, language, { name: NAME }), /[{}]/, `${key} in ${language} leaves no place unfilled`);
    }
    assert.notEqual(es, en, `${key} is written in each language`);
    assert.equal(namings(key, "es"), namings(key, "en"), `${key} says the name as often in both`);
  }
  assert.equal(namings("handoff_lead", "es"), 1);
  assert.equal(KEYS.filter((key) => namings(key, "es") > 0).length, 1, "only the line for the parent names the child");
});

test("the words are César's where he wrote them, and say «apretado» as the live button does", () => {
  assert.equal(words("handoff_title", "es"), "¿Eres tú?");
  assert.equal(words("handoff_yes", "es"), "Sí, soy yo");
  assert.equal(words("handoff_no", "es"), "No soy yo");
  assert.equal(words("check_line", "es"), "Si la barra se mueve cuando hablas, Aule te escucha.");
  assert.equal(words("intro_title", "es"), "Hola, soy Aule");
  assert.equal(words("intro_line", "es"), "Soy tu tutor. Soy una inteligencia artificial.");
  assert.match(words("coach", "es"), /apretado/);
  assert.match(words("coach_tap", "es"), /apretado/);
  // The line under Aule's face: whose turn it is, in the words the live session used.
  assert.equal(words("state_your_turn", "es"), "Tu turno");
  assert.equal(words("state_listening", "es"), "Te escucho");
  assert.equal(words("state_speaking", "es"), "Hablando");
  // «Listo» is named by the line that asks for it, in each language.
  assert.ok(words("camera_aim", "es").includes(`«${words("camera_send", "es")}»`));
  assert.ok(words("camera_aim", "en").includes(`“${words("camera_send", "en")}”`));
  // The hints and the problems name the link they lead to, in each language.
  for (const key of ["check_other_app", "mic_blocked", "mic_busy"]) {
    assert.ok(words(key, "es").includes(`«${words("retry", "es")}»`), key);
    assert.ok(words(key, "en").includes(`“${words("retry", "en")}”`), key);
  }
});

test("a name takes the place of {name} as it is written, «$» and all", () => {
  assert.equal(words("handoff_lead", "es", { name: "Mati" }), "Ahora le toca a Mati.");
  assert.equal(words("handoff_lead", "en", { name: "Mati" }), "Now it's Mati's turn.");
  assert.equal(words("handoff_lead", "es", { name: "$& $1" }), "Ahora le toca a $& $1.");
  assert.equal(words("handoff_title", "es", { name: "Mati" }), "¿Eres tú?", "a line without {name} stays as it is");
});

test("a language the page has no words in gives Spanish, and a key that is not one gives nothing", () => {
  for (const language of ["qu", "EN", "__proto__", "constructor", "", null, undefined]) {
    assert.equal(words("check_heard", language), "Te escucho.", String(language));
  }
  for (const key of ["", "nope", "__proto__", "constructor", "toString", "hasOwnProperty", null, undefined, 3]) {
    assert.equal(words(key, "es"), "", String(key));
    assert.equal(words(key, "en"), "", String(key));
  }
});

test("the level is 0 for silence, 1 when it clips, and rises with the loudest sample", () => {
  const frame = (peak) => Uint8Array.from({ length: 512 }, (_, i) => (i === 100 ? 128 + peak : 128));
  assert.equal(levelOf(frame(0)), 0);
  assert.equal(levelOf(Uint8Array.from({ length: 512 }, (_, i) => (i % 2 ? 0 : 255))), 1);
  assert.equal(levelOf(frame(127)), 1);
  assert.equal(levelOf(new Uint8Array(512)), 1, "a frame at the floor clips too");
  let before = -1;
  for (const peak of [0, 5, 10, 20, 40]) {
    const level = levelOf(frame(peak));
    assert.ok(level > before, `${peak} is louder than the one before`);
    before = level;
  }
  // Downwards counts as much as upwards, and today's bar (peak / 128 × 250 %) is the same level.
  assert.equal(levelOf(frame(-20)), levelOf(frame(20)));
  assert.equal(levelOf(frame(20)), (20 / 128) * 2.5);
  // A quarter of the bar is a voice.
  assert.equal(VOICE, 0.25);
  assert.ok(levelOf(frame(13)) >= VOICE && levelOf(frame(12)) < VOICE);
});

/** The meter's frames, one every `step` ms from `from` to `to`, at `level`. */
const frames = (from, to, level, step = 16) => {
  const out = [];
  for (let at = from; at < to; at += step) out.push({ at, level });
  return out;
};

test("a voice is heard after 400 ms of it within a second and a half, not from a sound or a short burst", () => {
  assert.equal(HEARD_MS, 400);
  assert.equal(WINDOW_MS, 1500);
  // One loud frame, between quiet ones and on its own.
  assert.equal(heard([...frames(0, 500, 0), { at: 500, level: 1 }, ...frames(516, 1000, 0)], 1000), false);
  assert.equal(heard([{ at: 0, level: 1 }], 1000), false, "a frame stands for 100 ms at most");
  // A 200 ms burst.
  assert.equal(heard([...frames(0, 200, 0.9), ...frames(200, 1000, 0)], 1000), false);
  // 400 ms of voice.
  const voice = [...frames(0, 420, 0.5), ...frames(420, 1000, 0)];
  assert.equal(heard(voice, 420), true);
  assert.equal(heard(voice, 1000), true, "still within the window");
  // In pieces: 4 × 120 ms within the window is enough in all.
  const pieces = [0, 300, 600, 900].flatMap((at) => [...frames(at, at + 120, 0.6), ...frames(at + 120, at + 300, 0)]);
  assert.equal(heard(pieces, 1200), true);
  // Just under the level of a voice is not one.
  assert.equal(heard(frames(0, 1000, VOICE - 0.01), 1000), false);
  // Once the voice is out of the window, it is not heard any more.
  assert.equal(heard([...voice, ...frames(1000, 2100, 0)], 2100), false);
  assert.equal(heard([], 0), false);
});

test("a press is a tap when it is short and has no voice in it", () => {
  assert.equal(TAP_MS, 400);
  assert.equal(isTap(150, false), true);
  assert.equal(isTap(150, true), false, "a quick «sí» is not a tap");
  assert.equal(isTap(700, false), false);
  assert.equal(isTap(TAP_MS, false), false);
  assert.ok(COACH_HOLD_MS > TAP_MS, "a hold that teaches is longer than a tap");
  assert.deepEqual([...HINTS_MS], [8000, 16000]);
});

test("the browser's refusal of the microphone names its cause: blocked, missing or busy", () => {
  const causes = {
    NotAllowedError: "mic_blocked",
    SecurityError: "mic_blocked",
    NotFoundError: "mic_missing",
    OverconstrainedError: "mic_missing",
    NotReadableError: "mic_busy",
    AbortError: "mic_busy",
  };
  for (const [name, key] of Object.entries(causes)) assert.equal(micProblem(name), key, name);
  for (const name of ["TypeError", "SomethingNew", "__proto__", "constructor", "", undefined, null]) {
    assert.equal(micProblem(name), "mic_unavailable", String(name));
  }
  // Each has its words.
  for (const key of new Set([...Object.values(causes), "mic_unavailable"])) assert.ok(words(key, "en"), key);
});

test("a camera the browser will not give for «Mostrar mi tarea» is named as such: blocked, missing or busy", () => {
  const causes = {
    NotAllowedError: "camera_blocked",
    SecurityError: "camera_blocked",
    NotFoundError: "camera_missing",
    OverconstrainedError: "camera_missing",
    NotReadableError: "camera_busy",
    AbortError: "camera_busy",
  };
  for (const [name, key] of Object.entries(causes)) assert.equal(cameraProblem(name), key, name);
  // Anything else is a picture Aule did not get.
  for (const name of ["TypeError", "Error", "__proto__", "constructor", "", undefined, null]) {
    assert.equal(cameraProblem(name), "camera_unseen", String(name));
  }
  for (const key of new Set(Object.values(causes))) assert.ok(words(key, "es") && words(key, "en"), key);
  // A blocked camera gets the help a blocked microphone gets, not a page moved closer.
  assert.match(words("camera_blocked", "es"), /toca el ícono junto a la dirección de la página \(en un iPhone, «aA»\)/);
  assert.match(words("camera_blocked", "en"), /tap the icon next to the page address \(“aA” on an iPhone\)/);
  assert.doesNotMatch(words("camera_blocked", "es"), /Acerca la hoja/);
});

test("the talk button's words are the page's own, and the line «Mostrar mi tarea» adds is the one the tutor hears", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  // The label index.html starts with is the Spanish one app.js writes.
  assert.ok(html.includes(`<span id="talk-label">${words("talk_hold", "es")}</span>`));
  assert.ok(words("talk_hold_key", "es").startsWith(words("talk_hold", "es")));
  assert.ok(words("talk_hold_key", "en").startsWith(words("talk_hold", "en")));
  // apps/agent tutor.py SHOWN_WORK.
  const tutor = await readFile(new URL("../../agent/src/aule_agent/tutor.py", import.meta.url), "utf8");
  const shown = JSON.parse(tutor.match(/^SHOWN_WORK = (\{.*\})$/m)?.[1] ?? "{}");
  assert.deepEqual(shown, { es: words("shown_work", "es"), en: words("shown_work", "en") });
});
