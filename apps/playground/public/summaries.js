// What a student did in their latest sessions, as the family's home says it
// (FIGMA.md D35): a line a session, built from the facts the server sends
// (src/students.ts latestSessions) and nothing else. Never what was said or
// typed, the topic written on A04 · Detalles, nor the review's words: those
// stay on their own screen, behind «Ver resúmenes». Nor how many exercises were
// right: the home is the screen a child lands on, with brothers and sisters,
// so it says how many were practised. Pure: nothing here touches the page, so
// the tests import it as it is.

import { SOURCE, countIn, keysOf, languageOf, localeOf, wordsIn } from "./i18n.js";

// The words are with the page's others (words/es.js `summary` and `subject`,
// and the same groups of each language). A day is written in the language's
// own locale: «21 nov.», “21 Nov”.
const KINDS = ["homework", "exam_prep", "exam_review", "explore"];
// The ways a session ends that say nothing more: the child's own end, the family's.
const ENDINGS = ["budget_reached", "idle", "not_working", "device_offline", "provider_error", "error"];

/** Every key of the home's words; each is in every language. */
export const KEYS = keysOf("summary");
/** The subjects the home names, by the platform's codes. */
export const SUBJECTS = keysOf("subject");

/** A subject's name in `language`; "" for one the home does not name. */
export function subjectName(subject, language = SOURCE) {
  return wordsIn(language, `subject.${subject}`);
}

/** The home's words for `key`, with each {place} filled; "" for a key that is not one of them. */
export function homeWords(key, language = SOURCE, values = {}) {
  return typeof key === "string" ? wordsIn(language, `summary.${key}`, values) : "";
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** «Hoy», «Ayer» or «21 nov.», in the browser's own time. */
function dayOf(iso, language, now) {
  const day = new Date(iso);
  if (Number.isNaN(day.getTime())) return "";
  const today = new Date(now);
  if (sameDay(day, today)) return homeWords("today", language);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sameDay(day, yesterday)) return homeWords("yesterday", language);
  return day.toLocaleDateString(localeOf(language), { day: "numeric", month: "short" });
}

const count = (value, most) => (Number.isInteger(value) && value >= 0 && value <= most ? value : 0);

/** A catalogue name as it reads after «y»: «Comparar fracciones» → «comparar fracciones». */
const midSentence = (name, language) => name.charAt(0).toLocaleLowerCase(localeOf(language)) + name.slice(1);

/** What the session was about: its skills, else what it was for, else that Aule chose. */
function aboutOf(facts, language) {
  const skills = (Array.isArray(facts.skills) ? facts.skills : []).filter((skill) => typeof skill === "string" && skill).slice(0, 2);
  if (skills.length === 2) return homeWords("and", language, { a: skills[0], b: midSentence(skills[1], language) });
  if (skills.length === 1) return skills[0];
  if (!KINDS.includes(facts.kind)) return homeWords("chosen_by_aule", language);
  const subject = subjectName(facts.subject, language);
  return subject ? homeWords(facts.kind, language, { subject }) : homeWords(`${facts.kind}_any`, language);
}

/**
 * One session as a line of the home: `when` («Hoy · 6 min») and `what` («Sumar
 * hasta 20 · 3 ejercicios · 1 pausa», with an unusual ending last). Only the
 * facts named here are read; anything else in `facts` is never shown.
 */
export function sessionLine(facts, { language = "es", now = Date.now() } = {}) {
  const lang = languageOf(language);
  const minutes = Number.isInteger(facts?.minutes) && facts.minutes > 0 ? homeWords("minutes", lang, { n: facts.minutes }) : "";
  const when = [dayOf(facts?.day, lang, now), minutes].filter(Boolean).join(" · ");
  const tried = count(facts?.tried, 50);
  const breaks = count(facts?.breaks, 20);
  const what = [
    aboutOf(facts ?? {}, lang),
    tried ? countIn(lang, "summary.exercises", tried) : "",
    breaks ? countIn(lang, "summary.breaks", breaks) : "",
    ENDINGS.includes(facts?.ending) ? homeWords(facts.ending, lang) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return { when, what };
}
