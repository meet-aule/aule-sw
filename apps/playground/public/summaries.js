// What a student did in their latest sessions, as the family's home says it
// (FIGMA.md D35): a line a session, built from the facts the server sends
// (src/students.ts latestSessions) and nothing else. Never what was said or
// typed, the topic written on A04 · Detalles, nor the review's words: those
// stay in Configurar, behind «Ver resúmenes». Nor how many exercises were
// right: the home is the screen a child lands on, with brothers and sisters,
// so it says how many were practised. Pure: nothing here touches the page, so
// the tests import it as it is.

const WORDS = {
  es: {
    today: "Hoy",
    yesterday: "Ayer",
    minutes: "{n} min",
    // Two skills: «{a} y {b}», the second in lower case, as it is mid-sentence.
    and: "{a} y {b}",
    homework: "Tareas de {subject}",
    homework_any: "Tareas",
    exam_prep: "Repaso para una evaluación de {subject}",
    exam_prep_any: "Repaso para una evaluación",
    exam_review: "Revisión de una evaluación de {subject}",
    exam_review_any: "Revisión de una evaluación",
    explore: "Algo nuevo de {subject}",
    explore_any: "Algo nuevo",
    chosen_by_aule: "Aule eligió el tema",
    exercise: "1 ejercicio",
    exercises: "{n} ejercicios",
    break: "1 pausa",
    breaks: "{n} pausas",
    budget_reached: "usó todo el tiempo",
    idle: "se cerró porque no hubo respuesta",
    not_working: "Aule la cerró antes de tiempo",
    device_offline: "se cortó la conexión",
    provider_error: "se cortó por un problema de Aule",
    error: "se cortó por un problema de Aule",
    list: "Últimas sesiones de {name}",
    see_summaries: "Ver resúmenes",
    // Its name starts with the words it shows, for whoever says them to reach it (WCAG 2.5.3).
    see_summaries_of: "Ver resúmenes de {name}",
  },
  en: {
    today: "Today",
    yesterday: "Yesterday",
    minutes: "{n} min",
    and: "{a} and {b}",
    homework: "Homework in {subject}",
    homework_any: "Homework",
    exam_prep: "Practice for a test in {subject}",
    exam_prep_any: "Practice for a test",
    exam_review: "Going over a test in {subject}",
    exam_review_any: "Going over a test",
    explore: "Something new in {subject}",
    explore_any: "Something new",
    chosen_by_aule: "Aule chose the topic",
    exercise: "1 exercise",
    exercises: "{n} exercises",
    break: "1 break",
    breaks: "{n} breaks",
    budget_reached: "used all the time",
    idle: "closed when nobody answered",
    not_working: "Aule closed it early",
    device_offline: "the connection dropped",
    provider_error: "stopped by a problem on Aule's side",
    error: "stopped by a problem on Aule's side",
    list: "{name}'s latest sessions",
    see_summaries: "See summaries",
    see_summaries_of: "See summaries for {name}",
  },
};

// The subjects' names: in Spanish the editor's own (students.js SUBJECTS).
const SUBJECT_NAMES = {
  es: {
    matematica: "Matemática",
    comunicacion: "Comunicación",
    ciencia: "Ciencia y Tecnología",
    personal_social: "Personal Social",
    ingles: "Inglés",
  },
  en: {
    matematica: "Maths",
    comunicacion: "Communication",
    ciencia: "Science",
    personal_social: "Personal and social",
    ingles: "English",
  },
};

// The locale a day is written in: «21 nov.», “21 Nov”.
const LOCALES = { es: "es-PE", en: "en-GB" };
const KINDS = ["homework", "exam_prep", "exam_review", "explore"];
// The ways a session ends that say nothing more: the child's own end, the family's.
const ENDINGS = ["budget_reached", "idle", "not_working", "device_offline", "provider_error", "error"];

/** Every key of the home's words; each is in both languages. */
export const KEYS = Object.freeze(Object.keys(WORDS.es));
/** The subjects the home names, by the platform's codes. */
export const SUBJECTS = Object.freeze(Object.keys(SUBJECT_NAMES.es));

/** The words' language: English or Spanish, the page's own. */
const languageOf = (language) => (language === "en" ? "en" : "es");

/** A subject's name in `language`; "" for one the home does not name. */
export function subjectName(subject, language = "es") {
  const names = SUBJECT_NAMES[languageOf(language)];
  return Object.hasOwn(names, subject) ? names[subject] : "";
}

/** The home's words for `key`, with each {place} filled; "" for a key that is not one of them. */
export function homeWords(key, language = "es", values = {}) {
  const table = WORDS[languageOf(language)];
  if (typeof key !== "string" || !Object.hasOwn(table, key)) return "";
  // A function, so a name with "$" in it is written as it is.
  return table[key].replace(/\{(\w+)\}/g, (_, place) => String(values[place] ?? ""));
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
  return day.toLocaleDateString(LOCALES[language], { day: "numeric", month: "short" });
}

const count = (value, most) => (Number.isInteger(value) && value >= 0 && value <= most ? value : 0);

/** A catalogue name as it reads after «y»: «Comparar fracciones» → «comparar fracciones». */
const midSentence = (name, language) => name.charAt(0).toLocaleLowerCase(LOCALES[language]) + name.slice(1);

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
    tried ? homeWords(tried === 1 ? "exercise" : "exercises", lang, { n: tried }) : "",
    breaks ? homeWords(breaks === 1 ? "break" : "breaks", lang, { n: breaks }) : "",
    ENDINGS.includes(facts?.ending) ? homeWords(facts.ending, lang) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return { when, what };
}
