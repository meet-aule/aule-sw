// The fixed words for how a session ends and for one a reload left open, in
// the session's language. They show on the student's screens, in two web-only
// states the Figma does not draw (FIGMA.md): the end screen after A15 and A05's
// «¿Seguimos donde nos quedamos?». So they speak as the device does and as the
// tutor's own lines (apps/agent replies.py) do: to the student, short, warm.
// They never carry a provider's exception or anything the session held.

// Each ending under the end screen's «La sesión terminó.», by the platform's
// end_reason; "unknown" for a session with no reason kept.
const MESSAGES = {
  es: {
    child_ended: "¡Chau! Gracias por la sesión de hoy. Nos vemos pronto.",
    parent_ended: "Se cerró desde la cuenta de tu familia. Cuando quieras, empezamos otra.",
    budget_reached: "Se nos acabó el tiempo. ¡Buen trabajo! Hasta la próxima.",
    idle: "Parece que tuviste que irte, así que Aule cerró la sesión. Cuando quieras, empezamos otra.",
    device_offline: "Se perdió la conexión por mucho rato. Cuando vuelvas a conectarte, empezamos otra.",
    not_working: "Lo dejamos aquí por hoy. Aule le avisó a tu familia para buscar otro momento.",
    provider_error: "Aule tuvo un problema con su servicio y no pudo seguir. Espera un momento y vuelve a intentarlo.",
    error: "Algo falló y la sesión se cortó. Espera un momento y vuelve a intentarlo.",
    unknown: "Cuando quieras, empezamos otra.",
  },
  en: {
    child_ended: "Bye! Thanks for today's session. See you soon.",
    parent_ended: "It was closed from your family's account. We can start another whenever you like.",
    budget_reached: "That is all our time. Good work! See you next time.",
    idle: "It looks like you had to go, so Aule closed the session. We can start another whenever you like.",
    device_offline: "The connection was lost for too long. When you are back online, we can start another.",
    not_working: "We stop here for today. Aule told your family, so you can find another time.",
    provider_error: "Aule had a problem with its tutor service and could not go on. Wait a moment and try again.",
    error: "Something went wrong and the session stopped. Wait a moment and try again.",
    unknown: "We can start another whenever you like.",
  },
};

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
    available: "Tu sesión sigue abierta y Aule te está esperando. Si sigues, no pierdes el tiempo que te quedaba; si empiezas otra, esta se cierra.",
    resume: "Seguir con la sesión",
    restart: "Empezar otra sesión",
    start: "Empezar la sesión",
    check_failed: "No pudimos revisar si tu sesión anterior sigue abierta. Vuelve atrás y entra otra vez para intentarlo.",
    // The end screen: its titles, and what it says while it asks why.
    ended: "La sesión terminó.",
    checking_title: "Un momento…",
    checking: "Estamos revisando qué pasó con la sesión.",
    lost_title: "Se cortó la conexión.",
    lost: "Tu sesión sigue abierta y Aule te está esperando. Si sigues pronto, no pierdes el tiempo que te quedaba.",
    lost_unknown: "No pudimos revisar si tu sesión sigue abierta. Vuelve atrás y entra otra vez para ver si podemos seguir.",
    close_failed: "Saliste de la sesión, pero no pudimos confirmar que se cerró. Se cerrará sola en un par de minutos.",
    // When carrying on cannot be done; "failed" for anything else.
    failed: "No pudimos seguir con la sesión. Vuelve a intentarlo.",
    session_active: "Tu sesión está abierta en otra pestaña. Ciérrala o sigue desde allí.",
    session_changed: "Esta sesión cambió en otra pestaña. Vuelve atrás y entra otra vez.",
    recovery_unavailable: "No pudimos revisar tu sesión. Vuelve a intentarlo en un momento.",
  },
  en: {
    resume_title: "Shall we carry on where we left off?",
    available: "Your session is still open and Aule is waiting for you. If you carry on, you keep the time you had left; if you start another, this one closes.",
    resume: "Continue the session",
    restart: "Start another session",
    start: "Start the session",
    check_failed: "We could not check whether your last session is still open. Go back and come in again to try.",
    ended: "The session ended.",
    checking_title: "One moment…",
    checking: "We are checking what happened to the session.",
    lost_title: "The connection was cut.",
    lost: "Your session is still open and Aule is waiting for you. If you carry on soon, you keep the time you had left.",
    lost_unknown: "We could not check whether your session is still open. Go back and come in again to see if we can carry on.",
    close_failed: "You left the session, but we could not confirm it closed. It will close by itself in a couple of minutes.",
    failed: "We could not carry on with the session. Please try again.",
    session_active: "Your session is open in another tab. Close it or carry on from there.",
    session_changed: "This session changed in another tab. Go back and come in again.",
    recovery_unavailable: "We could not check your session. Try again in a moment.",
  },
};

export function recoveryMessage(key, language = "es") {
  const messages = wordsIn(RECOVERY, language);
  return Object.hasOwn(messages, key) ? messages[key] : messages.failed;
}
