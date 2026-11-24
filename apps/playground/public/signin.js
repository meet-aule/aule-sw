// The screens before an account (Figma «Login-Aule» v8, page 160:1345): who
// is here (C00, C01), the ways in (P01, and P13 for a family coming back), the
// emailed code (P02, P03, and a name the first time), and the help when it
// does not arrive (P14, P15). Also the first look at who is signed in, where
// the page starts, signing out and erasing the account. The page never holds
// the session itself: the server keeps it in a cookie it alone reads.

import { $, call, say } from "./students.js";
import { codeDigits, greeting, maskEmail } from "./steps.js";
import { current, getAccount, go, landing, need, onShow, setAccount } from "./screens.js";

const GOOGLE_SCRIPT = "https://accounts.google.com/gsi/client";
// Sign-ins that leave the page for the provider's and come back with a code.
const CODE_PROVIDERS = ["github", "meta", "apple"];
// This browser has signed in before: P13 then says welcome back (Nota · P13 · Saludo).
const RETURNING = "aule.returning";
// The screen a person left from for GitHub, Facebook or Apple, to come back to it.
const FROM = "aule.from";
// An address that looks like one; the platform checks it properly.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// «Reenviar» rests this long after a code is sent again.
const RESEND_REST_MS = 30_000;

const WRONG_CODE = "Ese código no es correcto o ya venció. Pide uno nuevo si hace falta.";
const NOT_SENT = "No se pudo enviar el código. Inténtalo otra vez en un momento.";
const NOT_CHECKED = "No se pudo revisar el código. Inténtalo otra vez en un momento.";

// What the browser keeps for the page, read and written where it may refuse.
function recall(store, key) {
  try {
    return store().getItem(key);
  } catch {
    return null;
  }
}

function remember(store, key, value) {
  try {
    store().setItem(key, value);
  } catch {
    // Not kept: the page just does not know it next time.
  }
}

function forget(store, key) {
  try {
    store().removeItem(key);
  } catch {
    // Nothing kept that could be removed.
  }
}

const local = () => localStorage;
const tab = () => sessionStorage;

// The address the code goes to, held in memory only, for P03, P14 and P15.
let emailAddress = "";
need("email", () => Boolean(emailAddress));

/** Forgets the address, and P02's field that held it: signed in it is not needed, signed out it is not to be left behind. */
function forgetAddress() {
  emailAddress = "";
  $("email-address").value = "";
}

// --- C00 ¿Quién eres? and C01 ¿Ya tienes cuenta? ------------------------------

$("c00-parent").addEventListener("click", () => go("c01"));
$("c00-child").addEventListener("click", () => go("c00-student"));
$("c01-new").addEventListener("click", () => go("p01", { flow: "new" }));
$("c01-back").addEventListener("click", () => go("p13", { flow: "back" }));

// --- P01 and P13: the ways in --------------------------------------------------

/** Shows each way in only where the server has it set up; GitHub, Facebook and Apple fold away under «Otras formas de entrar». */
function showWays(account) {
  const providers = account.providers ?? [];
  const google = Boolean(account.google_client_id) && !googleFailed;
  const email = providers.includes("email");
  const others = CODE_PROVIDERS.filter((provider) => providers.includes(provider));
  for (const slot of document.querySelectorAll("[data-google]")) slot.hidden = !google;
  for (const button of document.querySelectorAll('[data-way="email"]')) button.hidden = !email;
  for (const details of document.querySelectorAll(".other-ways")) {
    details.hidden = others.length === 0;
    // When they are the only ways in, they show open.
    if (!google && !email) details.open = true;
    for (const link of details.querySelectorAll("[data-provider]")) link.hidden = !others.includes(link.dataset.provider);
  }
}

for (const button of document.querySelectorAll('[data-way="email"]')) {
  button.addEventListener("click", () => {
    $("email-address").value = emailAddress;
    go("p02");
  });
}

// Coming back from the provider, the page returns to the screen the person left.
for (const link of document.querySelectorAll("[data-provider]")) {
  link.addEventListener("click", () => remember(tab, FROM, current() ?? "p13"));
}

let googleReady = false;
let googleFailed = false;
// Google's script, once a sign-in screen has asked for it.
let googleScript = null;

// Google draws its own button (Figma: Botón/Google 168:991, «no restyle»):
// only its options and its slot's width are ours, up to Google's 400 px.
function renderGoogle(id) {
  const slot = $(id);
  if (!googleReady || slot.hidden) return;
  const width = Math.min(400, Math.max(200, Math.round(slot.getBoundingClientRect().width) || 342));
  window.google.accounts.id.renderButton(slot, {
    type: "standard",
    theme: "outline",
    size: "large",
    text: "continue_with",
    shape: "rectangular",
    logo_alignment: "center",
    locale: "es",
    width,
  });
}

function googleTrouble() {
  if (googleFailed && !getAccount().signed_in) say("No se pudo cargar el botón de Google.");
}

// A guardian on the way in (C01) will want Google's button on the next screen.
onShow("c01", needGoogle);

onShow("p01", () => {
  needGoogle();
  renderGoogle("google-p01");
  googleTrouble();
});

onShow("p13", () => {
  $("p13-greeting").textContent = greeting(recall(local, RETURNING) === "1");
  needGoogle();
  renderGoogle("google-p13");
  googleTrouble();
});

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

// Google's script is fetched only where a guardian signs in, once, the first
// time one of those screens shows: a student's screens and a family already
// signed in never load it. The button is drawn once it is in.
function needGoogle() {
  const account = getAccount();
  if (googleScript || account.signed_in || !account.google_client_id) return;
  googleScript = loadGoogleScript().then(
    () => drawGoogle(account.google_client_id),
    () => {
      googleFailed = true;
      showWays(getAccount());
      if (["p01", "p13"].includes(current())) googleTrouble();
    },
  );
}

function drawGoogle(clientId) {
  window.google.accounts.id.initialize({
    client_id: clientId,
    ux_mode: "popup",
    callback: async ({ credential }) => {
      say("");
      try {
        entered(await call("api/signin", { credential }));
      } catch {
        say("No se pudo entrar con esa cuenta de Google. Inténtalo otra vez.");
      }
    },
  });
  googleReady = true;
  if (current() === "p01") renderGoogle("google-p01");
  if (current() === "p13") renderGoogle("google-p13");
}

/** Signed in, by any way: a family with students goes to them, a new one starts by adding one. */
function entered(account) {
  remember(local, RETURNING, "1");
  forgetAddress();
  clearCode();
  $("email-name").value = "";
  setAccount(account);
  // What came before (the ways in, the code) is over: Back does not go into it.
  go(account.students?.length ? "home" : "p04", { replace: true, fresh: true });
}

// --- P02 Tu correo ------------------------------------------------------------

function emailError(on) {
  $("email-address").setAttribute("aria-invalid", String(on));
  $("email-error").hidden = !on;
  if (on) $("email-address").focus();
}

$("email-address").addEventListener("input", () => {
  if ($("email-address").getAttribute("aria-invalid") === "true") emailError(false);
});

$("email-start").addEventListener("submit", async (event) => {
  event.preventDefault();
  const address = $("email-address").value.trim();
  if (!EMAIL.test(address) || address.length > 254) return emailError(true);
  emailError(false);
  say("");
  const send = event.submitter ?? $("email-start").querySelector("[type=submit]");
  send.disabled = true;
  try {
    await call("api/signin/email/start", { email: address });
  } catch (error) {
    if (error.message === "bad_email") return emailError(true);
    return say(NOT_SENT);
  } finally {
    send.disabled = false;
  }
  emailAddress = address;
  clearCode();
  go("p03");
});

// --- P03 Código: six boxes over one field ---------------------------------------

const codeInput = $("email-code");
const boxes = [...document.querySelectorAll(".digit-boxes span")];
let verifying = false;

// The boxes mirror the field: a digit in each, and the copper border on the
// next one to fill while the field has the focus (Dígito/Base · Foco).
function drawDigits() {
  const digits = codeInput.value;
  const focused = document.activeElement === codeInput;
  boxes.forEach((box, index) => {
    box.textContent = digits[index] ?? "";
    box.classList.toggle("focus", focused && digits.length < 6 && index === digits.length);
  });
}

function clearCode() {
  codeInput.value = "";
  drawDigits();
}

function waiting(on) {
  $("code-wait").hidden = !on;
  codeInput.disabled = on;
  $("code-continue").disabled = on;
}

// Typed, pasted as «519 042» or «519-042», or filled by the browser: the
// digits are kept, and the sixth sends it.
codeInput.addEventListener("input", () => {
  // Typing again, the last error no longer holds.
  say("");
  const digits = codeDigits(codeInput.value);
  if (codeInput.value !== digits) codeInput.value = digits;
  drawDigits();
  if (digits.length === 6) verify();
});
codeInput.addEventListener("focus", drawDigits);
codeInput.addEventListener("blur", drawDigits);

async function verify(name) {
  if (verifying) return;
  const code = codeDigits(codeInput.value);
  if (code.length !== 6) {
    say("Escribe los seis dígitos del código.");
    codeInput.focus();
    return;
  }
  verifying = true;
  waiting(true);
  say("");
  let account = null;
  let failure = null;
  try {
    account = await call("api/signin/email/verify", { email: emailAddress, code, ...(name ? { name } : {}) });
  } catch (error) {
    failure = error.message;
  } finally {
    verifying = false;
    waiting(false);
  }
  if (account) return entered(account);
  // A new address: its name first (the code is not used up by asking).
  if (failure === "name_needed") return go("p03-name");
  if (current() === "p03-name") {
    clearCode();
    return go("p03", { replace: true, direction: "back", message: WRONG_CODE });
  }
  say(failure === "wrong_code" ? WRONG_CODE : NOT_CHECKED);
  clearCode();
  codeInput.focus();
}

$("email-verify").addEventListener("submit", (event) => {
  event.preventDefault();
  verify();
});

$("code-resend").addEventListener("click", async () => {
  const resend = $("code-resend");
  resend.disabled = true;
  setTimeout(() => (resend.disabled = false), RESEND_REST_MS);
  try {
    await call("api/signin/email/start", { email: emailAddress });
    clearCode();
    say("Te enviamos un código nuevo.", "info");
  } catch {
    say(NOT_SENT);
  }
});

$("code-missing").addEventListener("click", () => go("p14"));

// --- P03 · Tu nombre (web-only): the platform needs it for a new family --------

$("email-name-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("email-name").value.trim();
  const empty = !name;
  $("email-name").setAttribute("aria-invalid", String(empty));
  $("email-name-error").hidden = !empty;
  if (empty) return $("email-name").focus();
  verify(name.slice(0, 120));
});

// --- P14 Revisa tu correo and P15 Escríbenos -----------------------------------

onShow("p14", () => {
  $("masked-email").textContent = maskEmail(emailAddress);
});

$("write-us-go").addEventListener("click", () => go("p15"));

$("other-email").addEventListener("click", () => {
  emailAddress = "";
  $("email-address").value = "";
  go("p02");
});

// Help by email, with the address that was tried already written in.
onShow("p15", () => {
  const subject = encodeURIComponent("No me llega el código");
  const body = emailAddress ? `&body=${encodeURIComponent(`Intenté entrar con ${emailAddress}.`)}` : "";
  $("write-us").href = `mailto:admin@meetaule.com?subject=${subject}${body}`;
});

// --- Signing out and erasing --------------------------------------------------

async function signedOut(message) {
  // Nothing typed while signed in stays in a hidden field: the address, the one to erase with.
  forgetAddress();
  $("erase-email").value = "";
  const account = await call("api/account").catch(() => ({ signed_in: false }));
  // Each module forgets what it drew about the family before the first question shows.
  setAccount(account);
  showWays(account);
  go(landing(), { replace: true, fresh: true, message, tone: "info" });
}

$("sign-out").addEventListener("click", async () => {
  await call("api/signout", {}).catch(() => undefined);
  await signedOut("");
});

$("erase").addEventListener("submit", async (event) => {
  event.preventDefault();
  say("");
  // No address, or not one: said here, before the question that cannot be undone.
  if (!EMAIL.test($("erase-email").value.trim())) {
    $("erase-email").focus();
    return say("Escribe el correo con el que entraste.");
  }
  const sure = window.confirm("¿Borrar tu cuenta, tus alumnos y todo lo guardado? No se puede deshacer.");
  if (!sure) return;
  try {
    await call("api/account/erase", { email: $("erase-email").value });
  } catch (error) {
    return say(
      error?.message === "wrong_email"
        ? "Ese no es el correo con el que entraste."
        : "No se pudo borrar la cuenta. Inténtalo otra vez.",
    );
  }
  $("erase-email").value = "";
  // The account is gone: this browser no longer greets it as coming back
  // (signing out keeps that, as P13's note asks), nor returns to a provider's screen.
  forget(local, RETURNING);
  forget(tab, FROM);
  await signedOut("Tu cuenta y tus datos se borraron.");
});

// --- The cookie notice ----------------------------------------------------------

// Shown until the person says they have read it. Remembered in this browser
// only; where the browser keeps nothing, it is shown each time. While it
// shows, the screens leave it room at the bottom.
const COOKIES_READ = "aule.cookies";

function noticeRoom() {
  const notice = $("cookies");
  // Not drawn on a student's screen: the room it needs back on paper is kept.
  if (!notice.hidden && notice.offsetHeight === 0) return;
  const room = notice.hidden ? 0 : Math.round(notice.getBoundingClientRect().height) + 32;
  document.documentElement.style.setProperty("--notice-room", `${room}px`);
}

$("cookies").hidden = recall(local, COOKIES_READ) === "read";
noticeRoom();
// Measured again whenever the notice changes size: a narrower window wraps it,
// and a paper screen draws it again after a student's.
new ResizeObserver(() => noticeRoom()).observe($("cookies"));
$("cookies-ok").addEventListener("click", () => {
  $("cookies").hidden = true;
  remember(local, COOKIES_READ, "read");
  noticeRoom();
});

// --- Where the page starts ---------------------------------------------------------

// Back from GitHub, Facebook or Apple without having signed in. The address
// is cleaned so that reloading the page does not say it again.
const outcome = new URLSearchParams(location.search).get("signin");
if (outcome) history.replaceState(null, "", location.pathname);

function start(account) {
  setAccount(account);
  showWays(account);
  if (account.signed_in) {
    remember(local, RETURNING, "1");
    return go(account.students?.length ? "home" : "p04", { fresh: true });
  }
  if (outcome && landing()) {
    const from = recall(tab, FROM) === "p01" ? "p01" : "p13";
    const message = outcome === "failed" ? "No se pudo entrar con esa cuenta. Inténtalo otra vez o usa otra." : "";
    return go(from, { flow: from === "p01" ? "new" : "back", message });
  }
  go(landing());
}

call("api/account")
  .then(start)
  .catch(() => start({ signed_in: false, google_client_id: null, providers: [] }));
