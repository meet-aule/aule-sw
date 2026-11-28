// Run the page's authentication and summary transitions with controlled
// responses: no mailbox, real family or tutoring session is involved.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { codeDigits } from "../public/steps.js";
import { homeWords } from "../public/summaries.js";
import { wordsIn } from "../public/i18n.js";
import es from "../public/words/es.js";
import en from "../public/words/en.js";

const read = (name) => readFile(new URL(`../public/${name}`, import.meta.url), "utf8");
const signin = await read("signin.js");
const language = await read("language.js");
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

// Every word of the entry's four screens, as the page's words have them (words/es.js `entry`).
const WORDS = { es: es.entry, en: en.entry };
const index = await read("index.html");

test("every word of the entry exists in Spanish and in English, under the same key", () => {
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
  // Every key is used: named by an element of the page, or said by the script.
  for (const key of Object.keys(WORDS.es)) {
    const named = index.includes(`data-i18n="entry.${key}"`) || index.includes(`:entry.${key}"`);
    assert.ok(named || signin.includes(`"${key}"`), `${key} is used`);
  }
  // And the script asks for no key that is not there.
  for (const [, key] of signin.matchAll(/entryText\("(\w+)"/g)) assert.ok(key in WORDS.es, key);
  assert.match(signin, /\nconst entryText = \(key\) => t\(`entry\.\$\{key\}`\);/);
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
  const named = [...screens.matchAll(/<(\w+)\b[^>]*\bdata-i18n="([\w.-]+)"[^>]*>([^<]*)</g)].map(([, , key, text]) => ({ dataset: { i18n: key }, textContent: text }));
  const fields = [...screens.matchAll(/<(?:input|ol)\b[^>]*\b(placeholder|aria-label)="([^"]*)"[^>]*\bdata-i18n-attr="([\w.:-]+)"/g)].map(([, attribute, text, key]) => ({
    dataset: { i18nAttr: key },
    attribute,
    [attribute]: text,
    setAttribute(name, value) { this[name] = value; },
  }));
  assert.ok(named.length >= 30 && fields.length === 4);
  // As written, the page is the Spanish of the words, key by key.
  for (const element of named) assert.equal(element.textContent, wordsIn("es", element.dataset.i18n), element.dataset.i18n);
  for (const field of fields) assert.equal(field[field.attribute], wordsIn("es", field.dataset.i18nAttr.split(":")[1]));
  // The one name with no key is the logo's, once a screen: Aule's name is the same in every language (FIGMA.md D49).
  const names = [...screens.matchAll(/\s(placeholder|aria-label|title|alt)="([^"]+)"/g)].map(([, attribute, text]) => `${attribute}=${text}`);
  assert.equal(names.filter((name) => name === "alt=Aule").length, 4);
  assert.equal(names.filter((name) => name !== "alt=Aule").length, fields.length, "no placeholder or label without its key");

  // The real write() of language.js, with the page in English.
  const root = { lang: "es" };
  const draw = (lang) => runInNewContext(`${source(language, "write")}\nwrite()`, {
    language: () => lang,
    t: (key, values) => wordsIn(lang, key, values),
    document: {
      documentElement: root,
      querySelectorAll: (selector) => (selector === "[data-i18n]" ? named : selector === "[data-i18n-attr]" ? fields : []),
    },
  });
  draw("en");
  assert.equal(root.lang, "en");
  for (const element of named) assert.equal(element.textContent, wordsIn("en", element.dataset.i18n), element.dataset.i18n);
  for (const field of fields) assert.equal(field[field.attribute], wordsIn("en", field.dataset.i18nAttr.split(":")[1]));
  const drawn = [...named.map((element) => element.textContent), ...fields.map((field) => field[field.attribute])];
  // No row says «Continuar con …» or «Pronto»: each reads "Continue with …" and "Soon".
  for (const label of ["google", "github", "apple", "meta"]) assert.ok(drawn.includes(WORDS.en[label]), label);
  assert.equal(drawn.filter((text) => text === "Soon").length, 3);
  assert.ok(!drawn.some((text) => /Continuar con|Pronto/.test(text)));
  // Nothing drawn is a Spanish word of the page.
  const spanish = new Set(Object.values(es).flatMap((group) => Object.values(group)));
  for (const text of drawn) assert.ok(!spanish.has(text), text);

  // And nothing a person reads on these screens is written outside the page's words: with the named
  // elements taken out, what is left is an arrow, a full stop and the team's address (the name is the logo's, above).
  const left = screens
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<svg[\s\S]*?<\/svg>/g, "")
    .replace(/(<\w+\b[^>]*\bdata-i18n="[\w.-]+"[^>]*>)[^<]*/g, "$1")
    .replace(/<[^>]+>/g, "\n")
    .split("\n").map((text) => text.trim()).filter(Boolean);
  assert.deepEqual([...new Set(left)].sort(), [".", "admin@meetaule.com", "←"].sort());
  // The eyebrow is written by the script over the markup's own: a line of its pool, or "welcome" or "back".
  assert.match(screens, /<p class="question-step" id="entry-greeting" data-i18n="lines\.welcome">Te damos la bienvenida<\/p>/);

  // Back in Spanish it is the page as written.
  draw("es");
  assert.equal(root.lang, "es");
  for (const element of named) assert.equal(element.textContent, wordsIn("es", element.dataset.i18n), element.dataset.i18n);
});

// --- The eyebrow's lines (D47) ---------------------------------------------------

// The pool and its picker, as signin.js has them.
const LINES_SOURCE = signin.match(/\nconst TIMED = [^;]+;[^]*?\nconst RARE = [^;]+;\nconst ENTRY_LINES = \[[^]*?\n\];/)[0];
const drawn = runInNewContext(`
  ${LINES_SOURCE}
  ${["lineHolds", "pickLine"].map((name) => source(signin, name)).join("\n")}
  ({ ENTRY_LINES, pickLine, lineHolds })`);
const { pickLine, lineHolds } = drawn;
// An array of this file's own, so its lists compare with lists made here; each line with its words in
// both languages, as the page's words have them under its key (words/es.js `lines`).
const LINES = [...drawn.ENTRY_LINES].map((line) => ({ ...line, es: es.lines[line.key], en: en.lines[line.key] }));

/** A clock at `hour` on a weekday `day` (0 is Sunday), as the picker reads it. */
const clock = (hour, day) => ({ getHours: () => hour, getDay: () => day });
/** A random source that is always the same sequence (mulberry32). */
function seeded(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// When each kind of line may come out, said here apart from the pool's own conditions.
const HOURS = { morning: [5, 6, 7, 8, 9, 10, 11], afternoon: [12, 13, 14, 15, 16, 17, 18], evening: [19, 20, 21, 22], night: [23, 0, 1, 2, 3, 4] };
const WHEN = {
  "Buenos días. ¿Tarea temprano?": { hours: HOURS.morning },
  "Con el desayuno entra mejor": { hours: HOURS.morning },
  "Buenas tardes. Hora de la tarea": { hours: HOURS.afternoon },
  "Después del cole, un ratito": { hours: HOURS.afternoon },
  "Buenas noches. ¿Tarea de último minuto?": { hours: HOURS.evening },
  "Todavía hay tiempo antes de dormir": { hours: HOURS.evening },
  "¿Despiertos a esta hora?": { hours: HOURS.night },
  "Shhh… los niños duermen": { hours: HOURS.night },
  "La tarea puede esperar a mañana": { hours: HOURS.night },
  "Lunes. Empezamos bien": { days: [1] },
  "Viernes: última tarea de la semana": { days: [5] },
  "Fin de semana y aquí estás": { days: [0, 6] },
  "Domingo de repaso": { days: [0] },
  "¡Qué bueno que estés de vuelta!": { returning: true },
  "Otra vez por aquí. Bien.": { returning: true },
  "El cuy te estaba esperando": { returning: true },
};
const may = (line, returning, hour, day) => {
  const when = WHEN[line.es] ?? {};
  return (!when.hours || when.hours.includes(hour)) && (!when.days || when.days.includes(day)) && (!when.returning || returning);
};

test("every line of the eyebrow has its English beside its Spanish, and neither is longer than 40 characters", () => {
  assert.ok(LINES.length >= 20);
  for (const line of LINES) {
    for (const language of ["es", "en"]) {
      assert.equal(typeof line[language], "string", JSON.stringify(line));
      assert.ok(line[language].trim() === line[language] && line[language].length > 0, line.es);
      assert.ok([...line[language]].length <= 40, `${line[language]} is ${[...line[language]].length} long`);
    }
    assert.notEqual(line.es, line.en, line.es);
    // A condition is one the picker knows, and well formed.
    for (const key of Object.keys(line)) assert.ok(["key", "es", "en", "who", "from", "to", "days", "weight"].includes(key), `${line.es}: ${key}`);
    if (line.who) assert.ok(["new", "returning"].includes(line.who), line.es);
    assert.equal(line.from === undefined, line.to === undefined, `${line.es}: from and to go together`);
    if (line.days) assert.ok(line.days.length > 0 && line.days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6), line.es);
    assert.ok((line.weight ?? 1) > 0, line.es);
  }
  // No line twice, in either language.
  for (const language of ["es", "en"]) assert.equal(new Set(LINES.map((line) => line[language])).size, LINES.length, language);
  // Every line of the page's words is in the pool, once, and the pool has no other.
  assert.deepEqual(LINES.map((line) => line.key), Object.keys(es.lines));
  assert.deepEqual(Object.keys(en.lines), Object.keys(es.lines));
  // The two lines the eyebrow always had are in the pool and are what it falls back to.
  const of = (key) => LINES.find((line) => line.key === key);
  assert.deepEqual([of("welcome").es, of("welcome").en], ["Te damos la bienvenida", "Welcome"]);
  assert.deepEqual([of("back").es, of("back").en], ["¡Qué bueno que estés de vuelta!", "Good to see you back!"]);
  assert.equal(of("back").who, "returning");
  assert.equal(of("welcome").who, undefined);
  // A line tied to the hour or the day weighs three general ones; a rare one a small part of one.
  for (const line of LINES) {
    if (line.from !== undefined || line.days) assert.equal(line.weight, 3, line.es);
    else assert.ok(line.weight === undefined || line.weight <= 0.2, line.es);
  }
  assert.equal(LINES.filter((line) => line.weight !== undefined && line.weight < 1).length, 3, "three rare lines");
});

test("only a line whose conditions hold can come out, and every such line can", () => {
  for (const returning of [false, true]) {
    for (let hour = 0; hour < 24; hour += 1) {
      for (let day = 0; day < 7; day += 1) {
        const expected = LINES.filter((line) => may(line, returning, hour, day)).map((line) => line.es).sort();
        // The whole of the random source's range, finely: each line that may come out has its share of it.
        const out = new Set();
        for (let step = 0; step < 1000; step += 1) out.add(pickLine(LINES, returning, clock(hour, day), () => (step + 0.5) / 1000).es);
        assert.deepEqual([...out].sort(), expected, `${returning ? "returning" : "new"}, ${hour} h, day ${day}`);
        for (const line of LINES) assert.equal(lineHolds(line, returning, clock(hour, day)), may(line, returning, hour, day), line.es);
      }
    }
  }
  // The ends of the random source's range, and a pool where nothing holds.
  assert.equal(pickLine(LINES, false, clock(10, 3), () => 0).es, LINES[0].es);
  assert.ok(pickLine(LINES, false, clock(10, 3), () => 0.999999999));
  assert.equal(pickLine([{ es: "a", en: "b", who: "returning" }], false, clock(10, 3), () => 0.5), null);
  assert.equal(pickLine([], false, clock(10, 3), () => 0.5), null);
});

test("at two in the morning on a weekday a night line comes out most of the time, not always, and no two loads need agree", () => {
  const night = new Set(LINES.filter((line) => WHEN[line.es]?.hours === HOURS.night).map((line) => line.es));
  assert.equal(night.size, 3);
  for (const returning of [false, true]) {
    const random = seeded(returning ? 7 : 3);
    const draws = Array.from({ length: 2000 }, () => pickLine(LINES, returning, clock(2, 3), random).es);
    const distinct = new Set(draws);
    assert.ok(distinct.size > 1, "more than one line comes out");
    for (const line of night) assert.ok(distinct.has(line), line);
    const share = draws.filter((line) => night.has(line)).length / draws.length;
    assert.ok(share > 0.45 && share < 0.75, `night lines come out ${Math.round(share * 100)} % of the time`);
    // The general lines still come out, and none tied to another hour or day does.
    assert.ok(distinct.has("Te damos la bienvenida"));
    assert.ok(![...distinct].some((line) => /Buenos días|Buenas tardes|Lunes|Viernes|Domingo|Fin de semana/.test(line)));
    // A rare line is rare: together, about one draw in forty.
    const rare = draws.filter((line) => ["El cuy dice hola", "Dos más dos sigue siendo cuatro", "Hecho en Lima, con tarea"].includes(line)).length;
    assert.ok(rare > 0 && rare / draws.length < 0.06, `${rare} rare lines in ${draws.length}`);
  }
});

test("the eyebrow's line is picked with Math.random and the visitor's clock, nothing is kept, and it never goes without words", () => {
  const body = source(signin, "greeting");
  assert.match(body, /pickLine\(ENTRY_LINES, returning, new Date\(\), Math\.random\)/);
  assert.doesNotMatch(body, /remember\(|setItem|sessionStorage|localStorage/);
  assert.equal(signin.match(/Math\.random/g).length, 1, "no other chance in the sign-in");
  const greet = ({ pick, returning = false, lang = "es" }) => runInNewContext(`
    const ENTRY_LINES = [], RETURNING = "aule.returning", local = null;
    let entryLine = null;
    ${body}
    [greeting(), greeting()]`, { pickLine: pick, recall: () => (returning ? "1" : null), t: (key, values) => wordsIn(lang, key, values) });
  // A picked line, in the page's language; one load keeps its line however often the entry shows.
  let picks = 0;
  const pick = () => { picks += 1; return { key: ["come_in", "pencil"][picks - 1] }; };
  assert.deepEqual([...greet({ pick })], ["Pasa, que hay tarea", "Pasa, que hay tarea"]);
  assert.deepEqual([...greet({ pick, lang: "en" })], ["Pencil, notebook and the will to try", "Pencil, notebook and the will to try"]);
  // The picker fails, finds nothing, or hands back a line without words: the two lines of always.
  for (const broken of [() => { throw new Error("no"); }, () => null, () => ({}), () => ({ key: "nope" })]) {
    assert.deepEqual([...greet({ pick: broken })], ["Te damos la bienvenida", "Te damos la bienvenida"]);
    assert.deepEqual([...greet({ pick: broken, returning: true })], ["¡Qué bueno que estés de vuelta!", "¡Qué bueno que estés de vuelta!"]);
    assert.deepEqual([...greet({ pick: broken, returning: true, lang: "en" })], ["Good to see you back!", "Good to see you back!"]);
  }
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
    language: () => "es",
    locale: () => "es-PE",
    document: { createElement: element },
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
