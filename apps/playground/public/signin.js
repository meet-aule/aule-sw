// One entry for new and returning families (FIGMA.md D42). A verified code
// asks for a name only when the platform needs one to create the account.
// The server keeps the authenticated session in a cookie it alone reads.

import { $, call, say } from "./students.js";
import { codeDigits, maskEmail } from "./steps.js";
import { current, getAccount, go, landing, need, onHide, onShow, setAccount } from "./screens.js";

const GOOGLE_SCRIPT = "https://accounts.google.com/gsi/client";
// Sign-ins that leave the page for the provider's and come back with a code.
const CODE_PROVIDERS = ["github", "meta", "apple"];
// This browser has signed in before: the entry then says welcome back.
const RETURNING = "aule.returning";
// An address that looks like one; the platform checks it properly.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// «Reenviar» rests this long after a code is sent again.
const RESEND_REST_MS = 30_000;

const WRONG_CODE = "Ese código no es correcto o ya venció. Pide uno nuevo si hace falta.";
const NOT_SENT = "No se pudo enviar el código. Inténtalo otra vez en un momento.";
const NOT_CHECKED = "No se pudo revisar el código. Inténtalo otra vez en un momento.";

const ENTRY_WORDS = {
  es: {
    title: "Entra a Aule",
    greeting: "Te damos la bienvenida",
    returning: "¡Qué bueno que estés de vuelta!",
    help: "Entra o crea tu cuenta, sin contraseña.",
    or: "o",
    email: "Tu correo",
    send: "Enviarme un código",
    name: "Tu nombre",
    name_error: "Escribe tu nombre para crear tu cuenta.",
    code_title: "Escribe el código que te enviamos",
    code_help: "Puedes pegarlo. Llega en un minuto.",
    name_help: "Código correcto. Para crear tu cuenta, dinos cómo te llamas.",
    continue: "Continuar",
    provider_failed: "No se pudo entrar con esa cuenta. Inténtalo otra vez o usa otra.",
  },
  en: {
    title: "Sign in to Aule",
    greeting: "Welcome",
    returning: "Welcome back!",
    help: "Sign in or create your account, without a password.",
    or: "or",
    email: "Your email",
    send: "Send me a code",
    name: "Your name",
    name_error: "Enter your name to create your account.",
    code_title: "Enter the code we sent you",
    code_help: "You can paste it. It should arrive within a minute.",
    name_help: "Code confirmed. Tell us your name to create your account.",
    continue: "Continue",
    provider_failed: "We could not sign you in with that account. Try again or use another.",
  },
};

const entryText = (key) => ENTRY_WORDS[document.documentElement.lang === "en" ? "en" : "es"][key];

function entryWords() {
  for (const [id, key] of [
    ["p01-title", "title"], ["entry-help", "help"], ["ways-or", "or"], ["email-label", "email"],
    ["email-send", "send"], ["email-name-label", "name"], ["email-name-error", "name_error"],
    ["p03-title", "code_title"], ["code-help", "code_help"], ["code-continue", "continue"],
  ]) $(id).textContent = entryText(key);
  $("entry-greeting").textContent = entryText(recall(local, RETURNING) === "1" ? "returning" : "greeting");
}

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

// The address the code goes to, held in memory only, for P03, P14 and P15.
let emailAddress = "";
need("email", () => Boolean(emailAddress));

/** Forgets the address and the name, and the fields that held them: signed in they are not needed, signed out they are not to be left behind. */
function forgetAddress() {
  emailAddress = "";
  $("email-address").value = "";
  $("email-name").value = "";
  $("email-name-field").hidden = true;
}

// --- One entry: email and the configured providers ----------------------------

/** Shows each way in only where the server has it set up: Google's button, Apple's, GitHub's and Facebook's, then the email field (FIGMA.md D45). */
function showWays(account) {
  const providers = account.providers ?? [];
  const google = Boolean(account.google_client_id) && !googleFailed;
  const email = providers.includes("email");
  const others = CODE_PROVIDERS.filter((provider) => providers.includes(provider));
  for (const slot of document.querySelectorAll("[data-google]")) slot.hidden = !google;
  for (const link of document.querySelectorAll("[data-provider]")) link.hidden = !others.includes(link.dataset.provider);
  $("email-start").hidden = !email;
  // «o» stands between the providers' buttons and the email field, where both show.
  $("ways-or").hidden = !email || (!google && others.length === 0);
  // Their own cookies are said where they are offered, not in the cookie notice.
  for (const note of document.querySelectorAll(".ways-note")) note.hidden = !google && others.length === 0;
}

let googleReady = false;
let googleFailed = false;
// Google's script, once a sign-in screen has asked for it.
let googleScript = null;

// Google draws its own button (Figma: Botón/Google 168:991, «no restyle»):
// only its options and its slot's width are ours, up to Google's 400 px. Its
// theme follows the entry's palette, which style.css names in --entry-google:
// Google's outlined button on paper, its black one on the near-dark.
function renderGoogle(id) {
  const slot = $(id);
  if (!googleReady || slot.hidden) return;
  const width = Math.min(400, Math.max(200, Math.round(slot.getBoundingClientRect().width) || 342));
  window.google.accounts.id.renderButton(slot, {
    type: "standard",
    theme: getComputedStyle(slot).getPropertyValue("--entry-google").trim() || "outline",
    size: "large",
    text: "continue_with",
    shape: "rectangular",
    logo_alignment: "center",
    locale: document.documentElement.lang === "en" ? "en" : "es",
    width,
  });
}

function googleTrouble() {
  if (googleFailed && !getAccount().signed_in) say("No se pudo cargar el botón de Google.");
}

// The entry and its code step have a palette of their own, which style.css
// switches (FIGMA.md D45). The browser's own bars follow the screen showing:
// the entry's background, and the paper's again on every other screen.
const barColor = document.querySelector('meta[name="theme-color"]');

function tintBars() {
  const background = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  if (background) barColor.content = background;
}

for (const id of ["p01", "p03"]) {
  onShow(id, tintBars);
  // Read once the next screen shows: until then the page still has this one's palette.
  onHide(id, () => queueMicrotask(tintBars));
}

// The system changed between light and dark with the page open.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  tintBars();
  if (current() === "p01") renderGoogle("google-p01");
});

onShow("p01", () => {
  entryWords();
  needGoogle();
  renderGoogle("google-p01");
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

// Google loads only on the signed-out entry, never for a family already signed in.
function needGoogle() {
  const account = getAccount();
  if (googleScript || account.signed_in || !account.google_client_id) return;
  googleScript = loadGoogleScript().then(
    () => drawGoogle(account.google_client_id),
    () => {
      googleFailed = true;
      showWays(getAccount());
      if (current() === "p01") googleTrouble();
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

// --- The email field on the entry --------------------------------------------

function emailError(on) {
  $("email-address").setAttribute("aria-invalid", String(on));
  $("email-error").hidden = !on;
  if (on) $("email-address").focus();
}

function nameError(on) {
  $("email-name").setAttribute("aria-invalid", String(on));
  $("email-name-error").hidden = !on;
  if (on) $("email-name").focus();
}

$("email-address").addEventListener("input", () => {
  if ($("email-address").getAttribute("aria-invalid") === "true") emailError(false);
});

$("email-name").addEventListener("input", () => {
  if ($("email-name").getAttribute("aria-invalid") === "true") nameError(false);
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
  $("email-name").value = "";
  $("email-name-field").hidden = true;
  nameError(false);
  $("code-help").textContent = entryText("code_help");
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
  if (digits.length === 6 && $("email-name-field").hidden) verify();
});
codeInput.addEventListener("focus", drawDigits);
codeInput.addEventListener("blur", drawDigits);

/** The code is checked before asking for a name, and checked again when creating the account. */
async function verify() {
  if (verifying) return;
  const code = codeDigits(codeInput.value);
  if (code.length !== 6) {
    say("Escribe los seis dígitos del código.");
    codeInput.focus();
    return;
  }
  const asking = !$("email-name-field").hidden;
  const name = $("email-name").value.trim();
  if (asking && !name) return nameError(true);
  nameError(false);
  verifying = true;
  waiting(true);
  say("");
  let account = null;
  let failure = null;
  try {
    account = await call("api/signin/email/verify", { email: emailAddress, code, ...(asking ? { name: name.slice(0, 120) } : {}) });
  } catch (error) {
    failure = error.message;
  } finally {
    verifying = false;
    waiting(false);
  }
  if (account) return entered(account);
  // No account-existence check before proof of the address. Asking does not consume the code.
  if (failure === "name_needed") {
    $("email-name-field").hidden = false;
    $("code-help").textContent = entryText("name_help");
    $("email-name").focus();
    return;
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

// --- P14 Revisa tu correo and P15 Escríbenos -----------------------------------

onShow("p14", () => {
  $("masked-email").textContent = maskEmail(emailAddress);
});

$("write-us-go").addEventListener("click", () => go("p15"));

$("other-email").addEventListener("click", () => {
  emailAddress = "";
  $("email-address").value = "";
  clearCode();
  go("p01");
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
  // The account is gone: this browser no longer greets it as coming back.
  forget(local, RETURNING);
  await signedOut("Tu cuenta y tus datos se borraron.");
});

// --- The cookie notice ----------------------------------------------------------

// Shown until the person says they have read it. Remembered in this browser
// only; where the browser keeps nothing, it is shown each time. While it
// shows, the screens leave it room at the bottom: from just above the
// notice's top edge down, so a paper screen ends where the notice starts and
// the footer after it starts behind the notice, never across its edge.
const COOKIES_READ = "aule.cookies";
// Above the notice's edge, so a control scrolled clear of it keeps its focus ring; under the footer's 24 px.
const NOTICE_CLEAR_PX = 8;

function noticeRoom() {
  const notice = $("cookies");
  // Not drawn on a student's screen: the room it needs back on paper is kept.
  if (!notice.hidden && notice.offsetHeight === 0) return;
  // Its height and its own distance from the bottom edge: none for the phone's bar, the card's inset from 481 px.
  const below = parseFloat(getComputedStyle(notice).bottom) || 0;
  const room = notice.hidden ? 0 : Math.round(notice.getBoundingClientRect().height + below) + NOTICE_CLEAR_PX;
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
    const message = outcome === "failed" ? entryText("provider_failed") : "";
    return go("p01", { message });
  }
  go(landing());
}

call("api/account")
  .then(start)
  .catch(() => start({ signed_in: false, google_client_id: null, providers: [] }));
