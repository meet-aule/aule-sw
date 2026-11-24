// Adding a child, as the Figma «Login-Aule» v8 draws it (P04 to P12): the
// guardian's authorisation first, then an optional interview, the name the
// tutor will use, and done. The answers are held in this page's memory only,
// never in the browser's storage, and reach the server in one request when
// the name is saved: the server creates the child and then records the
// consents, in that order.

import { $, GRADES, call, say } from "./students.js";
import { LIKES, interestsFrom, planLine } from "./steps.js";
import { getAccount, go, landing, need, onAccount, onShow, setAccount } from "./screens.js";

// What the guardian has said so far; null until P04 is accepted.
let held = null;
// The child just made, for P12; null otherwise.
let created = null;

need("consent", () => held !== null);
need("created", () => created !== null);

// What is kept about the child is the parent's to choose: «Qué guardamos» shows
// both choices before «Autorizo», and both start off (D5). Remembering between
// sessions is recorded only when the parent ticks it: under Peru's data
// protection rules (Ley 29733, DS 016-2024-JUS) consent is an affirmative act,
// and a box ticked for them is not one.
const DEFAULTS = { remembers: false, keepsTranscripts: false };
// P12's line when the child can start a session now; the plan's own line otherwise.
const P12_HELP = $("p12-help").textContent;

/** Forgets every answer and empties the fields, as on signing out or going back to the family's students. */
function drop() {
  held = null;
  created = null;
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
  $("p12-title").textContent = "Listo.";
  $("p12-help").textContent = P12_HELP;
  delete $("done-start").dataset.student;
}

onAccount((account) => {
  if (account.signed_in !== true) drop();
});
// Back at the family's students, the onboarding is over: the next child starts
// from empty fields, not from the last one's name and answers.
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

// «Autorizo» and Enter work only with the box checked (Nota · P04).
$("consent-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!$("consent").checked) return;
  held = {
    ...(held ?? { note: "", grade: null, picked: [], typed: "", interests: [] }),
    remembers: $("keep-memory").checked,
    keepsTranscripts: $("keep-transcripts").checked,
  };
  go("p05");
});

// The choices in «Qué guardamos» are part of the answer even after it was given.
for (const id of ["keep-memory", "keep-transcripts"]) {
  $(id).addEventListener("change", () => {
    if (!held) return;
    held.remembers = $("keep-memory").checked;
    held.keepsTranscripts = $("keep-transcripts").checked;
  });
}

// --- P05 Conozcamos a tu hijo ---------------------------------------------------------

$("interview-start").addEventListener("click", () => go("p06"));
$("interview-later").addEventListener("click", () => go("p10-name"));

// --- P06 · expectativas (1 de 3): the note the tutor reads ----------------------------

onShow("p06", () => {
  $("expect").value = held?.note ?? "";
});

$("expect-form").addEventListener("submit", (event) => {
  event.preventDefault();
  held.note = $("expect").value.trim().slice(0, 200);
  go("p06-grade");
});

$("expect-skip").addEventListener("click", () => {
  held.note = "";
  $("expect").value = "";
  go("p06-grade");
});

// --- 2 de 3 (web-only): the grade, one tap ---------------------------------------------

$("grade-options").replaceChildren(
  ...Object.entries(GRADES).map(([value, text]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "option";
    button.dataset.grade = value;
    button.textContent = text;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      held.grade = value;
      go("p07");
    });
    return button;
  }),
);

onShow("p06-grade", () => {
  for (const button of $("grade-options").children) {
    button.setAttribute("aria-pressed", String(button.dataset.grade === held?.grade));
  }
});

$("grade-skip").addEventListener("click", () => {
  held.grade = null;
  go("p07");
});

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
    face.textContent = like;
    label.append(input, face);
    return label;
  }),
);

onShow("p07", () => {
  for (const input of document.querySelectorAll('#likes input[type="checkbox"]')) {
    input.checked = held?.picked.includes(input.value) ?? false;
  }
  $("likes-more").value = held?.typed ?? "";
});

$("likes-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const picked = [...document.querySelectorAll('#likes input[type="checkbox"]:checked')].map((input) => input.value);
  const typed = $("likes-more").value;
  const liked = interestsFrom(picked, typed);
  if (liked.error === "too_many") return say("Elige hasta diez cosas que le gusten.");
  if (liked.error === "too_long") return say("Cada gusto puede tener hasta 40 letras.");
  Object.assign(held, { picked, typed, interests: liked.interests });
  go("p10-name");
});

// --- In the place of P10 (web-only): the name the tutor uses; the child is made here ------

function nameError(on) {
  $("child-name").setAttribute("aria-invalid", String(on));
  $("child-name-error").hidden = !on;
  if (on) $("child-name").focus();
}

$("child-name").addEventListener("input", () => {
  if ($("child-name").getAttribute("aria-invalid") === "true") nameError(false);
});

$("child-name-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("child-name").value.trim();
  if (!name) return nameError(true);
  nameError(false);
  say("");
  // One press, one child.
  $("child-save").disabled = true;
  let made;
  try {
    made = await call("api/student", {
      consent: true,
      name,
      grade: held.grade,
      language: "es",
      interests: held.interests,
      tone: "calido",
      note: held.note,
      remembers: held.remembers,
      keeps_transcripts: held.keepsTranscripts,
    });
  } catch (error) {
    $("child-save").disabled = false;
    if (error.message === "not_signed_in") {
      const account = await call("api/account").catch(() => ({ signed_in: false }));
      setAccount(account);
      return go(landing() === "c00" ? "p13" : landing(), { replace: true, fresh: true, flow: "back", message: "Tu sesión se cerró. Vuelve a entrar." });
    }
    return say("No se pudo guardar. Inténtalo otra vez.");
  }
  $("child-save").disabled = false;
  held = null;
  created = { id: made.id, name: made.name };
  // The family's students as the server has them now, for the home and the session.
  const account = await call("api/account").catch(() => null);
  if (account?.signed_in) setAccount(account);
  // The steps that made the child are over: Back does not make it again.
  go("p12", { replace: true, fresh: true });
});

// --- P12 Listo -------------------------------------------------------------------------

onShow("p12", () => {
  if (!created) return;
  $("p12-title").textContent = `Listo. Aule ya conoce a ${created.name}`;
  // home.js starts the session for this child.
  $("done-start").dataset.student = created.id;
  // With no session left in the plan, finishing is the one thing to do, and
  // the line under the title says why, as the home does.
  const plan = planLine(getAccount().plan, document.documentElement.lang);
  $("done-start").hidden = !plan.open;
  $("done-finish").className = plan.open ? "link" : "primary";
  $("p12-help").textContent = plan.open ? P12_HELP : plan.text;
});

$("done-finish").addEventListener("click", () => go("home"));
