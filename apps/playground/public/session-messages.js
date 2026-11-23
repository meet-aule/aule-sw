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
