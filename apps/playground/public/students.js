// A family's students: the words for what can be chosen, and the editor where
// a guardian says who a student is for Aule and what is kept about them.
// Nothing is saved until the guardian presses the button. A new student is
// made by the onboarding (onboarding.js), never here: the editor is for the
// students a family already has.

import { count, locale, t } from "./i18n.js";

export const $ = (id) => document.getElementById(id);

// What can be chosen, by the platform's codes. Their names are the page's
// words, in its language (words/es.js `grade`, `subject`, `relationship`, `tone`).
export const GRADES = ["P1", "P2", "P3", "P4", "P5", "P6", "S1", "S2", "S3", "S4", "S5"];
export const SUBJECTS = ["matematica", "comunicacion", "ciencia", "personal_social", "ingles"];
// What the guardian is to the student.
const RELATIONSHIPS = ["MTH", "FTH", "STPMTH", "STPFTH", "GRMTH", "GRFTH", "AUNT", "UNCLE", "SIB", "GUARD", "FAMMEMB"];
const TONES = ["calido", "jugueton", "aventurero", "tranquilo"];

/** A grade's name in the page's language. */
export const gradeName = (grade) => t(`grade.${grade}`);

// Things many students like, to pick from; a family can add its own. These are
// what is saved for each, the same in every language: the tutor reads them, and
// a family that changes the page's language keeps what it chose.
const INTERESTS = [
  "fútbol",
  "vóley",
  "baile",
  "música",
  "dibujo",
  "videojuegos",
  "animales",
  "dinosaurios",
  "el espacio",
  "cocina",
  "cuentos",
  "inventos",
];
const MAX_INTERESTS = 10;

/** An interest as the page shows it: one it offers, in the page's language; a family's own, as they wrote it. */
const interestName = (interest) => t(`interest.${interest}`) || interest;

export async function call(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(answer.error ?? "failed");
  return answer;
}

/** What the entry says to a family whose session ended while a screen of theirs was open, in the page's language. */
export function sessionClosed() {
  return t("common.session_closed");
}

/** Writes the message line: an error unless `tone` is "info"; nothing hides it. */
export function say(text, tone = "error") {
  const message = $("message");
  message.textContent = text;
  message.hidden = !text;
  message.dataset.tone = tone;
}

/** A choice drawn as a chip: a checkbox or a radio the person presses by its label. */
export function chip(type, name, value, text, checked) {
  const label = document.createElement("label");
  label.className = "chip";
  const input = document.createElement("input");
  input.type = type;
  input.name = name;
  input.value = value;
  input.checked = checked;
  const face = document.createElement("span");
  face.textContent = text;
  label.append(input, face);
  return label;
}

const checked = (name) =>
  [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value);

/** One line about a student for their row: what the family told Aule. */
export function describe(student) {
  const parts = [];
  if (student.grade) parts.push(gradeName(student.grade));
  if (student.tone && student.tone !== "calido") parts.push(t("home.tone", { tone: t(`tone.${student.tone}`).toLocaleLowerCase(locale()) }));
  if (student.interests?.length) parts.push(student.interests.slice(0, 3).map(interestName).join(", "));
  return parts.join(" · ");
}

let editing = null;
let done = () => {};

/** The student the editor is open for, or null. */
export function editingStudent() {
  return editing;
}

// What is kept about a student, to inspect or forget in their settings.
async function showKnown(student) {
  const section = $("known");
  section.hidden = true;
  $("memories").replaceChildren();
  let known;
  try {
    known = await call("api/student/known", { student_id: student.id });
  } catch {
    return;
  }
  // The editor may have moved on to another student while this was on its way.
  if (editing?.id !== student.id) return;
  $("known-title").textContent = t("editor.known_title", { name: student.name });
  const worked = known.mastered + known.practising;
  let progress = worked ? count("editor.mastered", known.mastered, { practising: known.practising }) : t("editor.no_exercises");
  if (known.next.length) progress += ` ${t("editor.coming", { skills: known.next.join(", ") })}`;
  $("progress-known").textContent = progress;
  for (const memory of known.memories) {
    const item = document.createElement("li");
    const forget = document.createElement("button");
    forget.type = "button";
    forget.className = "small";
    forget.textContent = t("editor.forget");
    forget.addEventListener("click", async () => {
      forget.disabled = true;
      try {
        await call("api/student/forget", { student_id: student.id, memory_id: memory.id });
        item.remove();
      } catch {
        forget.disabled = false;
        say(t("editor.forget_failed"));
      }
    });
    const text = document.createElement("span");
    text.textContent = memory.text;
    item.append(text, forget);
    $("memories").append(item);
  }
  if (!known.memories.length) {
    const none = document.createElement("li");
    none.className = "none";
    none.textContent = t("editor.no_memories", { name: student.name });
    $("memories").append(none);
  }
  section.hidden = false;
}

function fill(student, subjects) {
  $("editor-title").textContent = t("editor.title", { name: student.name });
  $("student-name").value = student.name ?? "";
  $("student-grade").replaceChildren(
    new Option(t("editor.prefer_not"), ""),
    ...GRADES.map((grade) => new Option(gradeName(grade), grade)),
  );
  $("student-grade").value = student.grade ?? "";
  $("relationship-label").textContent = t("editor.relationship", { name: student.name });
  $("student-relationship").replaceChildren(
    new Option(t("editor.prefer_not"), ""),
    ...RELATIONSHIPS.map((relationship) => new Option(t(`relationship.${relationship}`), relationship)),
  );
  $("student-relationship").value = student.relationship ?? "";
  $("subjects-field").hidden = !subjects;
  $("student-subjects").replaceChildren(
    ...(subjects ?? []).map((value) =>
      chip("checkbox", "subjects", value, t(`subject.${value}`), student.subjects?.includes(value) ?? false),
    ),
  );
  // The student's own come first and keep their order: the first ones are
  // what the tutor reaches for.
  const liked = student.interests ?? [];
  $("student-interests").replaceChildren(
    ...[...new Set([...liked, ...INTERESTS])].map((interest) =>
      chip("checkbox", "interests", interest, interestName(interest), liked.includes(interest)),
    ),
  );
  $("interest-new").value = "";
  $("student-tone").replaceChildren(
    ...TONES.map((value) => {
      const label = chip("radio", "tone", value, "", (student.tone ?? "calido") === value);
      label.className = "tone";
      const strong = document.createElement("b");
      strong.textContent = t(`tone.${value}`);
      label.lastChild.append(strong, ` ${t(`tone.${value}_about`)}`);
      return label;
    }),
  );
  $("student-note").value = student.note ?? "";
  $("student-language").value = student.language ?? "es";
  // Ticked only where the family said yes: a choice never made is shown as not made.
  $("student-remembers").checked = student.remembers === true;
  $("student-transcripts").checked = student.keepsTranscripts === true;
  $("known").hidden = true;
}

/**
 * Fills the editor for one of the family's students. `subjects` are the ones
 * that can be kept for a student, null when none can. `finished` is told the
 * id of the student that was saved, or null when the student was removed;
 * going back (the screen's «← Atrás») changes nothing and tells nobody.
 */
export function openEditor(student, subjects, finished) {
  editing = student;
  done = finished;
  fill(student, subjects);
  showKnown(student);
}

/** Forgets the student being edited and empties the editor, as on signing out. */
export function clearEditor() {
  editing = null;
  done = () => {};
  $("editor-title").textContent = "";
  // The question names the student («¿Qué eres de …?»), and the two lists hold
  // the student's grade and what the guardian is to them.
  $("relationship-label").textContent = "";
  for (const id of ["student-name", "student-note", "interest-new"]) $(id).value = "";
  for (const id of ["student-grade", "student-relationship", "student-subjects", "student-interests", "student-tone", "memories"]) {
    $(id).replaceChildren();
  }
  $("student-language").value = "es";
  $("student-remembers").checked = false;
  $("student-transcripts").checked = false;
  $("known-title").textContent = "";
  $("progress-known").textContent = "";
  $("known").hidden = true;
}

function close(result) {
  const finished = done;
  editing = null;
  done = () => {};
  finished(result);
}

$("interest-add").addEventListener("click", () => {
  const interest = $("interest-new").value.trim().toLowerCase();
  if (!interest) return;
  // One the page already offers, by what is saved for it or by the name it shows in the page's language.
  const there = [...document.querySelectorAll('input[name="interests"]')].find(
    (input) => input.value.toLowerCase() === interest || interestName(input.value).toLowerCase() === interest,
  );
  if (there) there.checked = true;
  else $("student-interests").append(chip("checkbox", "interests", interest, interest, true));
  $("interest-new").value = "";
});

// Enter in the box adds the interest; it does not save the whole form.
$("interest-new").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  $("interest-add").click();
});

$("student-editor").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!editing) return;
  say("");
  const interests = checked("interests");
  if (interests.length > MAX_INTERESTS) return say(t("common.too_many_likes"));
  const profile = {
    name: $("student-name").value.trim(),
    grade: $("student-grade").value || null,
    language: $("student-language").value,
    interests,
    tone: checked("tone")[0] ?? "calido",
    note: $("student-note").value.trim(),
    ...($("subjects-field").hidden ? {} : { subjects: checked("subjects") }),
    remembers: $("student-remembers").checked,
    keeps_transcripts: $("student-transcripts").checked,
    relationship: $("student-relationship").value || null,
  };
  if (!profile.name) return say(t("editor.name_needed"));
  $("save-student").disabled = true;
  try {
    const saved = await call("api/student/save", { student_id: editing.id, ...profile });
    close(saved.id);
  } catch {
    say(t("common.save_failed"));
  } finally {
    $("save-student").disabled = false;
  }
});

$("remove-student").addEventListener("click", async () => {
  const student = editing;
  if (!student) return;
  const sure = window.confirm(t("editor.remove_confirm", { name: student.name }));
  if (!sure) return;
  try {
    await call("api/student/remove", { student_id: student.id });
    close(null);
  } catch {
    say(t("editor.remove_failed"));
  }
});
