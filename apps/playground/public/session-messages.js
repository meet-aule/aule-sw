// Fixed lifecycle messages; never show provider exceptions or session contents.
const MESSAGES = {
  es: {
    child_ended: "Terminaste la sesión. Puedes empezar otra cuando quieras.",
    parent_ended: "La sesión se cerró desde esta cuenta. Puedes empezar otra.",
    budget_reached: "Terminó el tiempo de esta sesión. Puedes empezar otra cuando quieras.",
    idle: "La sesión se cerró porque no había actividad. Puedes empezar otra.",
    device_offline: "Se perdió la conexión durante demasiado tiempo. Vuelve a entrar para empezar otra sesión.",
    not_working: "Aule cerró esta sesión. Puedes volver a intentarlo cuando estés listo.",
    provider_error: "El servicio del tutor tuvo un problema. Espera un momento y vuelve a intentarlo.",
    error: "La sesión se interrumpió por un problema técnico. Vuelve a intentarlo en un momento.",
    unknown: "La sesión terminó. Puedes volver a entrar.",
  },
  en: {
    child_ended: "You ended the session. You can start another whenever you like.",
    parent_ended: "The session was ended from this account. You can start another.",
    budget_reached: "This session's time is up. You can start another whenever you like.",
    idle: "The session closed after a period of inactivity. You can start another.",
    device_offline: "The connection was lost for too long. Join again to start another session.",
    not_working: "Aule closed this session. Try again when you are ready.",
    provider_error: "The tutor service had a problem. Wait a moment and try again.",
    error: "A technical problem interrupted the session. Please try again shortly.",
    unknown: "The session ended. You can join again.",
  },
};

export function endedMessage(reason, language = "es") {
  const messages = MESSAGES[language] ?? MESSAGES.es;
  return Object.hasOwn(messages, reason) ? messages[reason] : messages.unknown;
}

const RECOVERY = {
  es: {
    resume: "Continuar sesión anterior", start: "Entrar ahora", restart: "Cerrar la anterior y empezar otra",
    available: "Tu sesión sigue en curso. Continuar conserva el tiempo que quedaba.",
    check_failed: "No pudimos comprobar si había una sesión. Vuelve a abrir esta pantalla para intentarlo otra vez.",
    lost: "La conexión se interrumpió. Elige al mismo alumno y pulsa «Continuar sesión anterior».",
    lost_unknown: "Se perdió la conexión. Vuelve a elegir al alumno para comprobar si puedes continuar.",
    checking: "Comprobando por qué terminó la sesión…",
    close_failed: "Saliste de la sesión, pero no pudimos confirmar el cierre. Se cerrará al vencer la espera de reconexión.",
    failed: "No se pudo continuar la sesión. Vuelve a intentarlo.",
    session_active: "Hay una sesión en curso. Cierra la otra pestaña o continúa desde ella.",
    session_changed: "Esta sesión ya cambió. Vuelve a elegir al alumno.",
    recovery_unavailable: "No pudimos comprobar la sesión. Vuelve a intentarlo.",
  },
  en: {
    resume: "Continue previous session", start: "Join now", restart: "End the previous session and start another",
    available: "Your session is still running. Continuing keeps the time that was left.",
    check_failed: "We could not check for an existing session. Open this screen again to retry.",
    lost: "The connection was interrupted. Choose the same student and press “Continue previous session”.",
    lost_unknown: "The connection was lost. Choose the student again to check whether you can continue.",
    checking: "Checking why the session ended…",
    close_failed: "You left the session, but we could not confirm it ended. It will close when the reconnection wait expires.",
    failed: "The session could not continue. Please try again.",
    session_active: "A session is in progress. Close the other tab or continue there.",
    session_changed: "This session has changed. Choose the student again.",
    recovery_unavailable: "We could not check the session. Please try again.",
  },
};
export function recoveryMessage(key, language = "es") {
  const messages = RECOVERY[language] ?? RECOVERY.es;
  return Object.hasOwn(messages, key) ? messages[key] : messages.failed;
}
