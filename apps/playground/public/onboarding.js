// Adding a child, as the Figma «Login-Aule» v8 draws it, made shorter (D34):
// the guardian's authorisation (P04), then the name the tutor will use and,
// if the family wants, the grade, on one screen that also starts the first
// session (P12 folded in). The answers are held in this page's memory only,
// never in the browser's storage, and reach the server in one request when
// the name is saved: the server creates the child and then records the
// consents, in that order.
//
// The interview (P05 to P07) is offered on the home after the first session,
// for a child the family already has, and saved to their profile.

import { $, GRADES, call, gradeName, say, sessionClosed } from "./students.js";
import { LIKES, interestsFrom, planLine } from "./steps.js";
import { getAccount, go, landing, need, onAccount, onShow, setAccount } from "./screens.js";
import { handOff } from "./home.js";
import { language, onLanguage, t } from "./i18n.js";

// What the guardian chose on P04; null until P04 is accepted.
let held = null;
// The interview of a child the family has: { id, name, note, grade, picked, typed }; null otherwise.
let interviewing = null;
// Whether the plan has a session for the child just named, as p10-name last read it.
let planOpen = true;

need("consent", () => held !== null);
need("interview", () => interviewing !== null);

// What is kept about the child is the parent's to choose: «Qué guardamos» shows
// both choices before «Autorizo», and both start off (D5). Remembering between
// sessions is recorded only when the parent ticks it: under Peru's data
// protection rules (Ley 29733, DS 016-2024-JUS) consent is an affirmative act,
// and a box ticked for them is not one.
const DEFAULTS = { remembers: false, keepsTranscripts: false };

/** Forgets every answer and empties the fields, as on signing out or going back to the family's students. */
function drop() {
  held = null;
  interviewing = null;
  $("consent").checked = false;
  $("consent-ok").disabled = true;
  $("keep-memory").checked = DEFAULTS.remembers;
  $("keep-transcripts").checked = DEFAULTS.keepsTranscripts;
  $("keep-panel").hidden = false;
  $("keep-toggle").setAttribute("aria-expanded", "true");
  $("expect").value = "";
  $("likes-more").value = "";
  for (const input of document.querySelectorAll('#likes input[type="checkbox"]')) input.checked = false;
  $("child-name").value = "";
  // No grade is chosen for the next child.
  $("child-grade").selectedIndex = 0;
}

onAccount((account) => {
  if (account.signed_in !== true) drop();
});
// Back at the family's students, adding a child or an interview is over: the
// next one starts from empty fields, not from the last one's answers.
onShow("home", drop);

// --- P04 Tu autorización (and P04 · Marcada 160:1994) ------------------------------

onShow("p04", () => {
  // The box is never checked by default; coming back to it, it shows what was said.
  $("consent").checked = held !== null;
  $("consent-ok").disabled = held === null;
  $("keep-memory").checked = held?.remembers ?? DEFAULTS.remembers;
  $("keep-transcripts").checked = held?.keepsTranscripts ?? DEFAULTS.keepsTranscripts;
});

$("consent").addEventListener("change", () => {
  $("consent-ok").disabled = !$("consent").checked;
  if (!$("consent").checked) held = null;
});

$("keep-toggle").addEventListener("click", () => {
  const open = $("keep-panel").hidden;
  $("keep-panel").hidden = !open;
  $("keep-toggle").setAttribute("aria-expanded", String(open));
});

// «Autorizo» and Enter work only with the box checked (Nota · P04); the name comes next.
$("consent-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!$("consent").checked) return;
  held = { remembers: $("keep-memory").checked, keepsTranscripts: $("keep-transcripts").checked };
  go("p10-name");
});

// The choices in «Qué guardamos» are part of the answer even after it was given.
for (const id of ["keep-memory", "keep-transcripts"]) {
  $(id).addEventListener("change", () => {
    if (!held) return;
    held.remembers = $("keep-memory").checked;
    held.keepsTranscripts = $("keep-transcripts").checked;
  });
}

// --- In the place of P10 and P12 (web-only): the name, the grade, and the first session --

// The interview's grades, then «Prefiero decirlo después», after the first option, which only asks
// (the markup's own). Drawn again in a language just picked, with none chosen: the fields are empty
// whenever a language can be picked (drop).
function drawGrades() {
  $("child-grade").replaceChildren(
    $("child-grade").options[0],
    ...GRADES.map((grade) => new Option(gradeName(grade), grade)),
    new Option(t("child.grade_later"), "later"),
  );
  $("child-grade").selectedIndex = 0;
}
drawGrades();
onLanguage(drawGrades);

// With a session left in the plan, «Empezar su primera sesión» and «Empezar más
// tarde»; with none, «Guardar» alone and the plan's line, as P12 said it (D9).
onShow("p10-name", () => {
  const plan = planLine(getAccount().plan, language());
  planOpen = plan.open;
  for (const id of ["child-start", "child-later"]) $(id).disabled = false;
  $("child-start").textContent = t(planOpen ? "child.start" : "common.save");
  $("child-later").hidden = !planOpen;
  $("child-plan").textContent = planOpen ? "" : plan.text;
  $("child-plan").hidden = planOpen;
});

function nameError(on) {
  $("child-name").setAttribute("aria-invalid", String(on));
  $("child-name-error").hidden = !on;
  if (on) $("child-name").focus();
}

$("child-name").addEventListener("input", () => {
  if ($("child-name").getAttribute("aria-invalid") === "true") nameError(false);
});

// Enter in the name does what the primary button does: «Empezar más tarde»
// comes first in the form, and the browser would send the form as it.
$("child-name").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing) return;
  event.preventDefault();
  if (!$("child-start").disabled) $("child-name-form").requestSubmit($("child-start"));
});

$("child-name-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!held) return;
  const starting = event.submitter?.id === "child-start";
  const name = $("child-name").value.trim();
  if (!name) return nameError(true);
  nameError(false);
  say("");
  // One press, one child: the buttons wait until the screen shows again, or the press fails.
  for (const id of ["child-start", "child-later"]) $(id).disabled = true;
  const grade = $("child-grade").value;
  let made;
  try {
    made = await call("api/student", {
      consent: true,
      name,
      // The grade as the interview saves it; «Prefiero decirlo después», or none chosen, is none.
      grade: GRADES.includes(grade) ? grade : null,
      language: "es",
      interests: [],
      tone: "calido",
      note: "",
      remembers: held.remembers,
      keeps_transcripts: held.keepsTranscripts,
    });
  } catch (error) {
    for (const id of ["child-start", "child-later"]) $(id).disabled = false;
    if (error.message === "not_signed_in") {
      const account = await call("api/account").catch(() => ({ signed_in: false }));
      setAccount(account);
      return go(landing(), { replace: true, fresh: true, flow: "back", message: sessionClosed() });
    }
    return say(t("common.save_failed"));
  }
  held = null;
  // The family's students as the server has them now, for the home and the session.
  const account = await call("api/account").catch(() => null);
  if (account?.signed_in) setAccount(account);
  // The steps that made the child are over: Back does not make it again. With a
  // session left, «Empezar su primera sesión» hands the browser to the child.
  if (starting && planOpen && handOff(made.id)) return;
  go("home", { replace: true, fresh: true, message: t("child.done", { name: made.name }), tone: "info" });
});

// --- The interview, from the home: P05, the grade, P06 and P07 (D34) ---------------------

/** What the interview starts from: the student as the account has them, their likes split into P07's options and the rest. */
function interviewOf(student) {
  const interests = student.interests ?? [];
  const picked = LIKES.filter((like) => interests.includes(like.toLowerCase()));
  const typed = interests.filter((interest) => !picked.some((like) => like.toLowerCase() === interest)).join(", ");
  return { id: student.id, name: student.name, note: student.note ?? "", grade: student.grade ?? null, picked, typed };
}

// «Cuéntale a Aule sobre {nombre}», on the home (home.js row).
document.addEventListener("click", (event) => {
  const link = event.target.closest?.("[data-interview]");
  if (!link) return;
  const student = (getAccount().students ?? []).find((one) => one.id === link.dataset.interview);
  if (!student) return;
  interviewing = interviewOf(student);
  go("p05");
});

$("interview-start").addEventListener("click", () => go("p06-grade"));
$("interview-later").addEventListener("click", () => go("home"));

// --- 1 de 3 (web-only): the grade, one tap; the one answer the next session uses ---------

$("grade-options").replaceChildren(
  ...GRADES.map((grade) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "option";
    button.dataset.grade = grade;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      interviewing.grade = grade;
      go("p06");
    });
    return button;
  }),
);

// The grade the family chose on the name screen shows chosen; each is named in the page's language.
onShow("p06-grade", () => {
  for (const button of $("grade-options").children) {
    button.textContent = gradeName(button.dataset.grade);
    button.setAttribute("aria-pressed", String(button.dataset.grade === interviewing?.grade));
  }
});

// Skipping leaves the grade as it was.
$("grade-skip").addEventListener("click", () => go("p06"));

// --- P06 · expectativas (2 de 3): the note the tutor reads ----------------------------

onShow("p06", () => {
  $("expect").value = interviewing?.note ?? "";
});

$("expect-form").addEventListener("submit", (event) => {
  event.preventDefault();
  interviewing.note = $("expect").value.trim().slice(0, 200);
  go("p07");
});

// Skipping leaves the note as it was.
$("expect-skip").addEventListener("click", () => go("p07"));

// --- P07 · gustos (3 de 3): what the tutor builds its examples from ----------------------

$("likes").append(
  ...LIKES.map((like) => {
    const label = document.createElement("label");
    label.className = "pick";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "likes";
    input.value = like;
    const face = document.createElement("span");
    face.className = "option";
    label.append(input, face);
    return label;
  }),
);

// Each option is named in the page's language; what is saved for it is the same in all (words/es.js `like`).
onShow("p07", () => {
  for (const input of document.querySelectorAll('#likes input[type="checkbox"]')) {
    input.nextElementSibling.textContent = t(`like.${input.value.toLowerCase()}`);
    input.checked = interviewing?.picked.includes(input.value) ?? false;
  }
  $("likes-more").value = interviewing?.typed ?? "";
});

$("likes-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const picked = [...document.querySelectorAll('#likes input[type="checkbox"]:checked')].map((input) => input.value);
  const typed = $("likes-more").value;
  const liked = interestsFrom(picked, typed);
  if (liked.error === "too_many") return say(t("common.too_many_likes"));
  if (liked.error === "too_long") return say(t("interview.like_too_long"));
  Object.assign(interviewing, { picked, typed });
  await saveInterview(liked.interests);
});

/**
 * Saves the interview to the student's profile: their note, grade and likes.
 * Everything else is sent as the platform has it now, read first, the
 * consents above all: a flag left out would be read as a «no» (src/students.ts
 * profileFrom).
 */
async function saveInterview(interests) {
  const { id, name, note, grade } = interviewing;
  say("");
  try {
    const student = await call("api/student/read", { student_id: id });
    await call("api/student/save", {
      student_id: id,
      name: student.name,
      grade,
      language: student.language,
      interests,
      tone: student.tone,
      note,
      ...(student.subjects ? { subjects: student.subjects } : {}),
      remembers: student.remembers,
      keeps_transcripts: student.keepsTranscripts,
      relationship: student.relationship,
    });
  } catch {
    return say(t("common.save_failed"));
  }
  // The home reads the account again as it shows; this only spares it a stale moment.
  const account = await call("api/account").catch(() => null);
  if (account?.signed_in) setAccount(account);
  go("home", { message: t("interview.thanks", { name }), tone: "info" });
}
