// A child's first steps on the page: the hand-off from the parent (a02, from
// César's A02 ¿Eres tú?), what a session is for (A04 and its details), the
// microphone check on A05 and the coached first turn of a session. Their words,
// in the student's language, with those of the talk button, the line under
// Aule's face and the camera they speak of, and the small arithmetic behind
// them. Pure: nothing here touches the page, so the tests import it as it is.
// What is measured is a level, worked out in the browser; no sound is kept or
// sent anywhere.

import { keysOf, languageOf, wordsIn } from "./i18n.js";

// The words speak to the child, as A02, A05 and A16 do: one short sentence an
// element, warm, and without an exclamation mark (D33). They are with the
// page's others (words/es.js `first`, and the same group of each language),
// and are asked for here in the student's language, never the interface's.

/** Every key the words have; each is in every language. */
export const KEYS = keysOf("first");

// The language an element is marked with is the one its words are in.
export { languageOf };

/**
 * The words for `key` in `language` (Spanish when the page has none in it),
 * with `name` in place of {name}; "" for a key that is not one of them.
 */
export function words(key, language, { name = "" } = {}) {
  return typeof key === "string" ? wordsIn(language, `first.${key}`, { name }) : "";
}

/** A level at or above this, of 0 to 1, is a voice: a quarter of the bar. */
export const VOICE = 0.25;
/** How long a voice must be heard in all, within WINDOW_MS, for «Te escucho.». */
export const HEARD_MS = 400;
export const WINDOW_MS = 1500;
/** A press shorter than this, with no voice in it, is a tap: too short to carry speech. */
export const TAP_MS = 400;
/** A hold this long, with voice, shows the coach that the child has it. */
export const COACH_HOLD_MS = 600;
/** When A05 says the first hint and the second, without a voice since. */
export const HINTS_MS = Object.freeze([8000, 16000]);
// A meter's frame stands for the time until the next one, and never for more
// than this: a page in the background draws no frames.
const FRAME_MS = 100;

/**
 * The loudness of one frame of the microphone, 0 to 1, from the analyser's
 * bytes (128 is silence): its peak, so that a voice fills the bar well before
 * it clips.
 */
export function levelOf(samples) {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample - 128));
  return Math.min(1, (peak / 128) * 2.5);
}

/**
 * Whether a voice was heard: the level at VOICE or more for HEARD_MS in all
 * within the last WINDOW_MS. `history` is the meter's frames in time order,
 * each { at, level }, with `at` in milliseconds like `now`.
 */
export function heard(history, now) {
  const from = now - WINDOW_MS;
  let loud = 0;
  history.forEach(({ at, level }, index) => {
    if (level < VOICE) return;
    const until = Math.min(history[index + 1]?.at ?? now, at + FRAME_MS, now);
    loud += Math.max(0, until - Math.max(at, from));
  });
  return loud >= HEARD_MS;
}

/** Whether a press of the talk button was a tap: shorter than TAP_MS and with no voice. */
export function isTap(ms, voiced) {
  return ms < TAP_MS && !voiced;
}

// What the browser's refusal of the microphone means, by the error's name.
const PROBLEMS = {
  NotAllowedError: "mic_blocked",
  SecurityError: "mic_blocked",
  NotFoundError: "mic_missing",
  OverconstrainedError: "mic_missing",
  NotReadableError: "mic_busy",
  AbortError: "mic_busy",
};

/** The key of the words for a microphone the browser could not give, from getUserMedia's error name. */
export function micProblem(errorName) {
  return Object.hasOwn(PROBLEMS, errorName) ? PROBLEMS[errorName] : "mic_unavailable";
}

// The same for the camera, the first time a session asks for it: anything
// else is a picture Aule did not get.
const CAMERA_PROBLEMS = {
  NotAllowedError: "camera_blocked",
  SecurityError: "camera_blocked",
  NotFoundError: "camera_missing",
  OverconstrainedError: "camera_missing",
  NotReadableError: "camera_busy",
  AbortError: "camera_busy",
};

/** The key of the words for «Mostrar mi tarea» that did not work, from the camera's error name. */
export function cameraProblem(errorName) {
  return Object.hasOwn(CAMERA_PROBLEMS, errorName) ? CAMERA_PROBLEMS[errorName] : "camera_unseen";
}
