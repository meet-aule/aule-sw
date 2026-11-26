// A child's first steps on the page: the hand-off from the parent (a02, from
// César's A02 ¿Eres tú?), what a session is for (A04 and its details), the
// microphone check on A05 and the coached first turn of a session. Their words,
// in the student's language, with those of the talk button, the line under
// Aule's face and the camera they speak of, and the small arithmetic behind
// them. Pure: nothing here touches the page, so the tests import it as it is.
// What is measured is a level, worked out in the browser; no sound is kept or
// sent anywhere.

import { languageOf } from "./session-messages.js";

// The words speak to the child, as A02, A05 and A16 do: one short sentence an
// element, warm, and without an exclamation mark (D33). What only an adult can
// fix has a line of its own, for them (*_help). «apretado» is the live button's word.
const WORDS = {
  es: {
    // a02: a line for the parent, then A02's question, its two tiles and the way back.
    handoff_lead: "Ahora le toca a {name}.",
    handoff_title: "¿Eres tú?",
    handoff_yes: "Sí, soy yo",
    handoff_no: "No soy yo",
    back: "Volver",
    // A04: the greeting over César's title, and the tiles (steps.js KINDS), «No lo sé» and the link.
    a04_hello: "Hola, {name}.",
    a04_title: "¿Qué hacemos hoy?",
    kind_homework: "Terminar tareas de la escuela",
    kind_exam_prep: "Repasar para una evaluación",
    kind_explore: "Quiero aprender algo nuevo",
    kind_none: "No lo sé",
    kind_exam_review: "Revisar una evaluación que ya di",
    // A04 · Detalles: its line, its fields, the subjects (students.js SUBJECTS) and the note.
    details_line: "Si quieres, cuéntale a Aule de qué se trata.",
    details_subject: "Asignatura",
    details_due: "¿Para cuándo es?",
    details_topic: "Tema",
    details_topic_example: "Ej.: fracciones, triángulos",
    optional: "(opcional)",
    subject_matematica: "Matemática",
    subject_comunicacion: "Comunicación",
    subject_ciencia: "Ciencia y Tecnología",
    subject_personal_social: "Personal Social",
    subject_ingles: "Inglés",
    subject_other: "Otra",
    details_note: "Aquí Aule te ayuda con lo que traigas.",
    details_next: "Seguir",
    // A05: its title and line, and its round buttons with what each says it is.
    a05_title: "Antes de empezar",
    a05_line: "Aule necesita escucharte.",
    mic_label: "Micrófono",
    mic_on: "Tu micrófono está encendido.",
    mic_off: "Tu micrófono está apagado.",
    cam_label: "Cámara",
    cam_on: "Tu cámara está encendida.",
    cam_off: "Tu cámara está apagada.",
    // A05's check: César's line under the bar (Pendiente 260:654), then what the status line says.
    check_line: "Si la barra se mueve cuando hablas, Aule te escucha.",
    check_prompt: "Di «Hola, Aule» y mira la barra.",
    check_heard: "Te escucho.",
    check_quiet: "Acércate un poco y habla como siempre.",
    check_other_app: "Si otra app está usando el micrófono, ciérrala y toca «Intentar otra vez».",
    retry: "Intentar otra vez",
    // A microphone that cannot be used, by what the browser said (micProblem), and
    // under it what an adult can do.
    mic_blocked: "Aule no puede escucharte.",
    mic_blocked_help: "Un adulto puede permitir el micrófono junto a la dirección de la página (en iPhone, «aA») y tocar «Intentar otra vez».",
    mic_missing: "No encontramos un micrófono.",
    mic_missing_help: "Un adulto puede conectar uno o probar en otro celular o computadora.",
    mic_busy: "Otra app está usando el micrófono.",
    mic_busy_help: "Un adulto puede cerrarla y tocar «Intentar otra vez».",
    mic_unavailable: "Tu micrófono no está disponible.",
    sound_test: "Probar el sonido",
    sound_line: "Si no lo oíste, sube el volumen.",
    camera_note: "Se enciende solo para mostrar tu tarea.",
    // A05's camera, when the browser gives none.
    camera_none: "No hay cámara, pero puedes entrar con tu voz.",
    // A16 Hola, soy Aule, on a first run: César's AI disclosure, the one line of two sentences.
    intro_title: "Hola, soy Aule",
    intro_line: "Soy tu tutor. Soy una inteligencia artificial.",
    // A16's second line, true now that the home shows each session's summary (D35).
    intro_parent: "Tu papá o mamá recibe un resumen de lo que hacemos.",
    // The talk button, as the coach speaks of it.
    talk_hold: "Mantén apretado para hablar",
    talk_hold_key: "Mantén apretado para hablar (o la barra espaciadora)",
    talk_listening: "Te escucho… suelta para enviar",
    talk_off: "El micrófono está apagado",
    // The talk button's coach: what the button's own words do not say.
    coach: "Mantenlo apretado y luego suelta.",
    coach_tap: "Déjalo apretado mientras hablas.",
    coach_done: "Eso es.",
    // The line under Aule's face in the session, by the tutor's state; with held
    // turns, «Tu turno» until the button is held.
    state_waiting: "Esperando a Aule…",
    state_initializing: "Aule se está preparando…",
    state_listening: "Te escucho",
    state_your_turn: "Tu turno",
    state_thinking: "Pensando…",
    state_speaking: "Hablando",
    state_left: "Aule salió de la sesión.",
    state_reconnecting: "Reconectando…",
    // «Mostrar mi tarea», its two steps (the camera on the stage, then «Listo» or
    // «Cancelar»), the line it adds to the conversation (the tutor hears the same
    // one, SHOWN_WORK in apps/agent), and what went wrong, by cameraProblem.
    show_work: "Mostrar mi tarea",
    camera_aim: "Muestra tu tarea a la cámara y toca «Listo».",
    camera_send: "Listo",
    camera_cancel: "Cancelar",
    showing_work: "Aule está mirando…",
    shown_work: "Mira mi trabajo.",
    // After 30 s with nothing the camera goes off, and says so.
    camera_off: "La cámara se apagó.",
    // A camera that cannot be used: the child's line, and under it what an adult can do (*_help).
    camera_blocked: "Aule no puede usar tu cámara.",
    camera_blocked_help: "Un adulto puede permitir la cámara junto a la dirección de la página (en iPhone, «aA»).",
    camera_missing: "No hay cámara, pero puedes seguir con tu voz.",
    camera_busy: "Otra app está usando la cámara.",
    camera_busy_help: "Un adulto puede cerrarla y volver a tocar «Mostrar mi tarea».",
    camera_unseen: "Acerca tu tarea a la cámara e inténtalo otra vez.",
    // The session's own words around the stage: «Terminar», the clock's name, the typed
    // message, the conversation and who said each line, and what went wrong with a turn.
    end_session: "Terminar",
    clock_label: "Tiempo que queda",
    type_label: "Mensaje para Aule",
    type_placeholder: "O escríbele a Aule…",
    send: "Enviar",
    conversation: "Conversación",
    you: "Tú",
    you_typed: "Tú (escrito)",
    talk_not_started: "No pudimos avisarle a Aule que estás hablando; inténtalo otra vez.",
    turn_unheard: "Aule no lo escuchó; mantén apretado el botón y dilo otra vez.",
    message_failed: "No se pudo enviar el mensaje.",
    // The answers to tap under Aule's question (choices.js, D44): the name of their
    // group, the line where several may be marked, and the button that sends them.
    choices_label: "Toca tu respuesta",
    choices_several: "Puedes tocar varias y luego «Listo».",
    choices_done: "Listo",
  },
  en: {
    handoff_lead: "Now it's {name}'s turn.",
    handoff_title: "Is this you?",
    handoff_yes: "Yes, it's me",
    handoff_no: "It's not me",
    back: "Back",
    a04_hello: "Hi, {name}.",
    a04_title: "What shall we do today?",
    kind_homework: "Finish school homework",
    kind_exam_prep: "Review for a test",
    kind_explore: "I want to learn something new",
    kind_none: "I don't know",
    kind_exam_review: "Go over a test I already took",
    details_line: "If you like, tell Aule what it's about.",
    details_subject: "Subject",
    details_due: "What day is it for?",
    details_topic: "Topic",
    details_topic_example: "E.g. fractions, triangles",
    optional: "(optional)",
    subject_matematica: "Maths",
    subject_comunicacion: "Communication",
    subject_ciencia: "Science",
    subject_personal_social: "Personal and social",
    subject_ingles: "English",
    subject_other: "Other",
    details_note: "Here Aule helps you with what you bring.",
    details_next: "Continue",
    a05_title: "Before we start",
    a05_line: "Aule needs to hear you.",
    mic_label: "Microphone",
    mic_on: "Your microphone is on.",
    mic_off: "Your microphone is off.",
    cam_label: "Camera",
    cam_on: "Your camera is on.",
    cam_off: "Your camera is off.",
    check_line: "If the bar moves when you talk, Aule can hear you.",
    check_prompt: "Say “Hello, Aule” and watch the bar.",
    check_heard: "I can hear you.",
    check_quiet: "Come a little closer and talk as usual.",
    check_other_app: "If another app is using the microphone, close it and tap “Try again”.",
    retry: "Try again",
    mic_blocked: "Aule can't hear you.",
    mic_blocked_help: "A grown-up can allow the microphone next to the page address (“aA” on an iPhone) and tap “Try again”.",
    mic_missing: "We couldn't find a microphone.",
    mic_missing_help: "A grown-up can plug one in or try another phone or computer.",
    mic_busy: "Another app is using the microphone.",
    mic_busy_help: "A grown-up can close it and tap “Try again”.",
    mic_unavailable: "Your microphone isn't available.",
    sound_test: "Test the sound",
    sound_line: "If you didn't hear it, turn the volume up.",
    camera_note: "It turns on only to show your homework.",
    camera_none: "There's no camera, but you can come in with your voice.",
    intro_title: "Hi, I'm Aule",
    intro_line: "I'm your tutor. I'm an artificial intelligence.",
    intro_parent: "Your mum or dad gets a summary of what we do.",
    talk_hold: "Hold to talk",
    talk_hold_key: "Hold to talk (or the space bar)",
    talk_listening: "I'm listening… let go to send",
    talk_off: "The microphone is off",
    coach: "Keep it pressed, then let go.",
    coach_tap: "Keep it pressed while you talk.",
    coach_done: "That's it.",
    state_waiting: "Waiting for Aule…",
    state_initializing: "Aule is getting ready…",
    state_listening: "I'm listening",
    state_your_turn: "Your turn",
    state_thinking: "Thinking…",
    state_speaking: "Talking",
    state_left: "Aule left the session.",
    state_reconnecting: "Reconnecting…",
    show_work: "Show my homework",
    camera_aim: "Hold your homework up to the camera and tap “Done”.",
    camera_send: "Done",
    camera_cancel: "Cancel",
    showing_work: "Aule is looking…",
    shown_work: "Look at my work.",
    camera_off: "The camera turned off.",
    camera_blocked: "Aule can't use your camera.",
    camera_blocked_help: "A grown-up can allow the camera next to the page address (“aA” on an iPhone).",
    camera_missing: "There's no camera, but you can carry on with your voice.",
    camera_busy: "Another app is using the camera.",
    camera_busy_help: "A grown-up can close it and tap “Show my homework” again.",
    camera_unseen: "Bring your homework closer to the camera and try again.",
    end_session: "End",
    clock_label: "Time left",
    type_label: "Message for Aule",
    type_placeholder: "Or write to Aule…",
    send: "Send",
    conversation: "Conversation",
    you: "You",
    you_typed: "You (typed)",
    talk_not_started: "We couldn't tell Aule you're talking; try again.",
    turn_unheard: "Aule didn't hear that; hold the button and say it again.",
    message_failed: "The message couldn't be sent.",
    choices_label: "Tap your answer",
    choices_several: "You can tap more than one, then “Done”.",
    choices_done: "Done",
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
