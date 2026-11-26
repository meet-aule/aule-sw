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
  // The design pass's (24 Nov): A04 and its details in the student's language, as a02 and A05 are.
  "a04_hello",
  "a04_title",
  "kind_homework",
  "kind_exam_prep",
  "kind_explore",
  "kind_none",
  "kind_exam_review",
  "details_line",
  "details_subject",
  "details_due",
  "details_topic",
  "details_topic_example",
  "optional",
  "subject_matematica",
  "subject_comunicacion",
  "subject_ciencia",
  "subject_personal_social",
  "subject_ingles",
  "subject_other",
  "details_note",
  "details_next",
  // And A05's title, its one line and its round buttons, which say what each is.
  "a05_title",
  "a05_line",
  "mic_label",
  "mic_on",
  "mic_off",
  "cam_label",
  "cam_on",
  "cam_off",
  "check_line",
  "check_prompt",
  "check_heard",
  "check_quiet",
  "check_other_app",
  "retry",
  // A problem is a line for the child and, under it, one for the adult (*_help).
  "mic_blocked",
  "mic_blocked_help",
  "mic_missing",
  "mic_missing_help",
  "mic_busy",
  "mic_busy_help",
  "mic_unavailable",
  "sound_test",
  "sound_line",
  "camera_note",
  // Not the spec's: A05's camera, when the browser gives none, in both languages (review of 24 Nov).
  "camera_none",
  "intro_title",
  "intro_line",
  // A16's second line, held back until the home showed a summary of each session (D35).
  "intro_parent",
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
  // The fix pass's (24 Nov): the camera going off after the wait says so, and a camera
  // problem is a line for the child with one for the adult under it, as the microphone's is.
  "camera_off",
  "camera_blocked",
  "camera_blocked_help",
  "camera_missing",
  "camera_busy",
  "camera_busy_help",
  "camera_unseen",
  // And the session's own words around the stage, in the student's language like the rest.
  "end_session",
  "clock_label",
  "type_label",
  "type_placeholder",
  "send",
  "conversation",
  "you",
  "you_typed",
  "talk_not_started",
  "turn_unheard",
  "message_failed",
  "choices_label",
  "choices_several",
  "choices_done",
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
  assert.deepEqual(
    KEYS.filter((key) => namings(key, "es") > 0),
    ["handoff_lead", "a04_hello"],
    "only the line for the parent and A04's greeting name the child",
  );
});

test("the words are César's where he wrote them, and say «apretado» as the live button does", () => {
  assert.equal(words("handoff_title", "es"), "¿Eres tú?");
  assert.equal(words("handoff_yes", "es"), "Sí, soy yo");
  assert.equal(words("handoff_no", "es"), "No soy yo");
  assert.equal(words("check_line", "es"), "Si la barra se mueve cuando hablas, Aule te escucha.");
  assert.equal(words("intro_title", "es"), "Hola, soy Aule");
  assert.equal(words("intro_line", "es"), "Soy tu tutor. Soy una inteligencia artificial.");
  assert.equal(words("intro_parent", "es"), "Tu papá o mamá recibe un resumen de lo que hacemos.");
  assert.match(words("coach", "es"), /apretado/);
  assert.match(words("coach_tap", "es"), /apretado/);
  // The line under Aule's face: whose turn it is, in the words the live session used.
  assert.equal(words("state_your_turn", "es"), "Tu turno");
  assert.equal(words("state_listening", "es"), "Te escucho");
  assert.equal(words("state_speaking", "es"), "Hablando");
  // «Listo» is named by the line that asks for it, in each language.
  assert.ok(words("camera_aim", "es").includes(`«${words("camera_send", "es")}»`));
  assert.ok(words("camera_aim", "en").includes(`“${words("camera_send", "en")}”`));
  assert.ok(words("choices_several", "es").includes(`«${words("choices_done", "es")}»`));
  assert.ok(words("choices_several", "en").includes(`“${words("choices_done", "en")}”`));
  // The hints and the adult's lines name the link they lead to, in each language.
  for (const key of ["check_other_app", "mic_blocked_help", "mic_busy_help"]) {
    assert.ok(words(key, "es").includes(`«${words("retry", "es")}»`), key);
    assert.ok(words(key, "en").includes(`“${words("retry", "en")}”`), key);
  }
});

test("a child-facing line is one sentence: only César's AI disclosure has two (D33)", () => {
  // A sentence ends at «.», «?» or «…» before a space or the end; a line's own closing «…» is no break.
  const ends = (text) => (text.replace(/…$/, "").match(/[.?…](\s|$)/g) ?? []).length;
  for (const key of KEYS) {
    for (const language of ["es", "en"]) {
      const text = words(key, language, { name: "Mati" });
      if (key === "intro_line") assert.equal(ends(text), 2, `${key} in ${language}`);
      else assert.ok(ends(text) <= 1, `${key} in ${language}: «${text}»`);
    }
  }
  // A05's line is César's one: Aule needs to hear you.
  assert.equal(words("a05_line", "es"), "Aule necesita escucharte.");
  // The coach says what the talk button's own words do not: let go when you are done.
  assert.equal(words("coach", "es"), "Mantenlo apretado y luego suelta.");
  for (const language of ["es", "en"]) {
    assert.ok(!words("coach", language).includes(words("talk_hold", language)), `the coach does not repeat the button in ${language}`);
  }
  assert.match(words("coach", "en"), /let go/);
  // A problem's line is the child's; what to do is the adult's, under it.
  for (const problem of ["mic_blocked", "mic_missing", "mic_busy", "camera_blocked", "camera_busy"]) {
    assert.match(words(`${problem}_help`, "es"), /^Un adulto puede /, problem);
    assert.match(words(`${problem}_help`, "en"), /^A grown-up can /, problem);
    assert.doesNotMatch(words(problem, "es"), /adulto/, `${problem} speaks to the child`);
    assert.doesNotMatch(words(problem, "en"), /grown-up/, `${problem} speaks to the child`);
  }
  assert.equal(words("mic_unavailable_help", "es"), "", "a microphone that is merely unavailable has no help line");
  // A missing camera, or a picture not seen, is the child's to deal with: no adult's line.
  for (const problem of ["camera_missing", "camera_unseen"]) assert.equal(words(`${problem}_help`, "es"), "", problem);
});

test("A04's tiles, its details and A05 have their words in both languages, as the Figma writes the Spanish", () => {
  assert.equal(words("a04_title", "es"), "¿Qué hacemos hoy?");
  assert.equal(words("a05_title", "es"), "Antes de empezar");
  assert.equal(words("kind_none", "es"), "No lo sé");
  assert.equal(words("kind_homework", "es"), "Terminar tareas de la escuela");
  assert.equal(words("a04_hello", "en", { name: "Mati" }), "Hi, Mati.");
  // The round buttons' sentences say what the button is, A15's own words.
  assert.equal(words("mic_on", "es"), "Tu micrófono está encendido.");
  assert.equal(words("mic_off", "es"), "Tu micrófono está apagado.");
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
  // A blocked camera gets the help a blocked microphone gets, for the adult, not a page moved
  // closer; the child's own line says what happened (the review of 24 Nov).
  for (const [language, where] of [
    ["es", "junto a la dirección de la página (en iPhone, «aA»)"],
    ["en", "next to the page address (“aA” on an iPhone)"],
  ]) {
    assert.ok(words("mic_blocked_help", language).includes(where), `mic_blocked_help in ${language}`);
    assert.ok(words("camera_blocked_help", language).includes(where), `camera_blocked_help in ${language}`);
  }
  assert.match(words("camera_blocked_help", "es"), /^Un adulto puede permitir la cámara/);
  assert.equal(words("camera_blocked", "es"), "Aule no puede usar tu cámara.");
  assert.equal(words("camera_busy", "es"), "Otra app está usando la cámara.");
  assert.doesNotMatch(words("camera_blocked", "es"), /Acerca/);
  // The busy camera's adult line names the button to press again, in each language.
  assert.ok(words("camera_busy_help", "es").includes(`«${words("show_work", "es")}»`));
  assert.ok(words("camera_busy_help", "en").includes(`“${words("show_work", "en")}”`));
  // «Apuntar» is to write something down at school: the line says to show it to the camera.
  assert.equal(words("camera_aim", "es"), "Muestra tu tarea a la cámara y toca «Listo».");
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
