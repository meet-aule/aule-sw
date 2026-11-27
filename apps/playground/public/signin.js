// One entry for new and returning families (FIGMA.md D42). A verified code
// asks for a name only when the platform needs one to create the account.
// The server keeps the authenticated session in a cookie it alone reads.

import { $, call, say } from "./students.js";
import { codeDigits, maskEmail } from "./steps.js";
import { current, getAccount, go, landing, need, onHide, onShow, setAccount } from "./screens.js";
import { language, onLanguage, t } from "./i18n.js";

const GOOGLE_SCRIPT = "https://accounts.google.com/gsi/client";
// Sign-ins that leave the page for the provider's and come back with a code.
const CODE_PROVIDERS = ["github", "meta", "apple"];
// This browser has signed in before: the entry then says welcome back.
const RETURNING = "aule.returning";
// An address that looks like one; the platform checks it properly.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// «Reenviar» rests this long after a code is sent again.
const RESEND_REST_MS = 30_000;

// The entry's words (words/es.js `entry`), in the page's language. The markup of
// its four screens names its own (data-i18n, written by language.js); the rest
// is said from here.
const entryText = (key) => t(`entry.${key}`);

// The eyebrow over the entry's title is a splash line (FIGMA.md D47): on each
// load one line of this pool is picked at random, by weight, among those whose
// conditions hold for the visitor and by their own clock. Nothing is seeded
// and nothing is kept: two loads in a row may differ. A line may say who it is
// for ("new" or "returning"; either, when it does not say), the hours it holds
// in (from `from` up to, not including, `to`; round midnight when `from` is
// the later), the days of the week (0 is Sunday) and its weight (1 when it
// does not say). Its words are the page's, by `key` (words/es.js `lines`): none
// is longer than 40 characters in any language, so the eyebrow keeps to one
// line on a phone.
// A line tied to the hour or the day weighs three general ones: there it shows
// most of the time, not always.
const TIMED = 3;
// A rare line weighs a tenth of a general one: one of the three shows on about one visit in forty.
const RARE = 0.1;
const ENTRY_LINES = [
  // General, for anyone.
  { key: "welcome" },
  { key: "come_in" },
  { key: "pencil" },
  { key: "no_rush" },
  { key: "today" },
  // General, for a browser that has signed in before.
  { key: "back", who: "returning" },
  { key: "again", who: "returning" },
  { key: "cuy_waiting", who: "returning" },
  // The morning, 05:00 to 11:59.
  { key: "morning", from: 5, to: 12, weight: TIMED },
  { key: "breakfast", from: 5, to: 12, weight: TIMED },
  // The afternoon, 12:00 to 18:59.
  { key: "afternoon", from: 12, to: 19, weight: TIMED },
  { key: "after_school", from: 12, to: 19, weight: TIMED },
  // The evening, 19:00 to 22:59.
  { key: "evening", from: 19, to: 23, weight: TIMED },
  { key: "before_bed", from: 19, to: 23, weight: TIMED },
  // Late at night, 23:00 to 04:59.
  { key: "awake", from: 23, to: 5, weight: TIMED },
  { key: "asleep", from: 23, to: 5, weight: TIMED },
  { key: "tomorrow", from: 23, to: 5, weight: TIMED },
  // The day of the week.
  { key: "monday", days: [1], weight: TIMED },
  { key: "friday", days: [5], weight: TIMED },
  { key: "weekend", days: [6, 0], weight: TIMED },
  { key: "sunday", days: [0], weight: TIMED },
  // Rare, for anyone.
  { key: "cuy_hello", weight: RARE },
  { key: "two_plus_two", weight: RARE },
  { key: "lima", weight: RARE },
];

/** Whether a line's conditions hold for a new or a returning visitor, at `now` by the visitor's clock. */
function lineHolds(line, returning, now) {
  if (line.who && line.who !== (returning ? "returning" : "new")) return false;
  if (line.days && !line.days.includes(now.getDay())) return false;
  if (line.from === undefined) return true;
  const hour = now.getHours();
  return line.from < line.to ? hour >= line.from && hour < line.to : hour >= line.from || hour < line.to;
}

/**
 * One of the `lines` whose conditions hold, at random by weight; null when none holds. `random` gives a
 * number from 0 up to 1 and `now` is the visitor's clock: both are handed in, so a test can fix them.
 */
function pickLine(lines, returning, now, random) {
  const holding = lines.filter((line) => lineHolds(line, returning, now));
  const total = holding.reduce((sum, line) => sum + (line.weight ?? 1), 0);
  let left = random() * total;
  for (const line of holding) {
    left -= line.weight ?? 1;
    if (left < 0) return line;
  }
  return holding[holding.length - 1] ?? null;
}

// This load's line and whom it was picked for. Signing in or erasing the account makes the
// visitor another, and a line is picked again; coming back from the code step keeps it.
let entryLine = null;

/** The eyebrow's words in the page's language: this load's line, or one of the two lines it always had when none can be picked. */
function greeting() {
  const returning = recall(local, RETURNING) === "1";
  try {
    if (entryLine?.returning !== returning) entryLine = { returning, line: pickLine(ENTRY_LINES, returning, new Date(), Math.random) };
    const words = entryLine.line ? t(`lines.${entryLine.line.key}`) : "";
    if (words) return words;
  } catch {
    // Whatever went wrong, the eyebrow still greets.
  }
  return t(returning ? "lines.back" : "lines.welcome");
}

// The explanation stays out of the heading; hover, keyboard focus or a tap reveals it.
const helpControl = $("entry-help-control");
const helpTrigger = $("entry-help-trigger");
let helpPinned = false;
function showEntryHelp(open) {
  $("entry-help").hidden = !open;
  helpTrigger.setAttribute("aria-expanded", String(open));
  if (!open) helpPinned = false;
}
helpControl.addEventListener("pointerenter", (event) => {
  if (event.pointerType !== "touch") showEntryHelp(true);
});
helpControl.addEventListener("pointerleave", () => {
  if (!helpPinned && document.activeElement !== helpTrigger) showEntryHelp(false);
});
helpTrigger.addEventListener("focus", () => showEntryHelp(true));
helpTrigger.addEventListener("blur", () => showEntryHelp(false));
helpTrigger.addEventListener("click", () => {
  helpPinned = !helpPinned;
  showEntryHelp(helpPinned);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") showEntryHelp(false);
});
document.addEventListener("pointerdown", (event) => {
  if (!helpControl.contains(event.target)) showEntryHelp(false);
});
onHide("p01", () => showEntryHelp(false));

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
    locale: language(),
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

onShow("p01", () => {
  $("entry-greeting").textContent = greeting();
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

// A language just picked (language.js): the markup's words are already in it, and
// what this script wrote over them is said again. A complaint about the address
// goes: it is said again, in the new language, the next time it holds.
onLanguage(() => {
  $("code-help").textContent = entryText($("email-name-field").hidden ? "code_help" : "name_help");
  emailError(false);
  if (current() !== "p01") return;
  $("entry-greeting").textContent = greeting();
  renderGoogle("google-p01");
});

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
    return say(t("account.erase_email"));
  }
  const sure = window.confirm(t("account.erase_confirm"));
  if (!sure) return;
  try {
    await call("api/account/erase", { email: $("erase-email").value });
  } catch (error) {
    return say(t(error?.message === "wrong_email" ? "account.erase_wrong" : "account.erase_failed"));
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
// is cleaned so that reloading the page does not say it again; what else it
// asks for (a language) stays.
const address = new URL(location.href);
const outcome = address.searchParams.get("signin");
if (outcome) {
  address.searchParams.delete("signin");
  history.replaceState(null, "", `${address.pathname}${address.search}`);
}

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
