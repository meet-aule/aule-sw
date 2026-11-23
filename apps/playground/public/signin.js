// Signing in with Google, GitHub, Facebook or Apple, choosing the student a
// session is for and saying
// what the session is for. The page never holds the session itself: the server
// keeps it in a cookie it alone reads.

import { $, SUBJECTS, call, chip, describe, openEditor, say } from "./students.js";

const GOOGLE_SCRIPT = "https://accounts.google.com/gsi/client";
// Sign-ins that leave the page for the provider's and come back with a code.
const CODE_PROVIDERS = ["github", "meta", "apple"];

// What a family can say a session is for. The first leaves the choice to Aule.
const KINDS = {
  "": "Seguir donde quedamos",
  homework: "Hacer una tarea",
  exam_prep: "Preparar una evaluación",
  exam_review: "Revisar una evaluación",
  explore: "Aprender algo nuevo",
};
// A day matters for these: when the homework is due, when the evaluation is.
const DATED = ["homework", "exam_prep"];
// The one subject Aule has its own exercises for today.
const OWN_SUBJECT = "matematica";

// What the next session is asked with; null until a student is chosen.
let request = null;
let students = [];
// The subjects the platform keeps for a student; null when it keeps none, and
// then neither they nor what a session is for are offered.
let subjects = null;
// Signing in runs before the rest of the page has loaded: a choice made in
// that moment waits for it.
let waiting = false;
let enter = () => {
  waiting = true;
};

/** What the page does once a signed-in person has chosen a student. */
export function onEnter(callback) {
  enter = callback;
  if (waiting) callback();
}

/** The body of the request for a session: the chosen student's. */
export function sessionRequest() {
  return request;
}

const chosen = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value ?? "";

/** What the family said the session is for, or null when they left it to Aule. */
function objective() {
  const kind = chosen("kind");
  if ($("today").hidden || !kind) return null;
  return {
    kind,
    subject: $("subject").value,
    topic: $("topic").value.trim(),
    due: DATED.includes(kind) && $("due").value ? $("due").value : null,
  };
}

function showToday() {
  const kind = chosen("kind");
  $("today-details").hidden = !kind;
  $("due-line").hidden = !DATED.includes(kind);
  $("subject-note").hidden = $("subject").value === OWN_SUBJECT;
}

// The subject a session starts on: one the family wants reinforced. Among
// those, the one Aule has exercises for; the platform keeps them in its own
// order, so "the first" would not be the family's first.
function showSubject() {
  const student = students.find((one) => one.id === chosen("student"));
  const wanted = (student?.subjects ?? []).filter((subject) => subjects?.includes(subject));
  const offered = wanted.length ? wanted : (subjects ?? []);
  $("subject").value = offered.includes(OWN_SUBJECT) ? OWN_SUBJECT : (offered[0] ?? "other");
  showToday();
}

function edit(student) {
  openEditor(student, subjects, async (saved) => {
    try {
      // Saved or removed: the list is read again. Going back changes nothing.
      if (saved !== undefined) return show(await call("api/account"), saved);
    } catch {
      say("No se pudo leer tu cuenta. Carga la página otra vez.");
    }
    $("who").hidden = false;
    $("account").hidden = false;
  });
}

// Each student is a row to press, with a way into their settings.
function showStudents(preferred) {
  const before = preferred ?? chosen("student");
  const list = $("student-list");
  list.replaceChildren();
  for (const student of students) {
    const row = document.createElement("div");
    row.className = "student";
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "student";
    input.value = student.id;
    input.addEventListener("change", showSubject);
    const face = document.createElement("span");
    const name = document.createElement("b");
    name.textContent = student.name;
    const about = document.createElement("small");
    about.textContent = describe(student) || "Sin configurar todavía";
    face.append(name, about);
    label.append(input, face);
    const configure = document.createElement("button");
    configure.type = "button";
    configure.className = "quiet";
    configure.textContent = "Configurar";
    configure.setAttribute("aria-label", `Configurar a ${student.name}`);
    configure.addEventListener("click", () => edit(student));
    row.append(label, configure);
    list.append(row);
  }
  const inputs = [...list.querySelectorAll("input")];
  const first = inputs.find((input) => input.value === before) ?? inputs[0];
  if (first) first.checked = true;
  $("no-students").hidden = students.length > 0;
  $("add-student").classList.toggle("quiet", students.length > 0);
  $("enter").hidden = students.length === 0;
  $("today").hidden = students.length === 0 || !subjects;
  showSubject();
}

const DAY_MS = 86_400_000;
const sessions = (n) => (n === 1 ? "1 sesión" : `${n} sesiones`);
const date = (iso) => new Date(iso).toLocaleDateString("es-PE", { day: "numeric", month: "long" });

/** What the family's plan allows now, in a line; and whether a session can start. */
function planLine(plan) {
  if (!plan) return { text: "", open: true };
  if (plan.plan === "team") return { text: "Equipo de Aule: sesiones sin límite.", open: true };
  if (plan.plan === "free") return {
    text: document.documentElement.lang.startsWith("en")
      ? "Free access: unlimited sessions."
      : "Acceso gratuito: sesiones sin límite.",
    open: true,
  };
  const left = plan.left ?? 0;
  if (plan.plan === "trial" && !plan.ends_at) {
    return { text: "Prueba gratis de 7 días: empieza con tu primera sesión. Una sesión al día.", open: true };
  }
  if (plan.plan === "trial") {
    const days = Math.max(1, Math.ceil((new Date(plan.ends_at) - Date.now()) / DAY_MS));
    const today = left > 0 ? "hoy tienes tu sesión" : "la sesión de hoy ya la usaste: vuelve mañana";
    return { text: `Prueba gratis: te ${days === 1 ? "queda 1 día" : `quedan ${days} días`}, y ${today}.`, open: left > 0 };
  }
  if (plan.plan === "paid" || plan.plan === "granted") {
    const kind = plan.plan === "paid" ? "Plan Aule" : "Plan Aule (regalado)";
    const week =
      left > 0
        ? `te ${left === 1 ? "queda" : "quedan"} ${sessions(left)} de ${plan.allowed} en estos 7 días`
        : `ya usaste las ${plan.allowed} sesiones de estos 7 días; cada una vuelve a los 7 días de usarla`;
    return { text: `${kind} hasta el ${date(plan.ends_at)}: ${week}.`, open: left > 0 };
  }
  const price = (plan.price?.amount_cents ?? 5900) / 100;
  return {
    text: `Tu prueba gratis terminó. El plan Aule cuesta S/${price} al mes, con 3 sesiones por semana. Muy pronto podrás suscribirte aquí; mientras tanto, escríbenos a admin@meetaule.com.`,
    open: false,
  };
}

function show(account, preferred) {
  const signedIn = account.signed_in === true;
  const providers = account.providers ?? [];
  $("signed-out").hidden = signedIn || (!account.google_client_id && providers.length === 0);
  for (const provider of CODE_PROVIDERS) $(`signin-${provider}`).hidden = !providers.includes(provider);
  $("email-way").hidden = !providers.includes("email");
  $("who").hidden = !signedIn;
  $("account").hidden = !signedIn;
  $("student-editor").hidden = true;
  if (!signedIn) return;
  students = account.students ?? [];
  subjects = Array.isArray(account.subjects)
    ? account.subjects.filter((subject) => subject in SUBJECTS)
    : null;
  // A name that already ends in a full stop ("Gonzalo G.") keeps just the one.
  const name = (account.name ?? "").trim().replace(/\.+$/, "");
  $("hello").textContent = name ? `Hola, ${name}.` : "Hola.";
  const plan = planLine(account.plan);
  $("plan-line").textContent = plan.text;
  $("plan-line").hidden = !plan.text;
  $("enter").disabled = !plan.open;
  $("team-panel").hidden = account.team !== true;
  $("subject").replaceChildren(
    ...(subjects ?? []).map((subject) => new Option(SUBJECTS[subject], subject)),
    new Option("Otra", "other"),
  );
  showStudents(typeof preferred === "string" ? preferred : undefined);
}

// Google's script is fetched while the page asks who is here; the button is
// drawn once both are in.
function loadGoogleScript() {
  return new Promise((loaded, failed) => {
    const script = document.createElement("script");
    script.src = GOOGLE_SCRIPT;
    script.async = true;
    script.addEventListener("load", loaded);
    script.addEventListener("error", failed);
    document.head.append(script);
  });
}

// Creating an account and coming back are the same steps (the first sign-in
// makes the account); the tabs only change what the page says.
const MODES = {
  new: { title: "Crea tu cuenta de familia", lead: "7 días gratis, sin tarjeta. Luego decides.", google: "signup_with" },
  back: { title: "Qué bueno verte de nuevo", lead: "Entra con la misma cuenta con la que la creaste.", google: "signin_with" },
};
let mode = "new";
let googleClient = null;

function setMode(next) {
  mode = next;
  for (const [id, value] of [["tab-new", "new"], ["tab-back", "back"]]) {
    $(id).setAttribute("aria-selected", String(value === mode));
  }
  $("signin-title").textContent = MODES[mode].title;
  $("signin-lead").textContent = MODES[mode].lead;
  for (const label of document.querySelectorAll("#signed-out [data-new]")) {
    label.textContent = label.dataset[mode];
  }
  // Coming back, the name is already known; a new address asks for it.
  $("email-name").hidden = mode === "back";
  if (googleClient && window.google?.accounts) renderGoogle();
}

$("tab-new").addEventListener("click", () => setMode("new"));
$("tab-back").addEventListener("click", () => setMode("back"));

function renderGoogle() {
  $("google").replaceChildren();
  window.google.accounts.id.renderButton($("google"), {
    theme: "outline",
    size: "large",
    text: MODES[mode].google,
    shape: "pill",
    locale: "es",
  });
}

// The emailed code: the address, then the six digits (and a name, the first time).
let emailAddress = "";

$("email-start").addEventListener("submit", async (event) => {
  event.preventDefault();
  say("");
  emailAddress = $("email-address").value.trim();
  try {
    await call("api/signin/email/start", { email: emailAddress });
  } catch {
    say("Revisa el correo: no parece una dirección válida.");
    return;
  }
  $("email-sent").textContent = `Te enviamos un código a ${emailAddress}. Si no llega en un minuto, revisa la carpeta de spam.`;
  $("email-start").hidden = true;
  $("email-verify").hidden = false;
  $("email-code").focus();
});

$("email-verify").addEventListener("submit", async (event) => {
  event.preventDefault();
  say("");
  const body = { email: emailAddress, code: $("email-code").value.trim(), name: $("email-name").value.trim() };
  try {
    const account = await call("api/signin/email/verify", body);
    show(account);
    if (account.signed_in && !account.students?.length) edit(null);
  } catch (error) {
    if (error.message === "name_needed") {
      $("email-name").hidden = false;
      $("email-name").focus();
      say("Ese correo todavía no tiene cuenta: escribe tu nombre para crearla.");
    } else {
      say("Ese código no es correcto o ya venció. Pide uno nuevo si hace falta.");
    }
  }
});

$("email-back").addEventListener("click", () => {
  $("email-verify").hidden = true;
  $("email-start").hidden = false;
  $("email-code").value = "";
  $("email-address").focus();
});

function drawGoogle(clientId) {
  googleClient = clientId;
  window.google.accounts.id.initialize({
    client_id: clientId,
    ux_mode: "popup",
    callback: async ({ credential }) => {
      say("");
      try {
        const account = await call("api/signin", { credential });
        show(account);
        // A family with no student yet starts by adding one.
        if (account.signed_in && !account.students?.length) edit(null);
      } catch {
        say("No se pudo entrar con esa cuenta de Google. Inténtalo otra vez.");
      }
    },
  });
  renderGoogle();
}

$("kind").replaceChildren(
  ...Object.entries(KINDS).map(([value, text]) => chip("radio", "kind", value, text, value === "")),
);
$("kind").addEventListener("change", showToday);
$("subject").addEventListener("change", showToday);
$("add-student").addEventListener("click", () => edit(null));

$("who").addEventListener("submit", (event) => {
  event.preventDefault();
  say("");
  const student = students.find((one) => one.id === chosen("student"));
  if (!student) return say("Agrega un alumno para empezar.");
  const today = objective();
  request = {
    student_id: student.id,
    language: student.language ?? "es",
    ...(today ? { objective: today } : {}),
  };
  enter();
});

$("sign-out").addEventListener("click", async () => {
  request = null;
  await call("api/signout", {}).catch(() => undefined);
  show(await call("api/account").catch(() => ({ signed_in: false })));
});

$("erase").addEventListener("submit", async (event) => {
  event.preventDefault();
  say("");
  const sure = window.confirm(
    "¿Borrar tu cuenta, tus alumnos y todo lo guardado? No se puede deshacer.",
  );
  if (!sure) return;
  try {
    await call("api/account/erase", { email: $("erase-email").value });
    request = null;
    $("erase-email").value = "";
    show(await call("api/account").catch(() => ({ signed_in: false })));
    say("Tu cuenta y tus datos se borraron.");
  } catch (error) {
    say(
      error?.message === "wrong_email"
        ? "Ese no es el correo con el que entraste."
        : "No se pudo borrar la cuenta. Inténtalo otra vez.",
    );
  }
});

// Back from GitHub, Facebook or Apple without having signed in. The address
// is cleaned so that reloading the page does not say it again.
const outcome = new URLSearchParams(location.search).get("signin");
if (outcome) {
  history.replaceState(null, "", location.pathname);
  if (outcome === "failed") say("No se pudo entrar con esa cuenta. Inténtalo otra vez o usa otra.");
}

// The cookie notice, until the person says they have read it. Remembered in
// this browser only; where the browser keeps nothing, it is shown each time.
const COOKIES_READ = "aule.cookies";
try {
  $("cookies").hidden = localStorage.getItem(COOKIES_READ) === "read";
} catch {
  $("cookies").hidden = false;
}
$("cookies-ok").addEventListener("click", () => {
  $("cookies").hidden = true;
  try {
    localStorage.setItem(COOKIES_READ, "read");
  } catch {
    // Not remembered: it shows again next time.
  }
});

const googleScript = loadGoogleScript();
call("api/account")
  .then((account) => {
    show(account);
    if (!account.google_client_id) return;
    googleScript.then(
      () => drawGoogle(account.google_client_id),
      // Somebody already signed in has no use for the button, nor for its failure.
      () => {
        if (!$("signed-out").hidden) say("No se pudo cargar el botón de Google.");
      },
    );
  })
  .catch(() => show({ signed_in: false, google_client_id: null }));
