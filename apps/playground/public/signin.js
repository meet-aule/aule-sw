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

// Every word of the entry (P01), its code and name step (P03) and the two help
// screens after it (P14, P15), in Spanish and in English: the same keys in
// both. An element of the page names its key in data-entry, a field its
// placeholder's in data-entry-placeholder; the rest is said from here.
const ENTRY_WORDS = {
  es: {
    title: "Entra a Aule",
    greeting: "Te damos la bienvenida",
    returning: "¡Qué bueno que estés de vuelta!",
    help: "Entra o crea tu cuenta, sin contraseña.",
    google: "Continuar con Google",
    github: "Continuar con GitHub",
    apple: "Continuar con Apple",
    meta: "Continuar con Facebook",
    soon: "Pronto",
    or: "o",
    email: "Tu correo",
    email_placeholder: "nombre@correo.com",
    email_required: "Escribe tu correo electrónico.",
    email_invalid: "Revisa el correo: no parece una dirección válida.",
    send: "Enviarme un código",
    privacy_lead: "Al continuar, confirmas que conoces la",
    privacy_link: "Política de privacidad de Aule",
    google_failed: "No se pudo cargar el botón de Google.",
    google_refused: "No se pudo entrar con esa cuenta de Google. Inténtalo otra vez.",
    provider_failed: "No se pudo entrar con esa cuenta. Inténtalo otra vez o usa otra.",
    not_sent: "No se pudo enviar el código. Inténtalo otra vez en un momento.",
    erased: "Tu cuenta y tus datos se borraron.",
    code_tab: "Código",
    code_title: "Escribe el código que te enviamos",
    code_help: "Puedes pegarlo. Llega en un minuto.",
    code_label: "Código de 6 dígitos",
    code_wait: "Revisando tu código. Suele tardar unos segundos; si no avanza, pide uno nuevo.",
    code_short: "Escribe los seis dígitos del código.",
    wrong_code: "Ese código no es correcto o ya venció. Pide uno nuevo si hace falta.",
    not_checked: "No se pudo revisar el código. Inténtalo otra vez en un momento.",
    code_resent: "Te enviamos un código nuevo.",
    name: "Tu nombre",
    name_placeholder: "Ej.: Ana",
    name_error: "Escribe tu nombre para crear tu cuenta.",
    name_help: "Código correcto. Para crear tu cuenta, dinos cómo te llamas.",
    continue: "Continuar",
    resend: "Reenviar",
    missing: "No me llega el correo",
    back: "Atrás",
    check_title: "Revisa tu correo",
    check_help: "Te enviamos un código para entrar. Si no lo ves, revisa la carpeta de spam o de promociones; puede tardar un minuto.",
    sent_to: "Lo enviamos a",
    still_missing: "¿Sigue sin llegar? Escríbenos",
    other_email: "Probar con otro correo",
    help_tab: "Escríbenos",
    help_step: "¿No llega el código?",
    help_title: "Te ayudamos por correo",
    help_text: "Escríbenos y te ayudamos a entrar personalmente.",
    write_us: "Escribir a",
    mail_subject: "No me llega el código",
    mail_body: "Intenté entrar con",
  },
  en: {
    title: "Sign in to Aule",
    greeting: "Welcome",
    returning: "Welcome back!",
    help: "Sign in or create your account, without a password.",
    google: "Continue with Google",
    github: "Continue with GitHub",
    apple: "Continue with Apple",
    meta: "Continue with Facebook",
    soon: "Soon",
    or: "or",
    email: "Your email",
    email_placeholder: "name@email.com",
    email_required: "An email address is required.",
    email_invalid: "Check the email: it does not look like a valid address.",
    send: "Send me a code",
    privacy_lead: "By continuing, you confirm that you are familiar with",
    privacy_link: "Aule’s Privacy Policy",
    google_failed: "Google’s button could not be loaded.",
    google_refused: "We could not sign you in with that Google account. Try again.",
    provider_failed: "We could not sign you in with that account. Try again or use another.",
    not_sent: "The code could not be sent. Try again in a moment.",
    erased: "Your account and your data were erased.",
    code_tab: "Code",
    code_title: "Enter the code we sent you",
    code_help: "You can paste it. It should arrive within a minute.",
    code_label: "6-digit code",
    code_wait: "Checking your code. It usually takes a few seconds; if nothing happens, ask for a new one.",
    code_short: "Enter the six digits of the code.",
    wrong_code: "That code is not right or has expired. Ask for a new one if you need to.",
    not_checked: "The code could not be checked. Try again in a moment.",
    code_resent: "We sent you a new code.",
    name: "Your name",
    name_placeholder: "E.g. Ana",
    name_error: "Enter your name to create your account.",
    name_help: "Code confirmed. Tell us your name to create your account.",
    continue: "Continue",
    resend: "Resend",
    missing: "I am not getting the email",
    back: "Back",
    check_title: "Check your email",
    check_help: "We sent you a code to sign in. If you do not see it, check your spam or promotions folder; it can take a minute.",
    sent_to: "We sent it to",
    still_missing: "Still not there? Write to us",
    other_email: "Try another email",
    help_tab: "Write to us",
    help_step: "Is the code not arriving?",
    help_title: "We will help you by email",
    help_text: "Write to us and we will help you sign in personally.",
    write_us: "Write to",
    mail_subject: "I am not getting the code",
    mail_body: "I tried to sign in with",
  },
};

const entryText = (key) => ENTRY_WORDS[document.documentElement.lang === "en" ? "en" : "es"][key];

/** Writes the words of the four screens in the page's language, each where its key is named. */
function entryWords() {
  for (const element of document.querySelectorAll("[data-entry]")) element.textContent = entryText(element.dataset.entry);
  for (const field of document.querySelectorAll("[data-entry-placeholder]")) field.placeholder = entryText(field.dataset.entryPlaceholder);
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

/**
 * The ways in, top to bottom (FIGMA.md D46): Google's row where there is a client id, then GitHub, Apple and
 * Facebook, whose rows always show, as a link where the server has the provider set up and as «Pronto» where
 * it does not, then «o» and the email field where a code can be sent.
 */
function showWays(account) {
  const providers = account.providers ?? [];
  const google = Boolean(account.google_client_id) && !googleFailed;
  const email = providers.includes("email");
  for (const row of document.querySelectorAll("[data-google]")) row.hidden = !google;
  for (const link of document.querySelectorAll("[data-provider]")) offer(link, CODE_PROVIDERS.includes(link.dataset.provider) && providers.includes(link.dataset.provider));
  $("email-start").hidden = !email;
  // «o» stands between the providers' rows and the email field.
  $("ways-or").hidden = !email;
}

/**
 * A provider's row. Set up, it is a link to that provider's sign-in. Not yet, it stays in its place with
 * «Pronto» at its end and is no link at all: no address, so nothing to follow or to reach with Tab, and
 * said as unavailable.
 */
function offer(link, on) {
  if (on) {
    link.setAttribute("href", `api/signin/${link.dataset.provider}/start`);
    link.removeAttribute("role");
    link.removeAttribute("aria-disabled");
  } else {
    link.removeAttribute("href");
    link.setAttribute("role", "link");
    link.setAttribute("aria-disabled", "true");
  }
  link.querySelector(".provider-soon").hidden = on;
}

let googleReady = false;
let googleFailed = false;
// Google's script, once a sign-in screen has asked for it.
let googleScript = null;
// What keeps Google's button fitted to its row: its sizes, and what Google's script draws.
let googleFit = null;
let googleDrawn = null;

// Google draws its own button (Figma: Botón/Google 168:991, «no restyle»), in
// a frame of its own and at most 400 px wide and 40 tall: it cannot be made
// the size of the other rows. So the row a person sees is the page's own
// (index.html), and Google's button lies over it, unseen, stretched until it
// covers the row exactly (fitGoogle). A click anywhere on the row is then a
// click on Google's own button, and the sign-in is Google's, as it was.
// What it looks like no longer matters; its words still follow the language,
// since a screen reader reads Google's button and not the row under it.
function renderGoogle(id) {
  const slot = $(id);
  const row = slot.parentElement;
  if (!googleReady || row.hidden) return;
  const width = Math.min(400, Math.max(200, Math.round(row.getBoundingClientRect().width) || 342));
  window.google.accounts.id.renderButton(slot, {
    type: "standard",
    theme: "outline",
    size: "large",
    text: "continue_with",
    shape: "rectangular",
    logo_alignment: "center",
    locale: document.documentElement.lang === "en" ? "en" : "es",
    width,
  });
  // Fitted now, and again whenever the row changes size or Google's script puts in or resizes its frame.
  googleFit?.disconnect();
  googleDrawn?.disconnect();
  googleFit = new ResizeObserver(() => fitGoogle(slot));
  googleFit.observe(row);
  googleDrawn = new MutationObserver(() => {
    for (const frame of slot.querySelectorAll("iframe")) googleFit.observe(frame);
    fitGoogle(slot);
  });
  googleDrawn.observe(slot, { childList: true, subtree: true });
  for (const frame of slot.querySelectorAll("iframe")) googleFit.observe(frame);
  fitGoogle(slot);
}

/**
 * The transform that lays a button exactly over its row: the button is `width` by `height`, at `left`, `top`
 * in its slot, whose corner is the row's; the row is `width` by `height`. Moved so the button's corner is the
 * slot's, then stretched from that corner.
 */
function cover(row, button) {
  return `scale(${row.width / button.width}, ${row.height / button.height}) translate(${-button.left}px, ${-button.top}px)`;
}

/** Lays Google's button over the whole of its row. */
function fitGoogle(slot) {
  const row = slot.parentElement;
  // Google's script draws the button in a frame; before the frame is in, whatever it has put there.
  const drawn = slot.querySelector("iframe") ?? slot.firstElementChild;
  if (!drawn?.offsetWidth || !drawn.offsetHeight || !row.clientWidth) return;
  // Where it is laid out in the slot and its size, as they are before any stretching.
  let left = 0;
  let top = 0;
  for (let box = drawn; box && box !== slot; box = box.offsetParent) {
    left += box.offsetLeft;
    top += box.offsetTop;
  }
  // Google's frame is larger than the button in it, with room for the button's ring, and is pulled back by
  // as much with negative margins: those say where in the frame the button is.
  const margins = getComputedStyle(drawn);
  const aside = Math.max(0, -parseFloat(margins.marginLeft) || 0);
  const above = Math.max(0, -parseFloat(margins.marginTop) || 0);
  slot.style.transform = cover(
    { width: row.clientWidth, height: row.clientHeight },
    { left: left + aside, top: top + above, width: drawn.offsetWidth - 2 * aside, height: drawn.offsetHeight - 2 * above },
  );
}

function googleTrouble() {
  if (googleFailed && !getAccount().signed_in) say(entryText("google_failed"));
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
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", tintBars);

// The tab's name, as steps.js has it in Spanish, in the page's language.
for (const [id, name] of Object.entries({ p01: "title", p03: "code_tab", p14: "check_title", p15: "help_tab" })) {
  onShow(id, () => (document.title = `Aule · ${entryText(name)}`));
}

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
        say(entryText("google_refused"));
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

/** The line under the email field: `words` names what it says, that an address is needed or that this is not one. */
function emailError(on, words = "email_invalid") {
  $("email-address").setAttribute("aria-invalid", String(on));
  if (on) $("email-error").textContent = entryText(words);
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

/** «Enviarme un código»: an address that is missing or is not one is said under the field and nothing is sent; else the code goes out and P03 shows. */
async function startEmail(event) {
  event.preventDefault();
  const address = $("email-address").value.trim();
  if (!address) return emailError(true, "email_required");
  if (!EMAIL.test(address) || address.length > 254) return emailError(true);
  emailError(false);
  say("");
  const send = event.submitter ?? $("email-start").querySelector("[type=submit]");
  send.disabled = true;
  try {
    await call("api/signin/email/start", { email: address });
  } catch (error) {
    if (error.message === "bad_email") return emailError(true);
    return say(entryText("not_sent"));
  } finally {
    send.disabled = false;
  }
  emailAddress = address;
  clearCode();
  go("p03");
}

$("email-start").addEventListener("submit", startEmail);

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
    say(entryText("code_short"));
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
  say(entryText(failure === "wrong_code" ? "wrong_code" : "not_checked"));
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
    say(entryText("code_resent"), "info");
  } catch {
    say(entryText("not_sent"));
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
  const subject = encodeURIComponent(entryText("mail_subject"));
  const body = emailAddress ? `&body=${encodeURIComponent(`${entryText("mail_body")} ${emailAddress}.`)}` : "";
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
  await signedOut(entryText("erased"));
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
