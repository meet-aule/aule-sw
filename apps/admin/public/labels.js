// The words the console shows for what the platform answers in codes, and the
// small arithmetic of times and lengths. No page element here: kept apart from
// the pages so it is tested (test/labels.test.mjs), like pilot.js.

const LOCALE = "es-PE";
/** What the page shows where there is nothing. */
export const NONE = "—";

/** An open session's status. */
export const STATUSES = { created: "empezando", active: "en curso", ended: "terminada" };
/** A family's plan, as the panel has always named it (the platform's plans::Plan). */
export const PLANS = { trial: "Prueba", paid: "Pagado", granted: "Regalado", none: "Sin plan", team: "Equipo", free: "Gratis ilimitado" };
/** How a session ended (the platform's sessions::END_REASONS). */
export const ENDINGS = {
  child_ended: "la terminó el alumno",
  idle: "sin actividad",
  budget_reached: "se acabó el tiempo",
  parent_ended: "la terminó la familia",
  device_offline: "nadie entró o se desconectó",
  not_working: "cerrada por no trabajar",
  error: "error",
  provider_error: "falló un servicio",
};
/** What a family was told (the platform's notices). */
export const NOTICES = { session_summary: "resumen de sesión", attention: "atención", session_stopped: "sesión detenida" };
/** The kinds of consent, in the order the family page shows them (the platform's families::PURPOSES). */
export const CONSENTS = { voice: "Voz", transcripts: "Transcripciones", memory: "Memoria" };
export const LANGUAGES = { es: "español", en: "inglés" };

/** The words for a code, the code itself when there are none for it, and «—» for nothing. */
export function label(words, code) {
  if (code === null || code === undefined || code === "") return NONE;
  return Object.hasOwn(words, code) ? words[code] : String(code);
}

/** Who runs the session: the session engine, or the tutor on its own. */
export const mode = (engine) => (engine ? "motor" : "libre");
/** Where the session came from. */
export const way = (via) => (via === "device" ? "aparato" : "web");

const dated = (iso, options) => {
  const at = new Date(iso ?? NaN);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleDateString(LOCALE, options);
};
/** «3 nov.», or nothing. */
export const day = (iso) => dated(iso, { day: "numeric", month: "short" });
/** «3 nov. 2026», or nothing. */
export const dayYear = (iso) => dated(iso, { day: "numeric", month: "short", year: "numeric" });
/** «3 nov., 10:42», or «—». */
export const dayTime = (iso) => (day(iso) ? `${day(iso)}, ${clock(new Date(iso))}` : NONE);

/** «10:42», in the browser's own time. */
export const clock = (date) => date.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** «10:42:05» */
export const clockSeconds = (date) =>
  date.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

/** How long ago, in whole minutes: «hace un momento», «hace 12 min», «hace 2 h 5 min». */
export function ago(iso, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(minutes)) return NONE;
  if (minutes < 1) return "hace un momento";
  if (minutes < 60) return `hace ${minutes} min`;
  return `hace ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Since when: «10:42, hace 12 min». */
export function since(iso, now = Date.now()) {
  const at = new Date(iso ?? NaN);
  return Number.isNaN(at.getTime()) ? NONE : `${clock(at)}, ${ago(iso, now)}`;
}

/** A family's plan in one line: «Regalado hasta 23 dic. · quedan 2 de 3», as the panel has always said it. */
export function planText(standing) {
  if (!standing) return "";
  const until = standing.ends_at ? ` hasta ${day(standing.ends_at)}` : "";
  const left = standing.left == null || standing.plan === "none" ? "" : ` · quedan ${standing.left} de ${standing.allowed}`;
  return `${label(PLANS, standing.plan)}${until}${left}`;
}

/** The trial: from the first session that counts, for seven days. */
export function trialText(trial) {
  if (!trial?.started_at) return "Prueba: empieza con la primera sesión.";
  return `Prueba: del ${dayYear(trial.started_at)} al ${dayYear(trial.ends_at)}.`;
}

/** How many days a plan ran or runs, rounded. */
export const planDays = (plan) => {
  const days = Math.round((Date.parse(plan.ends_at) - Date.parse(plan.starts_at)) / 86_400_000);
  return Number.isFinite(days) ? String(days) : NONE;
};

/** Who gave a plan: a team member's address, «operador» for a grant with the operator's token, «—» for a paid one. */
export const grantedBy = (plan) => (plan.plan === "granted" ? plan.granted_by || "operador" : NONE);

/** What a kind of consent says now: «sí, 3 nov. (app)», «no, 4 nov. (app)», or «no» when never answered. */
export function consentText(answer) {
  if (!answer?.at) return "no";
  return `${answer.granted === true ? "sí" : "no"}, ${day(answer.at)}${answer.source ? ` (${answer.source})` : ""}`;
}

/** How a guardian gets notices. */
export function noticesBy(guardian) {
  const ways = [guardian.notices_by_email && "correo", guardian.notices_by_push && "teléfono"].filter(Boolean);
  return ways.length ? ways.join(" y ") : "ninguno";
}

/** A session's length in whole minutes; «—» when it never started or the housekeeping closed it. */
export const length = (seconds) => (typeof seconds === "number" && Number.isFinite(seconds) ? `${Math.round(seconds / 60)} min` : NONE);

/** How a session ended, or that it has not ended yet. */
export const ending = (session) => (session.status === "ended" ? label(ENDINGS, session.end_reason) : label(STATUSES, session.status));

/** A child's age, from the platform; «—» when the family did not say the year. */
export const age = (years) => (Number.isInteger(years) ? `${years} años` : NONE);

/** Hours after which the housekeeping closes a session left open (the platform's jobs.rs). */
export const CLOSED_AFTER_HOURS = 3;

/**
 * The one line on «En vivo»: whether a deploy can go now. Restarting the
 * playground or the agent ends the sessions in progress, so every open session
 * counts, the team's tests too; one open too long is said apart, and still
 * counted. Only an answer that says, in so many words, that none is open
 * makes it safe.
 */
export function verdict(live) {
  const open = live?.open;
  if (!Number.isInteger(open) || open < 0) return { safe: false, text: "No se sabe si hay sesiones abiertas: no despliegues todavía." };
  if (open === 0) return { safe: true, text: "Ninguna sesión abierta: se puede desplegar." };
  const text = open === 1 ? "1 sesión abierta: no despliegues ahora." : `${open} sesiones abiertas: no despliegues ahora.`;
  const overdue = Number.isInteger(live.overdue) ? live.overdue : 0;
  if (overdue < 1) return { safe: false, text };
  const minutes = live.overdue_after_minutes;
  const stuck =
    overdue === 1
      ? `1 lleva más de ${minutes} minutos: puede estar colgada; la limpieza la cierra a las ${CLOSED_AFTER_HOURS} horas.`
      : `${overdue} llevan más de ${minutes} minutos: pueden estar colgadas; la limpieza las cierra a las ${CLOSED_AFTER_HOURS} horas.`;
  return { safe: false, text: `${text} ${stuck}` };
}
