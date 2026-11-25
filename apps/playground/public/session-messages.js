// The fixed words for how a session ends, for one a reload left open and for
// one whose tutor did not arrive, in the session's language. They show on the
// student's screens, in web-only states the Figma does not draw (FIGMA.md): the
// end screen after A15, A05's «¿Seguimos donde nos quedamos?» and the session
// waiting for Aule. So they speak as the device does and as the tutor's own
// lines (apps/agent replies.py) do: to the student, one short sentence each
// (D33), warm, and without an exclamation mark. They never carry a provider's
// exception or anything the session held.

// Each ending under the end screen's «La sesión terminó.», by the platform's
// end_reason; "unknown" for a session with no reason kept.
const MESSAGES = {
  es: {
    child_ended: "Gracias por la sesión de hoy, nos vemos pronto.",
    parent_ended: "Se cerró desde la cuenta de tu familia.",
    budget_reached: "Buen trabajo, se nos acabó el tiempo.",
    idle: "Parece que tuviste que irte, así que Aule cerró la sesión.",
    device_offline: "Se perdió la conexión por mucho rato.",
    not_working: "Lo dejamos aquí por hoy, y Aule le avisó a tu familia.",
    provider_error: "Aule tuvo un problema con su servicio; vuelve a intentarlo en un momento.",
    error: "Algo falló y la sesión se cortó; vuelve a intentarlo en un momento.",
    unknown: "Cuando quieras, empezamos otra.",
  },
  en: {
    child_ended: "Thanks for today's session, see you soon.",
    parent_ended: "It was closed from your family's account.",
    budget_reached: "Good work, that is all our time.",
    idle: "It looks like you had to go, so Aule closed the session.",
    device_offline: "The connection was lost for too long.",
    not_working: "We stop here for today, and Aule told your family.",
    provider_error: "Aule had a problem with its tutor service; try again in a moment.",
    error: "Something went wrong and the session stopped; try again in a moment.",
    unknown: "We can start another whenever you like.",
  },
};

/** Every way a session ends that has words of its own, "unknown" included. */
export const ENDINGS = Object.freeze(Object.keys(MESSAGES.es));

// The languages the page has these words in: MESSAGES above and RECOVERY below both have each.
const LANGUAGES = ["es", "en"];

/**
 * The language the words for a session in `language` are in: its own when the
 * page has words in it, else Spanish. The page marks each element it writes
 * them into with it (lang), since the page itself is Spanish.
 */
export function languageOf(language) {
  return LANGUAGES.includes(language) ? language : "es";
}

const wordsIn = (table, language) => table[languageOf(language)];

export function endedMessage(reason, language = "es") {
  const messages = wordsIn(MESSAGES, language);
  return Object.hasOwn(messages, reason) ? messages[reason] : messages.unknown;
}

const RECOVERY = {
  es: {
    // A05's web-only state: the session is still open and its tutor waiting.
    resume_title: "¿Seguimos donde nos quedamos?",
    available: "Tu sesión sigue abierta y Aule te está esperando.",
    resume: "Seguir con la sesión",
    restart: "Empezar otra sesión",
    start: "Empezar la sesión",
    check_failed: "No pudimos revisar tu sesión anterior; vuelve atrás y entra otra vez.",
    // The session's title (A15), and the end screen's: its titles, and what it says while it asks why.
    started: "La sesión empezó.",
    ended: "La sesión terminó.",
    checking_title: "Un momento…",
    checking: "Estamos revisando qué pasó con la sesión.",
    lost_title: "Se cortó la conexión.",
    lost: "Tu sesión sigue abierta y Aule te está esperando.",
    lost_unknown: "No pudimos revisar tu sesión; vuelve atrás y entra otra vez.",
    close_failed: "Saliste de la sesión, y se cerrará sola en un par de minutos.",
    // When carrying on cannot be done; "failed" for anything else.
    failed: "No pudimos seguir con la sesión; vuelve a intentarlo.",
    session_active: "Tu sesión está abierta en otra pestaña; sigue desde allí.",
    session_changed: "Esta sesión cambió en otra pestaña; vuelve atrás y entra otra vez.",
    recovery_unavailable: "No pudimos revisar tu sesión; inténtalo en un momento.",
    // The session while Aule does not arrive: its title, the line under it (with
    // «Intentar otra vez»), and the end screen of a session it never came to.
    missing_title: "Aule no pudo llegar",
    tutor_missing: "No es tu culpa.",
    no_tutor: "Aule no llegó a esta sesión, así que no cuenta.",
  },
  en: {
    resume_title: "Shall we carry on where we left off?",
    available: "Your session is still open and Aule is waiting for you.",
    resume: "Continue the session",
    restart: "Start another session",
    start: "Start the session",
    check_failed: "We could not check your last session; go back and come in again.",
    started: "The session started.",
    ended: "The session ended.",
    checking_title: "One moment…",
    checking: "We are checking what happened to the session.",
    lost_title: "The connection was cut.",
    lost: "Your session is still open and Aule is waiting for you.",
    lost_unknown: "We could not check your session; go back and come in again.",
    close_failed: "You left the session, and it will close by itself in a couple of minutes.",
    failed: "We could not carry on with the session; please try again.",
    session_active: "Your session is open in another tab; carry on from there.",
    session_changed: "This session changed in another tab; go back and come in again.",
    recovery_unavailable: "We could not check your session; try again in a moment.",
    missing_title: "Aule couldn't make it",
    tutor_missing: "It's not your fault.",
    no_tutor: "Aule didn't make it to this session, so it doesn't count.",
  },
};

/** Every key of the recovery's words; each is in both languages. */
export const RECOVERY_KEYS = Object.freeze(Object.keys(RECOVERY.es));

export function recoveryMessage(key, language = "es") {
  const messages = wordsIn(RECOVERY, language);
  return Object.hasOwn(messages, key) ? messages[key] : messages.failed;
}
