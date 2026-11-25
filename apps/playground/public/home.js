// A signed-in family: its students (the home, built from v8's Fila/Alumno
// 161:2110 and Acción/Pequeña 161:2104), a student's settings, the hand-off
// to a child just made (a02, from A02 ¿Eres tú? 410:629), and what a session
// is for, asked the way the device asks it (A04 ¿Qué hacemos hoy? · Aparato
// 190:891). The session itself is app.js's; this builds the request it is
// asked with, and says whether it is the student's first run.

import { $, SUBJECTS, call, clearEditor, describe, editingStudent, openEditor } from "./students.js";
import { DATED, KINDS, OWN_SUBJECT, REVIEW, defaultSubject, kindLabel, objectiveFor, planLine } from "./steps.js";
import { back, current, getAccount, go, landing, need, onAccount, onShow, setAccount } from "./screens.js";
import { languageOf, words } from "./first-steps.js";

// The student a session is for, and what for: undefined until a tile is
// chosen, "" when it is left to Aule, else the kind.
let chosen = null;
let kind;
// What the next session is asked with; null until it is known.
let request = null;
// Whose details the details screen holds, so coming back to it keeps them.
let detailsOf = "";
// The student whose session a reload left open, or null. Choosing them goes
// straight to A05, which offers to carry on with it (app.js), instead of
// asking again what a session that already has its purpose is for. Starting
// another from there has no purpose yet, so A04 asks it then (purposeAsked).
let resumable = null;
// The student P12 hands the browser over to (a02), by id; null otherwise.
let handoff = null;
// Whether a child said «Sí, soy yo» on a02 in this visit. Page memory only.
let confirmed = false;

need("student", () => chosen !== null);
need("objective", () => chosen !== null && Boolean(kind));
need("editing", () => editingStudent() !== null);
need("handoff", () => handoffStudent() !== undefined);

/** The student being handed over to, as the account has them now. */
function handoffStudent() {
  return handoff === null ? undefined : (getAccount().students ?? []).find((one) => one.id === handoff);
}

/** The body of the request for a session: the chosen student's, and what for. */
export function sessionRequest() {
  return request;
}

/** The subjects the platform keeps for a student; null when it keeps none, and then a session is not asked what for. */
function subjectsKept() {
  const kept = getAccount().subjects;
  return Array.isArray(kept) ? kept.filter((subject) => subject in SUBJECTS) : null;
}

/**
 * Whether the next session has been asked what it is for: a tile chosen on
 * A04 («No lo sé» too), or nothing to ask when the platform keeps no subjects.
 * Not yet on an A05 reached past A04 (a session a reload left open): carrying
 * that one on keeps its purpose, but starting another asks A04 first (app.js).
 */
export function purposeAsked() {
  return kind !== undefined || subjectsKept() === null;
}

/**
 * Whether the session about to start is a first run, when A16's words and the
 * coach of the talk button show: the child said «Sí, soy yo» on a02 in this
 * visit, or the family's trial has not started (no session has counted yet).
 * Held in this page's memory only; the home and signing out forget it.
 */
export function firstRun() {
  const plan = getAccount().plan;
  return confirmed || (plan?.plan === "trial" && !plan.ends_at);
}

const asked = (objective) => ({
  student_id: chosen.id,
  language: chosen.language ?? "es",
  ...(objective ? { objective } : {}),
});

// --- The home: who studies today --------------------------------------------------------

function row(student, open) {
  const item = document.createElement("li");
  item.className = "student-row";
  const start = document.createElement("button");
  start.type = "button";
  start.className = "student-go";
  const name = document.createElement("b");
  name.textContent = student.name;
  const about = document.createElement("small");
  about.textContent = describe(student) || "Sin configurar todavía";
  start.append(name, about);
  start.setAttribute("aria-label", `${student.name}: empezar una sesión`);
  // With no session left, the plan line says why; the settings still open.
  if (!open) start.setAttribute("aria-disabled", "true");
  start.addEventListener("click", () => {
    if (open) study(student.id);
  });
  const configure = document.createElement("button");
  configure.type = "button";
  configure.className = "small";
  configure.textContent = "Configurar";
  configure.setAttribute("aria-label", `Configurar a ${student.name}`);
  configure.addEventListener("click", () => edit(student));
  item.append(start, configure);
  return item;
}

function drawHome() {
  const account = getAccount();
  if (account.signed_in !== true) return;
  // A name that already ends in a full stop ("Gonzalo G.") keeps just the one.
  const name = (account.name ?? "").trim().replace(/\.+$/, "");
  $("hello").textContent = name ? `Hola, ${name}.` : "Hola.";
  const plan = planLine(account.plan, document.documentElement.lang);
  $("plan-line").textContent = plan.text;
  $("plan-line").hidden = !plan.text;
  $("team-panel").hidden = account.team !== true;
  const students = account.students ?? [];
  $("student-list").replaceChildren(...students.map((student) => row(student, plan.open)));
  $("student-list").hidden = students.length === 0;
  $("no-students").hidden = students.length > 0;
  $("add-student").hidden = students.length === 0;
  $("add-first").hidden = students.length > 0;
}

onShow("home", () => {
  chosen = null;
  kind = undefined;
  request = null;
  handoff = null;
  confirmed = false;
  drawHome();
  findResumable();
  readAgain();
});

/**
 * Reads the family's account again each time the home shows: a session that
 * just ended may have used the day or started the trial. It is drawn while
 * the page still shows the home, signed in; a sign-in that expired meanwhile
 * goes back to signing in. A failed read keeps what is drawn.
 */
async function readAgain() {
  let latest;
  try {
    latest = await call("api/account");
  } catch {
    return;
  }
  if (current() !== "home" || getAccount().signed_in !== true) return;
  if (latest.signed_in !== true) {
    // Each module forgets what it drew about the family before signing in shows.
    setAccount(latest);
    const land = landing();
    return go(land === "c01" ? "p13" : land, { replace: true, fresh: true, flow: "back", message: "Tu sesión se cerró. Vuelve a entrar." });
  }
  const drawn = (account) => JSON.stringify([account.name, account.team, account.plan, account.students]);
  const changed = drawn(latest) !== drawn(getAccount());
  setAccount(latest);
  // Unchanged, the rows stay as they are, and so does the focus in them.
  if (changed) drawHome();
}

async function findResumable() {
  resumable = null;
  try {
    const answer = await call("api/session/recovery");
    if (answer.available) resumable = answer.student_id;
  } catch {
    // A05 asks again when it shows.
  }
}

for (const id of ["add-student", "add-first"]) $(id).addEventListener("click", () => go("p04"));

/**
 * A session for one of the family's students: what for first, unless the
 * platform keeps no subjects or the student's last session is still open
 * (then A05 offers to carry it on, and asks A04 only to start another).
 */
function study(id) {
  const student = (getAccount().students ?? []).find((one) => one.id === id);
  if (!student) return;
  chosen = student;
  kind = undefined;
  request = asked(null);
  go(subjectsKept() && id !== resumable ? "a04" : "a05");
}

// --- a02 ¿Eres tú? (A02 410:629, adapted): the hand-off --------------------------------
//
// P12's «Empezar su primera sesión» hands the parent's browser over to the
// child just made. On the device the child confirms the profile on A02 while
// the parent's P11 waits; on the web both are here, so one screen does it.

$("done-start").addEventListener("click", () => {
  handoff = $("done-start").dataset.student ?? null;
  if (handoffStudent()) go("a02");
});

/** first-steps.js's words for a student, marked with the language they are in (WCAG 3.1.2). */
function writeWords(element, key, language, values) {
  element.textContent = words(key, language, values);
  element.lang = language;
}

onShow("a02", () => {
  const student = handoffStudent();
  if (!student) return;
  const language = languageOf(student.language);
  writeWords($("a02-lead"), "handoff_lead", language, { name: student.name });
  writeWords($("a02-title"), "handoff_title", language);
  // The name as the parent wrote it, after Configurar too.
  $("a02-name").textContent = student.name;
  writeWords($("a02-yes"), "handoff_yes", language);
  writeWords($("a02-no"), "handoff_no", language);
  writeWords($("a02-back"), "back", language);
});

// «Sí, soy yo»: a first run, on as a row of the home goes.
$("a02-yes").addEventListener("click", () => {
  const student = handoffStudent();
  if (!student) return;
  confirmed = true;
  study(student.id);
});

// «No soy yo»: in the place of A03 «Avísale a tu papá o mamá», since the parent
// is right there. Configurar opens for the name; saving comes back here.
$("a02-no").addEventListener("click", () => {
  const student = handoffStudent();
  if (student) edit(student, true);
});

// --- A student's settings ---------------------------------------------------------------

/** Opens Configurar for a student; from a02 (`handingOver`), saving goes back to it. */
function edit(student, handingOver = false) {
  openEditor(student, subjectsKept(), async (saved) => {
    // Saved or removed: the family's students are read again, then the screen before.
    try {
      setAccount(await call("api/account"));
    } catch {
      return go("home", { message: "No se pudo leer tu cuenta. Carga la página otra vez." });
    }
    // Removed from the hand-off: there is nobody to hand over to.
    if (handingOver && saved === null) {
      handoff = null;
      return go("home", { replace: true, fresh: true });
    }
    back();
  });
  go("editor");
}

// --- A04 ¿Qué hacemos hoy? ----------------------------------------------------------------

$("kinds").replaceChildren(
  ...KINDS.map((tile) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "choice";
    button.dataset.kind = tile.kind;
    button.setAttribute("aria-pressed", "false");
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.dataset.icon = tile.icon;
    icon.setAttribute("aria-hidden", "true");
    const words = document.createElement("span");
    words.textContent = tile.label;
    button.append(icon, words);
    button.addEventListener("click", () => choose(tile.kind));
    return button;
  }),
);

function choose(next) {
  kind = next;
  for (const button of $("kinds").children) button.setAttribute("aria-pressed", String(button.dataset.kind === next));
  // «No lo sé»: Aule decides, and the session carries no objective.
  if (!next) {
    request = asked(null);
    return go("a05");
  }
  go("a04-details");
}

$("kind-review").addEventListener("click", () => choose(REVIEW.kind));

onShow("a04", () => {
  $("a04-title").textContent = `Hola, ${chosen.name}. ¿Qué hacemos hoy?`;
  // Coming back from its details, the chosen tile shows Seleccionada.
  for (const button of $("kinds").children) {
    button.setAttribute("aria-pressed", String(kind !== undefined && button.dataset.kind === kind));
  }
});

// --- A04 · Detalles (web-only): subject, topic and, for homework and evaluations, the day --

function showSubjectNote() {
  $("subject-note").hidden = $("subject").value === OWN_SUBJECT;
}

onShow("a04-details", () => {
  $("a04-details-title").textContent = kindLabel(kind);
  $("due-line").hidden = !DATED.includes(kind);
  const whose = `${chosen.id}|${kind}`;
  if (whose !== detailsOf) {
    detailsOf = whose;
    const kept = subjectsKept() ?? [];
    $("subject").replaceChildren(...kept.map((subject) => new Option(SUBJECTS[subject], subject)), new Option("Otra", "other"));
    $("subject").value = defaultSubject(chosen.subjects, kept);
    $("topic").value = "";
    $("due").value = "";
  }
  showSubjectNote();
});

$("subject").addEventListener("change", showSubjectNote);

// «Seguir»: one tap is enough; everything here is optional.
$("details-form").addEventListener("submit", (event) => {
  event.preventDefault();
  request = asked(objectiveFor(kind, { subject: $("subject").value, topic: $("topic").value, due: $("due").value }));
  go("a05");
});

// --- Signing out --------------------------------------------------------------------------

// What the page drew about the family goes before anything else shows.
onAccount((account) => {
  if (account.signed_in === true) return;
  chosen = null;
  kind = undefined;
  request = null;
  resumable = null;
  handoff = null;
  confirmed = false;
  detailsOf = "";
  // a02 named the child.
  $("a02-lead").textContent = "";
  $("a02-name").textContent = "";
  $("hello").textContent = "";
  $("plan-line").textContent = "";
  $("student-list").replaceChildren();
  $("team-panel").hidden = true;
  $("a04-title").textContent = "";
  // A04 · Detalles' subject is the child's default one; it is drawn again for the next family.
  $("subject").replaceChildren();
  $("topic").value = "";
  $("due").value = "";
  clearEditor();
});
