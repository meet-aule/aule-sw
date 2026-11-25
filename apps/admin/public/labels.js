// The words the console shows for what the platform answers in codes, and the
// small arithmetic of times and lengths. No page element here: kept apart from
// the pages so it is tested (test/labels.test.mjs), like pilot.js.

const LOCALE = "es-PE";
/** What the page shows where there is nothing. */
export const NONE = "—";

/** An open session's status. */
export const STATUSES = { created: "empezando", active: "en curso", ended: "terminada" };

/** The words for a code, the code itself when there are none for it, and «—» for nothing. */
export function label(words, code) {
  if (code === null || code === undefined || code === "") return NONE;
  return Object.hasOwn(words, code) ? words[code] : String(code);
}

/** Who runs the session: the session engine, or the tutor on its own. */
export const mode = (engine) => (engine ? "motor" : "libre");
/** Where the session came from. */
export const way = (via) => (via === "device" ? "aparato" : "web");

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
