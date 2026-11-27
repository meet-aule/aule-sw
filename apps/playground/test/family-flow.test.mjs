// Run the page's authentication and summary transitions with controlled
// responses: no mailbox, real family or tutoring session is involved.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { codeDigits } from "../public/steps.js";
import { homeWords } from "../public/summaries.js";

const read = (name) => readFile(new URL(`../public/${name}`, import.meta.url), "utf8");
const signin = await read("signin.js");
const reviews = (await read("reviews.js")).replace(/^import .*;\n/gm, "").replace(/^export /gm, "");

function source(text, name) {
  const found = text.match(new RegExp(`\\n(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(found, name);
  return found;
}

function element() {
  return {
    value: "", hidden: false, disabled: false, textContent: "", children: [], attributes: {},
    focus() { this.focused = true; },
    setAttribute(key, value) { this.attributes[key] = value; },
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); },
    addEventListener() {},
  };
}

function login(respond) {
  const fields = new Map();
  const $ = (id) => {
    if (!fields.has(id)) fields.set(id, element());
    return fields.get(id);
  };
  $("email-name-field").hidden = true;
  const calls = [], accounts = [], messages = [];
  const page = runInNewContext(`
    let verifying = false, emailAddress = "family@example.test";
    const codeInput = $("email-code");
    const drawDigits = () => {};
    const entryText = (key) => key;
    ${["nameError", "clearCode", "waiting", "verify"].map((name) => source(signin, name)).join("\n")}
    ({ verify, clearCode })`, {
    $, codeDigits,
    say: (message) => messages.push(message),
    entered: (account) => accounts.push(account),
    call: async (path, body) => {
      calls.push({ path, body: JSON.parse(JSON.stringify(body)) });
      return respond(body);
    },
  });
  return { ...page, $, calls, accounts, messages };
}

test("a new account is asked for its name only after a valid code, and submits that code again", async () => {
  const page = login(async ({ code, name }) => {
    if (code !== "123456") throw new Error("wrong_code");
    if (!name) throw new Error("name_needed");
    return { signed_in: true, students: [] };
  });
  page.$("email-code").value = "123456";
  await page.verify();
  assert.equal(page.$("email-name-field").hidden, false);
  assert.equal(page.$("email-name").focused, true);
  assert.equal(page.accounts.length, 0);
  assert.deepEqual(page.calls[0].body, { email: "family@example.test", code: "123456" });
  await page.verify();
  assert.equal(page.calls.length, 1, "an empty name never sends another request");
  page.$("email-name").value = "  Example guardian  ";
  await page.verify();
  assert.deepEqual(page.calls[1].body, { email: "family@example.test", code: "123456", name: "Example guardian" });
  assert.equal(page.accounts.length, 1);
});

test("a returning account enters without a name, while an incorrect or expired code never enters", async () => {
  const existing = login(async () => ({ signed_in: true, students: [{ id: "one" }] }));
  existing.$("email-code").value = "123456";
  await existing.verify();
  assert.equal(existing.accounts.length, 1);
  assert.equal(existing.$("email-name-field").hidden, true);
  assert.equal("name" in existing.calls[0].body, false);

  const invalid = login(async () => { throw new Error("wrong_code"); });
  invalid.$("email-code").value = "000000";
  await invalid.verify();
  assert.equal(invalid.accounts.length, 0);
  assert.equal(invalid.$("email-name-field").hidden, true);
  assert.equal(invalid.$("email-code").value, "");
  // The name step is not authentication: an expired code must be checked again.
  invalid.$("email-name-field").hidden = false;
  invalid.$("email-name").value = "Example guardian";
  invalid.$("email-code").value = "123456";
  await invalid.verify();
  assert.equal(invalid.accounts.length, 0);
  assert.equal(invalid.$("email-name").value, "");
  assert.equal(invalid.$("code-continue").disabled, false);
});

test("submitting twice while a code is being checked sends only one request", async () => {
  let resolve;
  const page = login(() => new Promise((done) => { resolve = done; }));
  page.$("email-code").value = "123456";
  const first = page.verify();
  await page.verify();
  assert.equal(page.calls.length, 1);
  assert.equal(page.$("code-continue").disabled, true);
  resolve({ signed_in: true });
  await first;
  assert.equal(page.accounts.length, 1);
});

/** The entry's email field and «Enviarme un código», with the words' keys in place of the words. */
function entry(respond) {
  const fields = new Map();
  const $ = (id) => {
    if (!fields.has(id)) fields.set(id, element());
    return fields.get(id);
  };
  $("email-error").hidden = true;
  $("email-start").querySelector = () => $("email-send");
  const calls = [], messages = [], screens = [];
  const page = runInNewContext(`
    let emailAddress = "";
    const EMAIL = ${signin.match(/\nconst EMAIL = (\/.+\/);/)[1]};
    const entryText = (key) => key;
    const clearCode = () => {};
    ${["emailError", "startEmail"].map((name) => source(signin, name)).join("\n")}
    ({ startEmail, address: () => emailAddress })`, {
    $,
    say: (message) => messages.push(message),
    go: (screen) => screens.push(screen),
    call: async (path, body) => {
      calls.push({ path, body: JSON.parse(JSON.stringify(body)) });
      return respond(body);
    },
  });
  const send = () => page.startEmail({ preventDefault() {}, submitter: $("email-send") });
  return { ...page, $, send, calls, messages, screens };
}

test("an empty email is asked for and a malformed one is said, under the field, and neither is sent", async () => {
  const page = entry(async ({ email }) => {
    if (email === "refused@example.test") throw new Error("bad_email");
    return {};
  });
  const field = page.$("email-address"), line = page.$("email-error");

  // Nothing written, or only spaces: an address is required.
  for (const empty of ["", "   "]) {
    field.value = empty;
    field.focused = false;
    await page.send();
    assert.equal(line.hidden, false);
    assert.equal(line.textContent, "email_required");
    assert.equal(field.attributes["aria-invalid"], "true");
    assert.equal(field.focused, true, "the field takes the focus");
  }

  // Something that is not an address: the other line, in the same place.
  field.value = "family.example.test";
  await page.send();
  assert.equal(line.hidden, false);
  assert.equal(line.textContent, "email_invalid");
  assert.equal(field.attributes["aria-invalid"], "true");
  assert.deepEqual(page.calls, [], "nothing was sent");
  assert.deepEqual(page.screens, [], "and the entry stays");

  // An address the platform refuses is said the same way.
  field.value = "refused@example.test";
  await page.send();
  assert.equal(line.textContent, "email_invalid");
  assert.equal(line.hidden, false);
  assert.equal(page.$("email-send").disabled, false, "the button works again");
  assert.deepEqual(page.screens, []);

  // A good one clears the line and goes on to the code, trimmed.
  field.value = "  family@example.test ";
  await page.send();
  assert.equal(line.hidden, true);
  assert.equal(field.attributes["aria-invalid"], "false");
  assert.deepEqual(page.calls.at(-1), { path: "api/signin/email/start", body: { email: "family@example.test" } });
  assert.equal(page.address(), "family@example.test");
  assert.deepEqual(page.screens, ["p03"]);
});

/** A row of the card as the script handles it: its attributes, its tag, and whether it shows. */
function way(provider) {
  const tag = { hidden: false };
  const attributes = new Map([["role", "link"], ["aria-disabled", "true"]]);
  return {
    dataset: { provider }, tag, attributes, hidden: false,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
    querySelector: (selector) => (selector === ".provider-soon" ? tag : null),
  };
}

/** The card's rows under the real showWays and offer, for what the server says is set up. */
function ways(account, googleFailed = false) {
  const links = ["github", "apple", "meta"].map(way);
  const google = { hidden: true };
  const fields = new Map();
  const $ = (id) => {
    if (!fields.has(id)) fields.set(id, element());
    return fields.get(id);
  };
  const page = runInNewContext(`
    const CODE_PROVIDERS = ${signin.match(/\nconst CODE_PROVIDERS = (\[.+\]);/)[1]};
    let googleFailed = ${googleFailed};
    ${["showWays", "offer"].map((name) => source(signin, name)).join("\n")}
    ({ showWays })`, {
    $,
    document: { querySelectorAll: (selector) => (selector === "[data-google]" ? [google] : selector === "[data-provider]" ? links : []) },
  });
  page.showWays(account);
  const row = (provider) => links.find((link) => link.dataset.provider === provider);
  return { row, google, or: $("ways-or"), email: $("email-start") };
}

test("a way in the server has is a link, and one it does not have yet stays in its place as «Pronto», no link at all", () => {
  // What production says today: Google and GitHub, and the emailed code.
  const today = ways({ google_client_id: "client-1", providers: ["github", "email"], signed_in: false });
  assert.equal(today.google.hidden, false);
  assert.equal(today.row("github").attributes.get("href"), "api/signin/github/start");
  assert.equal(today.row("github").attributes.has("aria-disabled"), false);
  assert.equal(today.row("github").attributes.has("role"), false, "a link with an address needs no role said");
  assert.equal(today.row("github").tag.hidden, true);
  for (const later of ["apple", "meta"]) {
    const row = today.row(later);
    assert.equal(row.hidden, false, `${later}'s row shows`);
    assert.equal(row.attributes.has("href"), false, `${later}: nothing to follow, and Tab passes it`);
    assert.equal(row.attributes.get("aria-disabled"), "true", later);
    assert.equal(row.attributes.get("role"), "link", later);
    assert.equal(row.tag.hidden, false, `${later} says «Pronto»`);
  }
  assert.equal(today.or.hidden, false);
  assert.equal(today.email.hidden, false);

  // Once the server reports them, Apple and Facebook work as GitHub does.
  const later = ways({ google_client_id: "client-1", providers: ["github", "apple", "meta", "email"], signed_in: false });
  assert.equal(later.row("apple").attributes.get("href"), "api/signin/apple/start");
  assert.equal(later.row("meta").attributes.get("href"), "api/signin/meta/start");
  for (const provider of ["apple", "meta"]) {
    assert.equal(later.row(provider).attributes.has("aria-disabled"), false, provider);
    assert.equal(later.row(provider).tag.hidden, true, provider);
  }

  // No client id, or Google's script did not load: Google's row is not there. The others keep their places.
  const none = ways({ google_client_id: null, providers: ["email"], signed_in: false });
  assert.equal(none.google.hidden, true);
  assert.equal(ways({ google_client_id: "client-1", providers: ["email"], signed_in: false }, true).google.hidden, true);
  for (const provider of ["github", "apple", "meta"]) {
    assert.equal(none.row(provider).hidden, false, provider);
    assert.equal(none.row(provider).attributes.has("href"), false, provider);
  }
  // A provider the page does not know is never made a link, whatever the server says.
  assert.equal(ways({ providers: ["github", "x"], signed_in: false }).row("github").attributes.get("href"), "api/signin/github/start");
});

test("Google's own button is stretched from its corner until it covers its row exactly", () => {
  const { cover } = runInNewContext(`${source(signin, "cover")}\n({ cover })`);
  // A desktop's row is 522 by 54; Google's button is 400 by 40, at the slot's corner.
  assert.equal(cover({ width: 522, height: 54 }, { left: 0, top: 0, width: 400, height: 40 }), "scale(1.305, 1.35) translate(0px, 0px)");
  // A phone's row is as wide as the button asked for: stretched down only.
  assert.equal(cover({ width: 300, height: 54 }, { left: 0, top: 0, width: 300, height: 40 }), "scale(1, 1.35) translate(0px, 0px)");
  // A button laid out away from the corner is brought to it first.
  assert.equal(cover({ width: 400, height: 80 }, { left: 10, top: 2, width: 200, height: 40 }), "scale(2, 2) translate(-10px, -2px)");
  // The fit reads the frame's own place and size and the margins that say where its button is, never a fixed number.
  const fit = source(signin, "fitGoogle");
  assert.match(fit, /slot\.querySelector\("iframe"\) \?\? slot\.firstElementChild/);
  assert.match(fit, /getComputedStyle\(drawn\)/);
  assert.match(fit, /drawn\.offsetWidth - 2 \* aside/);
  assert.match(fit, /drawn\.offsetHeight - 2 \* above/);
});

// Every word of the entry's four screens, as signin.js has them.
const WORDS = runInNewContext(`(${signin.match(/\nconst ENTRY_WORDS = (\{[^]*?\n\});/)[1]})`);
const index = await read("index.html");

test("every word of the entry exists in Spanish and in English, under the same key", () => {
  assert.deepEqual(Object.keys(WORDS).sort(), ["en", "es"]);
  assert.deepEqual(Object.keys(WORDS.en).sort(), Object.keys(WORDS.es).sort());
  for (const [language, words] of Object.entries(WORDS)) {
    for (const [key, text] of Object.entries(words)) {
      assert.equal(typeof text, "string", `${language}.${key}`);
      assert.ok(text.trim() === text && text.length > 0, `${language}.${key} is said, with no space around it`);
    }
  }
  // A few words are the same in both; every other one is translated, not copied.
  const same = Object.keys(WORDS.es).filter((key) => WORDS.es[key] === WORDS.en[key]);
  assert.deepEqual(same, []);
  // The small print, as the owner wrote it in each language.
  assert.equal(`${WORDS.es.privacy_lead} ${WORDS.es.privacy_link}.`, "Al continuar, confirmas que conoces la Política de privacidad de Aule.");
  assert.equal(`${WORDS.en.privacy_lead} ${WORDS.en.privacy_link}.`, "By continuing, you confirm that you are familiar with Aule’s Privacy Policy.");
  assert.equal(WORDS.en.not_sent, "The code could not be sent. Try again in a moment.");
  assert.equal(WORDS.en.not_checked, "The code could not be checked. Try again in a moment.");
  // Every key is used: named by an element of the page, or said by the script outside the table.
  const script = signin.replace(/\nconst ENTRY_WORDS = \{[^]*?\n\};/, "");
  for (const key of Object.keys(WORDS.es)) {
    const named = index.includes(`data-entry="${key}"`) || index.includes(`data-entry-placeholder="${key}"`);
    assert.ok(named || script.includes(`"${key}"`), `${key} is used`);
  }
  // And the script asks for no key that is not there.
  for (const [, key] of signin.matchAll(/entryText\("(\w+)"/g)) assert.ok(key in WORDS.es, key);
});

/** The four screens of the entry as the page has them: p01, p03, p14 and p15. */
function entryScreens() {
  const start = (id) => index.lastIndexOf("<section", index.indexOf(`data-screen="${id}"`));
  const between = (from, to) => index.slice(start(from), start(to));
  return between("p01", "p04") + between("p14", "home");
}

test("drawn with the page in English, the entry's four screens have no Spanish left in them", () => {
  const screens = entryScreens();
  // Each element that names its words, with the Spanish the page is written in.
  const named = [...screens.matchAll(/<(\w+)\b[^>]*\bdata-entry="(\w+)"[^>]*>([^<]*)</g)].map(([, , key, text]) => ({ dataset: { entry: key }, textContent: text }));
  const fields = [...screens.matchAll(/<input\b[^>]*\bplaceholder="([^"]*)"[^>]*\bdata-entry-placeholder="(\w+)"/g)].map(([, text, key]) => ({ dataset: { entryPlaceholder: key }, placeholder: text }));
  assert.ok(named.length >= 30 && fields.length === 2);
  // As written, the page is the Spanish of the words, key by key.
  for (const element of named) assert.equal(element.textContent, WORDS.es[element.dataset.entry], element.dataset.entry);
  for (const field of fields) assert.equal(field.placeholder, WORDS.es[field.dataset.entryPlaceholder]);
  assert.equal(screens.match(/\splaceholder="/g).length, fields.length, "no placeholder without its key");

  // The real entryWords, with the page in English.
  const greeting = element();
  const draw = (lang, returning) => runInNewContext(`
    const ENTRY_WORDS = ${JSON.stringify(WORDS)};
    const RETURNING = "aule.returning", local = null;
    ${signin.match(/\nconst entryText = .+;/)[0]}
    ${source(signin, "entryWords")}
    entryWords()`, {
    $: (id) => (id === "entry-greeting" ? greeting : element()),
    recall: () => (returning ? "1" : null),
    document: {
      documentElement: { lang },
      querySelectorAll: (selector) => (selector === "[data-entry]" ? named : selector === "[data-entry-placeholder]" ? fields : []),
    },
  });
  draw("en", false);
  for (const element of named) assert.equal(element.textContent, WORDS.en[element.dataset.entry], element.dataset.entry);
  for (const field of fields) assert.equal(field.placeholder, WORDS.en[field.dataset.entryPlaceholder]);
  assert.equal(greeting.textContent, "Welcome");
  const drawn = [...named.map((element) => element.textContent), ...fields.map((field) => field.placeholder)];
  // No row says «Continuar con …» or «Pronto»: each reads "Continue with …" and "Soon".
  for (const label of ["google", "github", "apple", "meta"]) assert.ok(drawn.includes(WORDS.en[label]), label);
  assert.equal(drawn.filter((text) => text === "Soon").length, 3);
  assert.ok(!drawn.some((text) => /Continuar con|Pronto/.test(text)));
  // Nothing drawn is a Spanish word of the table.
  const spanish = new Set(Object.values(WORDS.es));
  for (const text of drawn) assert.ok(!spanish.has(text), text);
  draw("en", true);
  assert.equal(greeting.textContent, "Welcome back!");

  // And nothing a person reads on these screens is written outside the table: with the named elements
  // taken out, what is left is the name, an arrow, a full stop and the team's address.
  const left = screens
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<svg[\s\S]*?<\/svg>/g, "")
    .replace(/(<\w+\b[^>]*\bdata-entry="\w+"[^>]*>)[^<]*/g, "$1")
    .replace(/<[^>]+>/g, "\n")
    .split("\n").map((text) => text.trim()).filter(Boolean);
  // The greeting is written by the script from "greeting" or "returning".
  assert.deepEqual([...new Set(left)].sort(), [".", "Aule", "Te damos la bienvenida", "admin@meetaule.com", "←"].sort());
  assert.equal(WORDS.es.greeting, "Te damos la bienvenida");
  // No label a screen reader would read is left in Spanish either: these screens name nothing by attribute.
  assert.deepEqual([...screens.matchAll(/\b(?:aria-label|title|alt)="([^"]+)"/g)].map(([, text]) => text), ["Avance", "Avance"]);

  // Back in Spanish it is the page as written.
  draw("es", false);
  for (const element of named) assert.equal(element.textContent, WORDS.es[element.dataset.entry], element.dataset.entry);
});

function reader() {
  let account = { signed_in: true, students: [{ id: "one", name: "Example A" }, { id: "two", name: "Example B" }] };
  let screen = "home";
  const fields = new Map(), shown = new Map(), hidden = new Map();
  const requests = [], watchers = [];
  const $ = (id) => {
    if (!fields.has(id)) fields.set(id, element());
    return fields.get(id);
  };
  const page = runInNewContext(`${reviews}\n({ openSummaries, load })`, {
    $, homeWords,
    document: { documentElement: { lang: "es" }, createElement: element },
    current: () => screen,
    getAccount: () => account,
    go: (next) => { hidden.get(screen)?.(); screen = next; shown.get(next)?.(); },
    need() {},
    onShow: (id, handler) => shown.set(id, handler),
    onHide: (id, handler) => hidden.set(id, handler),
    onAccount: (handler) => watchers.push(handler),
    call: (path, body) => new Promise((resolve, reject) => requests.push({ path, body, resolve, reject })),
  });
  return {
    $, requests,
    open: (id) => page.openSummaries(account.students.find((one) => one.id === id)),
    leave() { hidden.get(screen)?.(); screen = "home"; },
    signOut() { account = { signed_in: false }; watchers.forEach((watch) => watch(account)); },
    reload: page.load,
  };
}
const tick = () => new Promise((done) => setImmediate(done));
const summary = (text) => ({ sessions: [{ day: "2026-11-25", summary: text, next: "Practise again." }] });

test("late summaries cannot replace another child's, return after leaving, or survive signing out", async () => {
  const page = reader();
  page.open("one");
  page.open("two");
  page.requests[1].resolve(summary("Second child's review"));
  await tick();
  page.requests[0].resolve(summary("Obsolete review"));
  await tick();
  assert.equal(page.$("summary-list").children[0].children[1].textContent, "Second child's review");
  page.signOut();
  assert.equal(page.$("summary-list").children.length, 0);
  assert.equal(page.$("summaries-title").textContent, "");

  const left = reader();
  left.open("one");
  left.leave();
  left.requests[0].resolve(summary("Too late"));
  await tick();
  assert.equal(left.$("summary-list").children.length, 0);
  assert.equal(left.$("summaries-retry").hidden, true);
});

test("empty and failed summaries offer a retry; review markup stays text", async () => {
  const page = reader();
  page.open("one");
  page.requests[0].resolve({ sessions: [] });
  await tick();
  assert.match(page.$("summaries-status").textContent, /Todavía no hay resúmenes/);
  assert.equal(page.$("summaries-retry").hidden, false);
  const failed = page.reload();
  page.requests[1].reject(new Error("unavailable"));
  await failed;
  assert.match(page.$("summaries-status").textContent, /No pudimos/);
  const ready = page.reload();
  const markup = '<img src=x onerror="throw 1">';
  page.requests[2].resolve(summary(markup));
  await ready;
  const text = page.$("summary-list").children[0].children[1];
  assert.equal(text.textContent, markup);
  assert.equal(text.children.length, 0);
});
