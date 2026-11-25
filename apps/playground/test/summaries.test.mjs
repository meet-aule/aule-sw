// The lines the family's home says about a student's latest sessions
// (public/summaries.js, FIGMA.md D35): facts only, in Spanish and in English.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { KEYS, SUBJECTS, homeWords, sessionLine, subjectName } from "../public/summaries.js";
import { words } from "../public/first-steps.js";

// The editor's subjects (students.js touches the page as it loads, so it is read as text).
const editor = await readFile(new URL("../public/students.js", import.meta.url), "utf8");
const EDITOR_SUBJECTS = Object.fromEntries(
  [...(editor.match(/export const SUBJECTS = \{([^}]*)\}/)?.[1] ?? "").matchAll(/(\w+): "([^"]+)"/g)].map(([, code, name]) => [code, name]),
);

// A Tuesday afternoon, in this machine's own time, like the family's browser.
const NOW = new Date(2026, 10, 24, 15, 30).getTime();
const at = (...parts) => new Date(...parts).toISOString();
const SESSION = {
  day: at(2026, 10, 24, 10, 0),
  minutes: 6,
  kind: null,
  subject: null,
  skills: [],
  tried: 0,
  breaks: 0,
  ending: "child_ended",
};
const line = (facts, language = "es") => sessionLine({ ...SESSION, ...facts }, { language, now: NOW });

test("every word is there in Spanish and in English, calm, with the same places to fill", () => {
  assert.ok(KEYS.length >= 20);
  for (const key of KEYS) {
    const es = homeWords(key, "es");
    const en = homeWords(key, "en");
    assert.ok(es && en, key);
    for (const text of [es, en]) assert.doesNotMatch(text, /[!¡]/, `${key}: no exclamation mark`);
    // Each language fills the same places, and leaves none unfilled.
    const marked = Object.fromEntries(["n", "name", "subject", "a", "b"].map((place) => [place, `⟨${place}⟩`]));
    const places = (language) => [...homeWords(key, language, marked).matchAll(/⟨(\w+)⟩/g)].map(([, place]) => place).sort();
    assert.deepEqual(places("es"), places("en"), key);
    assert.doesNotMatch(homeWords(key, "es", marked) + homeWords(key, "en", marked), /[{}]/, key);
  }
  // A name is written as it is, «$» and all.
  assert.equal(homeWords("list", "es", { name: "$& Mati" }), "Últimas sesiones de $& Mati");
  assert.equal(homeWords("list", "en", { name: "Mati" }), "Mati's latest sessions");
  assert.equal(homeWords("see_summaries", "es"), "Ver resúmenes");
  assert.equal(homeWords("see_summaries", "en"), "See summaries");
  // The link's name starts with the words it shows, so saying them reaches it (WCAG 2.5.3).
  for (const language of ["es", "en"]) {
    assert.ok(homeWords("see_summaries_of", language, { name: "Liam" }).startsWith(homeWords("see_summaries", language)), language);
  }
  assert.equal(homeWords("see_summaries_of", "es", { name: "Liam" }), "Ver resúmenes de Liam");
  assert.equal(homeWords("nope", "es"), "");
});

test("the subjects are named as the editor names them, and in English as the child's screens do", () => {
  assert.deepEqual([...SUBJECTS], Object.keys(EDITOR_SUBJECTS));
  for (const subject of SUBJECTS) {
    assert.equal(subjectName(subject, "es"), EDITOR_SUBJECTS[subject], subject);
    assert.equal(subjectName(subject, "es"), words(`subject_${subject}`, "es"), subject);
    assert.equal(subjectName(subject, "en"), words(`subject_${subject}`, "en"), subject);
  }
  assert.equal(subjectName("latin", "es"), "");
  assert.equal(subjectName("__proto__", "es"), "");
});

test("«Hoy» and «Ayer» turn at the browser's midnights, and an older day is its date", () => {
  assert.equal(line({ day: at(2026, 10, 24, 0, 0, 0) }).when, "Hoy · 6 min");
  assert.equal(line({ day: at(2026, 10, 23, 23, 59, 59) }).when, "Ayer · 6 min");
  assert.equal(line({ day: at(2026, 10, 23, 0, 0, 0) }).when, "Ayer · 6 min");
  assert.match(line({ day: at(2026, 10, 22, 23, 59, 59) }).when, /^22 nov\.? · 6 min$/);
  assert.equal(line({ day: at(2026, 10, 24, 9, 0) }, "en").when, "Today · 6 min");
  assert.equal(line({ day: at(2026, 10, 23, 9, 0) }, "en").when, "Yesterday · 6 min");
  assert.match(line({ day: at(2026, 10, 21, 9, 0) }, "en").when, /^21 Nov · 6 min$/);
  // Across a month's end and a year's.
  const newYear = new Date(2027, 0, 1, 8, 0).getTime();
  assert.equal(sessionLine({ ...SESSION, day: at(2026, 11, 31, 22, 0) }, { now: newYear }).when, "Ayer · 6 min");
  // A length that is not known is left out; so is a day that is not one.
  assert.equal(line({ minutes: null }).when, "Hoy");
  assert.equal(line({ day: "not a day" }).when, "6 min");
});

test("what a session was: its skills, else what it was for, else that Aule chose", () => {
  assert.equal(line({ skills: ["Sumar hasta 20"] }).what, "Sumar hasta 20");
  // The second, mid-sentence after «y», in lower case, as Spanish writes it.
  assert.equal(line({ skills: ["Sumar hasta 20", "Restar hasta 10", "Contar hasta 100"] }).what, "Sumar hasta 20 y restar hasta 10");
  assert.equal(
    line({ skills: ["Sumar fracciones de igual denominador", "Comparar fracciones"] }).what,
    "Sumar fracciones de igual denominador y comparar fracciones",
  );
  assert.equal(line({ skills: ["Sumar hasta 20", "Restar hasta 10"] }, "en").what, "Sumar hasta 20 and restar hasta 10");
  assert.equal(line({ skills: ["Sumar hasta 20", "Ángulos rectos"] }).what, "Sumar hasta 20 y ángulos rectos");
  assert.equal(line({ kind: "homework", subject: "matematica" }).what, "Tareas de Matemática");
  assert.equal(line({ kind: "homework", subject: "other" }).what, "Tareas");
  assert.equal(line({ kind: "exam_prep", subject: "comunicacion" }).what, "Repaso para una evaluación de Comunicación");
  assert.equal(line({ kind: "exam_review", subject: "ingles" }).what, "Revisión de una evaluación de Inglés");
  assert.equal(line({ kind: "explore", subject: "ciencia" }).what, "Algo nuevo de Ciencia y Tecnología");
  assert.equal(line({ kind: "homework", subject: "matematica" }, "en").what, "Homework in Maths");
  assert.equal(line({ kind: "explore", subject: null }, "en").what, "Something new");
  assert.equal(line({}).what, "Aule eligió el tema");
  assert.equal(line({}, "en").what, "Aule chose the topic");
  // Skills say more than what the family asked for, so they come first.
  assert.equal(line({ kind: "homework", subject: "matematica", skills: ["Sumar hasta 20"] }).what, "Sumar hasta 20");
});

test("one exercise and one break are said in the singular, more in the plural; how many were right, never", () => {
  assert.equal(line({ tried: 1 }).what, "Aule eligió el tema · 1 ejercicio");
  assert.equal(line({ tried: 4 }).what, "Aule eligió el tema · 4 ejercicios");
  assert.equal(line({ breaks: 1 }).what, "Aule eligió el tema · 1 pausa");
  assert.equal(line({ breaks: 2 }).what, "Aule eligió el tema · 2 pausas");
  assert.equal(line({ tried: 1, breaks: 1 }, "en").what, "Aule chose the topic · 1 exercise · 1 break");
  assert.equal(line({ tried: 4, breaks: 2 }, "en").what, "Aule chose the topic · 4 exercises · 2 breaks");
  // The home is the screen a child lands on, brothers and sisters too: no score is said there,
  // even one the facts carried (the review of 24 Nov).
  for (const language of ["es", "en"]) {
    const said = line({ tried: 4, right: 0 }, language).what + line({ tried: 4, right: 4 }, language).what;
    assert.doesNotMatch(said, /\b0 de|bien\b|right\b|\bof 4/, language);
  }
  // No exercise tried, no break: nothing said of them.
  assert.equal(line({ tried: 0, breaks: 0 }).what, "Aule eligió el tema");
});

test("an ordinary ending adds nothing; an unusual one is said last", () => {
  for (const ending of ["child_ended", "parent_ended", null, undefined, "something_new"]) {
    assert.equal(line({ ending }).what, "Aule eligió el tema", String(ending));
  }
  assert.equal(line({ ending: "budget_reached" }).what, "Aule eligió el tema · usó todo el tiempo");
  assert.equal(line({ ending: "idle", breaks: 1 }).what, "Aule eligió el tema · 1 pausa · se cerró porque no hubo respuesta");
  assert.equal(line({ ending: "not_working" }).what, "Aule eligió el tema · Aule la cerró antes de tiempo");
  assert.equal(line({ ending: "device_offline" }).what, "Aule eligió el tema · se cortó la conexión");
  for (const ending of ["provider_error", "error"]) {
    assert.equal(line({ ending }).what, "Aule eligió el tema · se cortó por un problema de Aule", ending);
    assert.equal(line({ ending }, "en").what, "Aule chose the topic · stopped by a problem on Aule's side", ending);
  }
});

test("nothing but the named facts reaches the line: no topic, no review, no words said", () => {
  const MARK = "⟨written by the child⟩";
  const shown = sessionLine(
    {
      ...SESSION,
      topic: MARK,
      objective: { kind: "homework", subject: "matematica", topic: MARK },
      summary: MARK,
      guardian_summary: MARK,
      transcript: [MARK],
      content: MARK,
      kind: "homework",
      subject: "matematica",
    },
    { now: NOW },
  );
  assert.ok(!JSON.stringify(shown).includes(MARK));
  assert.deepEqual(Object.keys(shown), ["when", "what"]);
  // Counts that are not counts are none.
  assert.equal(line({ tried: -2, breaks: -1 }).what, "Aule eligió el tema");
  assert.equal(line({ tried: 51 }).what, "Aule eligió el tema");
  assert.equal(line({ tried: "4", breaks: 1.5 }).what, "Aule eligió el tema");
  // A skill that is not text is not shown.
  assert.equal(line({ skills: [{ name: MARK }, 7, ""] }).what, "Aule eligió el tema");
  // Nothing at all still gives a line.
  assert.deepEqual(sessionLine(null, { now: NOW }), { when: "", what: "Aule eligió el tema" });
});

test("a language the home has no words in gives Spanish", () => {
  for (const language of ["qu", "EN", "__proto__", "", null, undefined]) {
    assert.deepEqual(line({ tried: 1 }, language), line({ tried: 1 }, "es"), String(language));
  }
});
