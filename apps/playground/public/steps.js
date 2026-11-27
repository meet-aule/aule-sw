// The screens of the Figma «Login-Aule» v8 that the page follows, and the
// rules for moving between them. Pure data and functions: nothing here touches
// the page, so the tests import it as it is. FIGMA.md maps it all to the file.

import { SOURCE, countIn, localeOf, wordsIn } from "./i18n.js";

/** The Figma file the page follows (read-only; Code Connect is not on the team's plan). */
export const FIGMA_FILE = "yOAIYJNl5nZ7NgWtESN0Fo";

/**
 * The named parts of the progress header (Barra de progreso/Base 160:1415),
 * with the steps each has on the web. The Figma's «Enlazar Aule» links the
 * device; on the web it is the child's profile. «Conocer a tu hijo» left the
 * onboarding: the interview is offered on the home, after the first session (D34).
 * `name` is the Figma's; the page says each part in its language, by `key`
 * (words/es.js `progress`).
 */
export const SEGMENTS = [
  { key: "account", name: "Tu cuenta", steps: 2 },
  { key: "profile", name: "Su perfil", steps: 2 },
];

/**
 * Every screen of the page, by its data-screen. For each:
 * - code, name: the Figma frame it follows ("" for a screen the Figma does not draw);
 * - nodes: the ids its <!-- Figma: … --> comment names (frames, or the components a
 *   web-only screen is built from);
 * - surface: "paper" (the parent's, page 160:1345) or "ink" (the device's, page 190:717);
 * - auth: "out" signed out only, "in" signed in only;
 * - progress: [part, step] in SEGMENTS, or null for the plain line;
 * - plainComingBack: the plain line when reached from P13 (a returning parent is not onboarding);
 * - back: where «← Atrás» goes when nothing came before it in this visit;
 * - needs: what the page must hold for the screen to make sense (see screens.js).
 */
export const SCREENS = {
  // One entry for every family, with email and providers together (D42).
  p01: { code: "P01", name: "Entra a Aule", nodes: ["160:1636", "160:1455", "160:1624", "160:1755"], surface: "paper", auth: "out", progress: null, back: null },
  p03: { code: "P03", name: "Código", nodes: ["160:1604", "160:1768"], surface: "paper", auth: "out", progress: null, back: "p01", needs: "email" },
  p04: { code: "P04", name: "Tu autorización", nodes: ["160:1592", "160:1442", "160:1994"], surface: "paper", auth: "in", progress: [1, 1], back: "home" },
  // The interview, offered on the home after the first session, for a child the family has (D34);
  // the grade first, the one answer the next session uses.
  p05: { code: "P05", name: "Conozcamos a tu hijo", nodes: ["160:1581", "160:1789"], surface: "paper", auth: "in", progress: null, back: "home", needs: "interview" },
  "p06-grade": { code: "", name: "Entrevista · grado", nodes: ["161:2101", "160:1374"], surface: "paper", auth: "in", progress: null, back: "p05", needs: "interview" },
  p06: { code: "P06", name: "Entrevista · expectativas", nodes: ["160:1568", "160:1801"], surface: "paper", auth: "in", progress: null, back: "p06-grade", needs: "interview" },
  p07: { code: "P07", name: "Entrevista · gustos", nodes: ["160:1547", "160:1815"], surface: "paper", auth: "in", progress: null, back: "p06", needs: "interview" },
  // The name, an optional grade, and the first session: P12's «Empezar su primera sesión» is folded in (D34).
  "p10-name": { code: "", name: "¿Cómo lo llamamos?", nodes: ["160:1493", "160:1877", "161:2101", "160:1355", "160:1392"], surface: "paper", auth: "in", progress: [1, 2], back: "p04", needs: "consent" },
  p14: { code: "P14", name: "Revisa tu correo", nodes: ["160:1688", "160:1948"], surface: "paper", auth: "out", progress: null, back: "p03", needs: "email" },
  p15: { code: "P15", name: "Escríbenos", nodes: ["160:1701", "160:1962"], surface: "paper", auth: "out", progress: null, back: "p14" },
  home: { code: "", name: "Tus alumnos", nodes: ["161:2101", "161:2110", "161:2104", "161:2096"], surface: "paper", auth: "in", progress: null, back: null },
  summaries: { code: "", name: "Resúmenes", nodes: ["161:2101", "161:2096"], surface: "paper", auth: "in", progress: null, back: "home", needs: "summaries" },
  editor: { code: "", name: "Configurar", nodes: ["161:2101", "160:1355", "160:1374", "160:1397", "160:1392", "161:2104"], surface: "paper", auth: "in", progress: null, back: "home", needs: "editing" },
  // The hand-off from p10-name's «Empezar su primera sesión»: the parent's browser becomes the child's screen.
  a02: { code: "A02", name: "¿Eres tú?", nodes: ["410:629"], surface: "ink", auth: "in", progress: null, back: "home", needs: "handoff" },
  a04: { code: "A04", name: "¿Qué hacemos hoy?", nodes: ["190:891"], surface: "ink", auth: "in", progress: null, back: "home", needs: "student" },
  "a04-details": { code: "", name: "Detalles", nodes: ["190:891", "191:1333", "190:834"], surface: "ink", auth: "in", progress: null, back: "a04", needs: "objective" },
  a05: { code: "A05", name: "Antes de empezar", nodes: ["190:899", "190:1005"], surface: "ink", auth: "in", progress: null, back: "a04", needs: "student" },
  session: { code: "A15", name: "La sesión empieza", nodes: ["190:1069", "194:509"], surface: "ink", auth: "in", progress: null, back: "home", needs: "session" },
  "session-end": { code: "", name: "La sesión terminó", nodes: ["190:1069", "190:834", "195:513"], surface: "ink", auth: "in", progress: null, back: "home", needs: "ended" },
};

/**
 * The progress header of a screen: each part with its steps, how many are
 * done and whether it is the current one; null for the plain 2 px line.
 * `flow` is "new" for a family signing up and "back" for one coming back.
 */
export function progressAt(id, flow = "new") {
  const screen = SCREENS[id];
  if (!screen?.progress || (flow === "back" && screen.plainComingBack)) return null;
  const [part, step] = screen.progress;
  return SEGMENTS.map((segment, index) => ({
    key: segment.key,
    name: segment.name,
    steps: segment.steps,
    done: index < part ? segment.steps : index === part ? step : 0,
    current: index === part,
  }));
}

/**
 * What a student can say a session is for (A04 · Aparato 190:891), with the
 * Figma's icons. `key` names its words in first-steps.js, in the student's language.
 */
export const KINDS = [
  { kind: "homework", key: "kind_homework", icon: "task_alt" },
  { kind: "exam_prep", key: "kind_exam_prep", icon: "assignment" },
  { kind: "explore", key: "kind_explore", icon: "school" },
  // Aule decides: the session carries no objective.
  { kind: "", key: "kind_none", icon: "help_outline" },
];
/** The fifth kind the platform knows, kept on the web as a link under the tiles. */
export const REVIEW = { kind: "exam_review", key: "kind_exam_review" };
/** A day matters for these: when the homework is due, when the evaluation is. */
export const DATED = ["homework", "exam_prep"];
/** The one subject Aule has exercises of its own for today. */
export const OWN_SUBJECT = "matematica";

/** The key of the words a kind is shown with (first-steps.js), as its tile and the title of its details. */
export function kindKey(kind) {
  return kind === REVIEW.kind ? REVIEW.key : (KINDS.find((one) => one.kind === kind)?.key ?? "");
}

/**
 * The objective a session is asked with, or null when the student left it
 * to Aule. The date goes only with homework and evaluations.
 */
export function objectiveFor(kind, { subject = "other", topic = "", due = "" } = {}) {
  if (!kind) return null;
  return {
    kind,
    subject: subject || "other",
    topic: topic.trim(),
    due: DATED.includes(kind) && due ? due : null,
  };
}

/**
 * The subject a session starts on: one the family wants reinforced, and among
 * those the one Aule has exercises for; else the first the platform keeps;
 * else "other". The platform keeps them in its own order, so the family's
 * first would not be the first.
 */
export function defaultSubject(wanted, kept) {
  const offered = (wanted ?? []).filter((subject) => kept?.includes(subject));
  const choices = offered.length ? offered : (kept ?? []);
  return choices.includes(OWN_SUBJECT) ? OWN_SUBJECT : (choices[0] ?? "other");
}

/** P07's options (Entrevista · gustos 160:1547), as the Figma writes them. */
export const LIKES = ["Deportes", "Videojuegos", "Animales y naturaleza", "Espacio y ciencia", "Música y arte", "Libros e historias"];
const MAX_INTERESTS = 10;
const MAX_INTEREST_CHARS = 40;

/**
 * What a child likes, from P07: the options picked and what was typed, split
 * at commas and semicolons, in lower case, without repeats. At most ten, each
 * up to 40 characters; past that, the reason why not.
 */
export function interestsFrom(picked, typed = "") {
  const all = [...picked, ...typed.split(/[,;]/)].map((text) => text.trim().toLowerCase()).filter(Boolean);
  const interests = [...new Set(all)];
  if (interests.some((text) => text.length > MAX_INTEREST_CHARS)) return { error: "too_long" };
  if (interests.length > MAX_INTERESTS) return { error: "too_many" };
  return { interests };
}

/** An address shown without giving it away: its first two letters, «•••», and the domain. */
export function maskEmail(address) {
  const [name, domain] = String(address).trim().split("@");
  if (!name || !domain) return "";
  return `${name.slice(0, 2)}•••@${domain}`;
}

/** The six digits of a code typed or pasted any way ("519 042", "519-042"): digits only, six at most. */
export function codeDigits(text) {
  return String(text).replace(/\D/g, "").slice(0, 6);
}

/** What P13 says first: a welcome back only for a browser that signed in before (Nota · P13 · Saludo). */
export function greeting(returning) {
  return returning ? "¡Qué bueno que estés de vuelta!" : "Te damos la bienvenida";
}

const DAY_MS = 86_400_000;

/**
 * What the family's plan allows now, in a line of `lang`; and whether a
 * session can start. The words are the plan's own (words/es.js `plan`), as the
 * landing and the family guide say them: «el plan Aule», S/59 al mes, 3
 * sesiones cada 7 días, 7 días gratis. Nobody can pay in the app yet: the team
 * activates the plan of a family who writes in, so a granted plan reads like a
 * paid one.
 */
export function planLine(plan, lang = SOURCE, now = Date.now()) {
  if (!plan) return { text: "", open: true };
  if (plan.plan === "team") return { text: wordsIn(lang, "plan.team"), open: true };
  if (plan.plan === "free") return { text: wordsIn(lang, "plan.free"), open: true };
  const left = plan.left ?? 0;
  if (plan.plan === "trial" && !plan.ends_at) return { text: wordsIn(lang, "plan.trial_new"), open: true };
  if (plan.plan === "trial") {
    const days = Math.max(1, Math.ceil((new Date(plan.ends_at) - now) / DAY_MS));
    return { text: countIn(lang, left > 0 ? "plan.trial_open" : "plan.trial_used", days), open: left > 0 };
  }
  const locale = localeOf(lang);
  if (plan.plan === "paid" || plan.plan === "granted") {
    const values = { date: new Date(plan.ends_at).toLocaleDateString(locale, { day: "numeric", month: "long" }), allowed: plan.allowed };
    return { text: left > 0 ? countIn(lang, "plan.left", left, values) : wordsIn(lang, "plan.used", values), open: left > 0 };
  }
  const price = new Intl.NumberFormat(locale).format((plan.price?.amount_cents ?? 5900) / 100);
  return { text: wordsIn(lang, "plan.over", { price, sessions: plan.price?.sessions_per_week ?? 3 }), open: false };
}
