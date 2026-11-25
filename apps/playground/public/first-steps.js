// A child's first steps on the page: the hand-off from the parent (a02, from
// César's A02 ¿Eres tú?), the microphone check on A05 and the coached first
// turn of a session. Their words, in the student's language, with those of the
// talk button and the camera they speak of, and the small arithmetic behind
// them. Pure: nothing here touches the page, so the tests import it as it is.
// What is measured is a level, worked out in the browser; no sound is kept or
// sent anywhere.

import { languageOf } from "./session-messages.js";

// The words speak to the child, as A02, A05 and A16 do: short, warm, and
// without an exclamation mark. «apretado» is the live button's word.
const WORDS = {
  es: {
    // a02: a line for the parent, then A02's question, its two tiles and the way back.
    handoff_lead: "Ahora le toca a {name}.",
    handoff_title: "¿Eres tú?",
    handoff_yes: "Sí, soy yo",
    handoff_no: "No soy yo",
    back: "Volver",
    // A05's check: César's line under the bar (Pendiente 260:654), then what the status line says.
    check_line: "Si la barra se mueve cuando hablas, Aule te escucha.",
    check_prompt: "Di «Hola, Aule» y mira la barra.",
    check_heard: "Te escucho.",
    check_quiet: "¿No se mueve? Acércate un poco y habla como siempre.",
    check_other_app: "Si otra app está usando el micrófono, ciérrala y toca «Intentar otra vez».",
    retry: "Intentar otra vez",
    // A microphone that cannot be used, by what the browser said (micProblem).
    mic_blocked:
      "El navegador no deja que Aule te escuche. Con ayuda de un adulto, toca el ícono junto a la dirección de la página (en un iPhone, «aA»), permite el micrófono y toca «Intentar otra vez».",
    mic_missing: "No encontramos un micrófono. Conecta uno o prueba en otro celular o computadora.",
    mic_busy: "Otra app está usando el micrófono. Ciérrala y toca «Intentar otra vez».",
    mic_unavailable: "Tu micrófono no está disponible.",
    sound_test: "Probar el sonido",
    sound_line: "Así suena cuando Aule llega. Si no lo oíste, sube el volumen.",
    camera_note: "La cámara se enciende solo cuando muestras tu tarea.",
    // A05's camera, when the browser gives none.
    camera_none: "No se encontró o no se permitió la cámara. Igual puedes entrar con voz.",
    // A16 Hola, soy Aule, on a first run.
    intro_title: "Hola, soy Aule",
    intro_line: "Soy tu tutor. Soy una inteligencia artificial.",
    // The talk button, as the coach speaks of it.
    talk_hold: "Mantén apretado para hablar",
    talk_hold_key: "Mantén apretado para hablar (o la barra espaciadora)",
    talk_listening: "Te escucho… suelta para enviar",
    talk_off: "El micrófono está apagado",
    // The talk button's coach.
    coach: "Mantén apretado mientras hablas. Suelta cuando termines.",
    coach_tap: "Déjalo apretado mientras hablas.",
    coach_done: "Eso es.",
    // «Mostrar mi tarea», the line it adds to the conversation (the tutor hears the
    // same one, SHOWN_WORK in apps/agent), and what went wrong, by cameraProblem.
    show_work: "Mostrar mi tarea",
    showing_work: "Mostrando…",
    shown_work: "Mira mi trabajo.",
    camera_blocked:
      "El navegador no deja que Aule vea tu cámara. Con ayuda de un adulto, toca el ícono junto a la dirección de la página (en un iPhone, «aA») y permite la cámara.",
    camera_missing: "No encontramos una cámara. Igual puedes seguir con tu voz.",
    camera_busy: "Otra app está usando la cámara. Ciérrala e inténtalo otra vez.",
    camera_unseen: "Aule no pudo ver la cámara. Acerca la hoja e inténtalo otra vez.",
  },
  en: {
    handoff_lead: "Now it's {name}'s turn.",
    handoff_title: "Is this you?",
    handoff_yes: "Yes, it's me",
    handoff_no: "It's not me",
    back: "Back",
    check_line: "If the bar moves when you talk, Aule can hear you.",
    check_prompt: "Say “Hello, Aule” and watch the bar.",
    check_heard: "I can hear you.",
    check_quiet: "Not moving? Come a little closer and talk the way you always do.",
    check_other_app: "If another app is using the microphone, close it and tap “Try again”.",
    retry: "Try again",
    mic_blocked:
      "The browser isn't letting Aule hear you. With a grown-up's help, tap the icon next to the page address (“aA” on an iPhone), allow the microphone and tap “Try again”.",
    mic_missing: "We couldn't find a microphone. Plug one in, or try another phone or computer.",
    mic_busy: "Another app is using the microphone. Close it and tap “Try again”.",
    mic_unavailable: "Your microphone isn't available.",
    sound_test: "Test the sound",
    sound_line: "That's the sound Aule makes when it arrives. If you didn't hear it, turn the volume up.",
    camera_note: "The camera turns on only when you show your homework.",
    camera_none: "The camera wasn't found or wasn't allowed. You can still come in with your voice.",
    intro_title: "Hi, I'm Aule",
    intro_line: "I'm your tutor. I'm an artificial intelligence.",
    talk_hold: "Hold to talk",
    talk_hold_key: "Hold to talk (or the space bar)",
    talk_listening: "I'm listening… let go to send",
    talk_off: "The microphone is off",
    coach: "Hold it down while you talk. Let go when you're done.",
    coach_tap: "Keep it pressed while you talk.",
    coach_done: "That's it.",
    show_work: "Show my homework",
    showing_work: "Showing…",
    shown_work: "Look at my work.",
    camera_blocked:
      "The browser isn't letting Aule see your camera. With a grown-up's help, tap the icon next to the page address (“aA” on an iPhone) and allow the camera.",
    camera_missing: "We couldn't find a camera. You can still carry on with your voice.",
    camera_busy: "Another app is using the camera. Close it and try again.",
    camera_unseen: "Aule couldn't see the camera. Bring the page closer and try again.",
  },
};

/** Every key the words have; each is in both languages. */
export const KEYS = Object.freeze(Object.keys(WORDS.es));

// The language an element is marked with is the one its words are in.
export { languageOf };

/**
 * The words for `key` in `language` (Spanish when the page has none in it),
 * with `name` in place of {name}; "" for a key that is not one of them.
 */
export function words(key, language, { name = "" } = {}) {
  const table = WORDS[languageOf(language)];
  if (typeof key !== "string" || !Object.hasOwn(table, key)) return "";
  // A function, so a name with "$" in it is written as it is.
  return table[key].replaceAll("{name}", () => String(name));
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
