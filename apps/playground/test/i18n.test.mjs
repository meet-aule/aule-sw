// The page's words (public/words/, public/i18n.js) and the language they show
// in (public/language.js): every language says the same things under the same
// keys, the markup's Spanish is the words' Spanish, a visit's language is
// settled in one order, and drawn in English no screen keeps a Spanish word.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { LANGUAGES, SOURCE, count, countIn, keysOf, language, languageFor, languageNamed, languageOf, localeOf, onLanguage, setLanguage, t, wordsIn } from "../public/i18n.js";

const pub = new URL("../public/", import.meta.url);
const read = (name) => readFile(new URL(name, pub), "utf8");
const html = await read("index.html");
const picker = await read("language.js");
const es = LANGUAGES[SOURCE];
const others = Object.keys(LANGUAGES).filter((code) => code !== SOURCE);
// Every key of the Spanish, as "group.name".
const KEYS = Object.entries(es).flatMap(([group, words]) => Object.keys(words).map((name) => `${group}.${name}`));
const places = (text) => [...text.matchAll(/\{(\w+)\}/g)].map(([, place]) => place).sort();

test("every language is a file of words/, named in i18n.js and among the server's files", async () => {
  const files = (await readdir(new URL("words/", pub))).sort();
  assert.deepEqual(files, Object.keys(LANGUAGES).map((code) => `${code}.js`).sort());
  const server = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
  for (const file of files) {
    assert.ok(server.includes(`"/words/${file}": { file: new URL("words/${file}", publicDir)`), `${file} is served`);
    assert.match(server.match(/const OWN_SCRIPTS = new Set\(\[([^\]]*)\]\)/)[1], new RegExp(`"/words/${file}"`), `${file}'s address is fingerprinted where it is named`);
  }
  assert.equal(SOURCE, "es");
  assert.equal(Object.keys(LANGUAGES)[0], SOURCE, "Spanish, the page's own, comes first");
});

test("every key of the Spanish is in every other language, and no language has a key of its own", () => {
  assert.ok(KEYS.length > 400);
  for (const code of others) {
    const words = LANGUAGES[code];
    assert.deepEqual(Object.keys(words), Object.keys(es), `${code}: the same groups, in the same order`);
    for (const group of Object.keys(es)) assert.deepEqual(Object.keys(words[group]), Object.keys(es[group]), `${code}.${group}`);
  }
});

test("no word is empty or has space around it, and each language fills the same places", () => {
  for (const [code, words] of Object.entries(LANGUAGES)) {
    for (const key of KEYS) {
      const [group, name] = [key.slice(0, key.indexOf(".")), key.slice(key.indexOf(".") + 1)];
      const text = words[group][name];
      assert.equal(typeof text, "string", `${code} ${key}`);
      assert.ok(text.length > 0 && text.trim() === text, `${code} ${key} is said, with no space around it`);
      assert.deepEqual(places(text), places(es[group][name]), `${code} ${key} fills the places the Spanish fills`);
      assert.doesNotMatch(text.replace(/\{\w+\}/g, ""), /[{}]/, `${code} ${key}: a place is {name}`);
    }
  }
});

test("each language names itself in its own words and says which locale its dates and numbers are written in", () => {
  const names = Object.values(LANGUAGES).map((words) => words.language.name);
  assert.deepEqual(names.slice(0, 2), ["Español", "English"]);
  assert.equal(new Set(names).size, names.length);
  for (const code of Object.keys(LANGUAGES)) {
    const locale = localeOf(code);
    assert.deepEqual(Intl.getCanonicalLocales(locale), [locale], code);
    assert.equal(languageNamed(locale), code, `${locale} is ${code}'s`);
  }
  assert.equal(localeOf("es"), "es-PE");
  assert.equal(localeOf("en"), "en-GB");
  assert.equal(localeOf("xx"), "es-PE", "a language the page lacks is written as Spanish is");
});

test("a word that counts has the forms its language's plural rule names, and every language has `other`", () => {
  const counted = KEYS.filter((key) => key.endsWith("_one"));
  assert.ok(counted.length >= 6);
  for (const key of counted) {
    const stem = key.slice(0, -"_one".length);
    assert.ok(KEYS.includes(`${stem}_other`), `${stem}_other`);
    for (const code of Object.keys(LANGUAGES)) {
      for (const n of [0, 1, 2, 5, 21]) {
        const said = countIn(code, stem, n, { practising: 3, date: "d", allowed: 3 });
        assert.ok(said.includes(String(n)), `${code} ${stem} says ${n}`);
        assert.doesNotMatch(said, /[{}]/, `${code} ${stem}`);
      }
      assert.equal(countIn(code, stem, 1), wordsIn(code, `${stem}_one`, { n: 1 }), `${code} ${stem}: one`);
      assert.equal(countIn(code, stem, 2), wordsIn(code, `${stem}_other`, { n: 2 }), `${code} ${stem}: other`);
    }
  }
  assert.equal(countIn("es", "summary.exercises", 1), "1 ejercicio");
  assert.equal(countIn("es", "summary.exercises", 4), "4 ejercicios");
  assert.equal(countIn("en", "summary.breaks", 1), "1 break");
  assert.equal(countIn("en", "session.route_done", 2), "You have done 2 parts.");
  // A form the language has no words for is said with its `other`.
  assert.equal(countIn("es", "summary.exercises", 1_000_000), "1000000 ejercicios");
});

test("words are said by key, with their places filled; Spanish stands in for a missing key, and nothing for a key that is not one", () => {
  assert.equal(wordsIn("es", "home.hello", { name: "Ana" }), "Hola, Ana.");
  assert.equal(wordsIn("en", "home.hello", { name: "Ana" }), "Hello, Ana.");
  // A name is written as it is, «$» and all, and a place nobody filled is left empty.
  assert.equal(wordsIn("en", "home.hello", { name: "$& Mati" }), "Hello, $& Mati.");
  assert.equal(wordsIn("en", "home.hello"), "Hello, .");
  for (const key of ["home.nope", "nope.title", "home", "", ".title", "home.", "home.constructor", "__proto__.title", null, undefined, 3]) assert.equal(wordsIn("en", key), "", String(key));
  // A language the page lacks is said in Spanish, and so is a key one of its languages lacks.
  assert.equal(wordsIn("qu", "home.title"), es.home.title);
  assert.equal(languageOf("qu"), "es");
  assert.equal(languageOf("en"), "en");
  const said = LANGUAGES.en.home.title;
  delete LANGUAGES.en.home.title;
  try {
    assert.equal(wordsIn("en", "home.title"), es.home.title);
  } finally {
    LANGUAGES.en.home.title = said;
  }
  assert.deepEqual([...keysOf("ending")], Object.keys(es.ending));
});

test("a visit's language: the address's, then the one chosen before, then the browser's first that the page has, then Spanish", () => {
  assert.equal(languageFor(), "es");
  assert.equal(languageFor({ asked: null, kept: null, preferred: [] }), "es");
  // ?lang= wins over everything, when it names a language the page has.
  assert.equal(languageFor({ asked: "en", kept: "es", preferred: ["es-PE"] }), "en");
  assert.equal(languageFor({ asked: "es", kept: "en", preferred: ["en-US"] }), "es");
  assert.equal(languageFor({ asked: "EN-us", kept: "es" }), "en");
  // One it does not have is passed by, not shown as Spanish at once.
  assert.equal(languageFor({ asked: "zz", kept: "en", preferred: ["es"] }), "en");
  assert.equal(languageFor({ asked: "", kept: "en" }), "en");
  // Then the choice kept in this browser, over the browser's own languages.
  assert.equal(languageFor({ kept: "en", preferred: ["es-PE", "es"] }), "en");
  assert.equal(languageFor({ kept: "klingon", preferred: ["en-GB"] }), "en");
  // Then the first of the browser's that the page has, by its language whatever the region.
  assert.equal(languageFor({ preferred: ["qu-PE", "en-US", "es-PE"] }), "en");
  assert.equal(languageFor({ preferred: ["pt-BR", "es-419", "en"] }), "es");
  assert.equal(languageFor({ preferred: ["fr-FR", "de"] }), "es");
  assert.equal(languageNamed("constructor"), null);
  assert.equal(languageNamed(undefined), null);
});

test("the interface's language starts as Spanish, changes only to a language the page has, and tells whoever drew words", () => {
  const told = [];
  onLanguage((code) => told.push(code));
  assert.equal(language(), "es");
  assert.equal(t("home.title"), es.home.title);
  setLanguage("zz");
  setLanguage("es");
  assert.deepEqual(told, [], "nothing changed, nobody is told");
  setLanguage("en-GB");
  assert.equal(language(), "en");
  assert.equal(t("home.title"), LANGUAGES.en.home.title);
  assert.equal(count("summary.exercises", 2), "2 exercises");
  // A student's or a session's words are asked for by name, whatever the interface shows.
  assert.equal(wordsIn("es", "first.back"), "Volver");
  setLanguage("es");
  assert.deepEqual(told, ["en", "es"]);
  assert.equal(t("home.title"), es.home.title);
});

// --- The markup -----------------------------------------------------------------

const comments = /<!--[\s\S]*?-->/g;
const body = html.replace(comments, "");
/** Each element of `markup` that names its words, with the text it holds. */
const named = (markup) => [...markup.matchAll(/<(\w+)\b[^>]*\bdata-i18n="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g)].map(([, tag, key, text]) => ({ tag, key, text }));
/** Each attribute of `markup` that names its words, with the value it holds. */
const attributes = (markup) =>
  [...markup.matchAll(/<\w+\b[^>]*\bdata-i18n-attr="([^"]+)"[^>]*>/g)].flatMap(([tag, pairs]) =>
    pairs.split(" ").map((pair) => {
      const [attribute, key] = pair.split(":");
      return { attribute, key, value: tag.match(new RegExp(`\\s${attribute}="([^"]*)"`))?.[1] };
    }),
  );

test("every key the markup names is one of the words, and the markup's Spanish is the words' Spanish", () => {
  const elements = named(body);
  const marked = attributes(body);
  assert.ok(elements.length > 130 && marked.length > 20);
  for (const { tag, key, text } of elements) {
    assert.ok(KEYS.includes(key), `${key} (${tag})`);
    assert.doesNotMatch(text, /</, `${key}: an element that names its words holds only them`);
    assert.equal(text, wordsIn("es", key), key);
  }
  for (const { attribute, key, value } of marked) {
    assert.ok(KEYS.includes(key), `${attribute}:${key}`);
    assert.equal(value, wordsIn("es", key), `${attribute}:${key}`);
  }
  // No other way to name words is left in the page.
  assert.doesNotMatch(body, /data-entry/);
  assert.match(html, /<html lang="es" /, "the page as written is Spanish");
});

/** What a person reads in `markup` outside the elements that name their words: its text and its attributes' values. */
function unnamed(markup) {
  const text = markup
    .replace(/<svg[\s\S]*?<\/svg>/g, "")
    .replace(/(<(\w+)\b[^>]*\bdata-i18n="[^"]+"[^>]*>)[\s\S]*?(<\/\2>)/g, "$1$3")
    .replace(/<[^>]+>/g, "\n")
    .split("\n").map((line) => line.trim()).filter(Boolean);
  const values = [...markup.matchAll(/<\w+\b[^>]*>/g)]
    .filter(([tag]) => !/\bdata-i18n-attr=/.test(tag))
    .flatMap(([tag]) => [...tag.matchAll(/\s(?:aria-label|placeholder|title|alt)="([^"]+)"/g)].map(([, value]) => value));
  return [...text, ...values];
}

const section = (id) => body.match(new RegExp(`<section class="screen[^"]*" data-screen="${id}"[\\s\\S]*?\\n      </section>`))?.[0];
const PAPER = ["p01", "p03", "p04", "p05", "p06-grade", "p06", "p07", "p10-name", "p14", "p15", "home", "summaries", "editor"];
const INK = ["a02", "a04", "a04-details", "a05", "session", "session-end"];
// What the page says the same in every language: its name, an arrow, a full stop, the team's address,
// the build's line, and a language's own name.
const SAME = ["Aule", "←", ".", "admin@meetaule.com", "{{build}}", "Español", "English"];

test("on the family's screens, the notice and the footer, every word is one the page names", () => {
  for (const id of PAPER) {
    assert.ok(section(id), id);
    assert.deepEqual(unnamed(section(id)).filter((text) => !SAME.includes(text)), [], id);
  }
  const notice = body.match(/<div id="cookies"[\s\S]*?\n    <\/div>/)[0];
  assert.deepEqual(unnamed(notice), []);
  const footer = body.match(/<footer class="site-footer">[\s\S]*?<\/footer>/)[0];
  // Peru's complaints book keeps its name in every language, marked as Spanish.
  assert.match(footer, /<a href="https:\/\/meetaule\.com\/libro-de-reclamaciones" lang="es">Libro de Reclamaciones<\/a>/);
  assert.deepEqual(unnamed(footer).filter((text) => !SAME.includes(text)), ["Libro de Reclamaciones"]);
});

// The words a student's screen holds as written are the Spanish of the student's own words, which the
// scripts write over them in the student's or the session's language (first-steps.js, session-messages.js).
const STUDENT_GROUPS = ["first", "recovery"];
const studentKey = (text) => {
  for (const group of STUDENT_GROUPS) {
    const name = Object.keys(es[group]).find((one) => es[group][one] === text);
    if (name) return `${group}.${name}`;
  }
  return null;
};

test("on a student's screens, a word the page does not name is one of the student's own, in every language", () => {
  for (const id of INK) {
    assert.ok(section(id), id);
    for (const text of unnamed(section(id))) {
      // «(opcional)» stands inside its label, which the script writes whole.
      const key = studentKey(text) ?? studentKey(text.replace(/\s*\(opcional\)$/, ""));
      assert.ok(key, `${id}: «${text}» is not one of the student's words`);
      for (const code of others) assert.notEqual(wordsIn(code, key), "", `${code} ${key}`);
    }
  }
});

// --- Drawn in English ---------------------------------------------------------------

/** The words of a text, in lower case: letters only, so «Aule,» and «(opcional)» are «aule» and «opcional». */
const tokens = (text) => text.toLowerCase().match(/\p{L}+/gu) ?? [];
const said = (words) => new Set(Object.values(words).flatMap((group) => Object.values(group)).flatMap(tokens));

test("drawn in each other language, no screen keeps a word that only the Spanish has", () => {
  for (const code of others) {
    // The Spanish words this language never says: «alumno», «sesión», «guardar»… but not «Aule», «audio» or «a».
    const own = said(LANGUAGES[code]);
    const spanish = new Set([...said(es)].filter((word) => !own.has(word)));
    assert.ok(spanish.size > 300, `${code}: ${spanish.size} words are Spanish's alone`);
    for (const word of ["alumno", "sesión", "guardar", "correo", "hoy"]) assert.ok(spanish.has(word), word);

    // The page as language.js writes it (write): each named element and attribute in this language. A
    // student's screen, as its scripts write it for a student of this language.
    const draw = (markup, student) => {
      let drawn = markup.replace(/(<(\w+)\b[^>]*\bdata-i18n="([^"]+)"[^>]*>)[\s\S]*?(<\/\2>)/g, (_, open, tag, key, close) => `${open}${wordsIn(code, key)}${close}`);
      drawn = drawn.replace(/<\w+\b[^>]*\bdata-i18n-attr="([^"]+)"[^>]*>/g, (tag, pairs) =>
        pairs.split(" ").reduce((open, pair) => {
          const [attribute, key] = pair.split(":");
          return open.replace(new RegExp(`(\\s${attribute}=")[^"]*"`), (_, start) => `${start}${wordsIn(code, key)}"`);
        }, tag),
      );
      const lines = [
        ...drawn.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<(\w+)\b[^>]*\blang="es"[^>]*>[^<]*<\/\1>/g, "").replace(/<[^>]+>/g, "\n").split("\n"),
        ...[...drawn.matchAll(/\s(?:aria-label|placeholder|title|alt|content)="([^"]+)"/g)].map(([, value]) => value),
      ].map((line) => line.trim()).filter(Boolean);
      return lines.map((line) => {
        const key = student ? (studentKey(line) ?? studentKey(line.replace(/\s*\(opcional\)$/, ""))) : null;
        return key ? wordsIn(code, key) : line;
      });
    };
    const screens = [...PAPER.map((id) => [id, draw(section(id), false)]), ...INK.map((id) => [id, draw(section(id), true)])];
    // And around the screens: the page's title and description, the cookie notice and the footer.
    screens.push(["head", draw(body.slice(0, body.indexOf("</head>")).replace(/<meta name="aule[^>]*>/g, ""), false)]);
    screens.push(["notice and footer", draw(body.slice(body.indexOf('<div id="cookies"'), body.indexOf("</footer>")), false)]);
    for (const [id, lines] of screens) {
      assert.ok(lines.length > 0, id);
      for (const line of lines) {
        const kept = tokens(line).filter((word) => spanish.has(word));
        assert.deepEqual(kept, [], `${code} ${id}: «${line}»`);
      }
    }
  }
});

test("the scripts say their words by key: each key they name is one of the words, and none holds a Spanish sentence of its own", async () => {
  const names = ["app.js", "students.js", "signin.js", "screens.js", "onboarding.js", "home.js", "reviews.js", "summaries.js", "first-steps.js", "session-messages.js", "choices.js", "language.js", "steps.js"];
  const groups = Object.keys(es);
  const own = said(LANGUAGES.en);
  const spanish = new Set([...said(es)].filter((word) => !own.has(word) && word.length > 3));
  for (const name of names) {
    const script = (await read(name)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
    // A whole key, wherever it is written: t("home.title"), t(open ? "child.start" : "common.save"),
    // wordsIn(lang, "plan.team"); and one that counts, by its stem: count("editor.mastered", n).
    for (const [, key] of script.matchAll(new RegExp(`"((?:${groups.join("|")})\\.[^"]+)"`, "g"))) {
      assert.ok(KEYS.includes(key) || KEYS.includes(`${key}_other`), `${name}: ${key}`);
    }
    // A key made as it is said: t(`grade.${grade}`) names a group of the words.
    for (const [, group] of script.matchAll(/`([\w-]+)\.\$\{/g)) assert.ok(groups.includes(group), `${name}: ${group}.…`);
    // steps.js keeps the Figma's own names for its screens and options, which the page says by key.
    if (name === "steps.js") continue;
    for (const [literal] of script.matchAll(/"[^"\n]*"|`[^`]*`/g)) {
      // What is saved for an interest the page offers is the same in every language (students.js INTERESTS).
      if (Object.hasOwn(es.interest, literal.slice(1, -1))) continue;
      const kept = tokens(literal.replace(/\$\{[^}]*\}/g, " ")).filter((word) => spanish.has(word));
      assert.ok(kept.length < 2, `${name}: ${literal} is Spanish written in the script`);
    }
  }
});

// --- Which language shows (language.js) -------------------------------------------------

function source(text, name) {
  const found = text.match(new RegExp(`\\n(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(found, name);
  return found;
}

test("the language is settled by the page's first script, from the address, the kept choice and the browser's own, before any screen shows", () => {
  const scripts = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map(([, src]) => src);
  assert.equal(scripts[0], "language.js");
  assert.match(html, /<script type="module" src="language\.js"><\/script>/);
  // Every screen is hidden as written, so nothing shows before the scripts run.
  for (const [tag] of body.matchAll(/<section class="screen[^"]*"[^>]*>/g)) assert.match(tag, /\shidden\s/, tag);
  assert.match(picker, /let linked = languageNamed\(new URLSearchParams\(location\.search\)\.get\("lang"\)\);/);
  assert.match(picker, /\nsetLanguage\(languageFor\(\{ asked: linked, kept: kept\(\), preferred: navigator\.languages \?\? \[\] \}\)\);/);
  // The markup is written, and the browser told the language, as the script loads and at each change.
  assert.match(picker, /\nonLanguage\(write\);\nwrite\(\);\n$/);
  assert.match(source(picker, "write"), /document\.documentElement\.lang = language\(\);/);
});

/** language.js as a script, run against a stand-in for the page: `address` is where it loaded, `kept` what the browser holds. */
function load({ address = "https://aule.example/session/", kept = null, preferred = ["es-PE"], storage = true } = {}) {
  const store = new Map(kept ? [["aule.language", kept]] : []);
  const listeners = { click: [], keydown: [], pointerdown: [] };
  const element = (tag) => {
    const node = {
      tag, children: [], dataset: {}, attributes: {}, hidden: false, open: false, textContent: "", listeners: {},
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = nodes; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      removeAttribute(name) { delete this.attributes[name]; },
      addEventListener(type, listener) { this.listeners[type] = listener; },
      focus() { page.focused = this; },
      contains(other) { return other === this || this.children.some((child) => child.contains?.(other)); },
      querySelector(selector) { return this.all(selector)[0] ?? null; },
      querySelectorAll(selector) { return this.all(selector); },
      all(selector) { return this.children.flatMap((child) => [...(child.tag === selector ? [child] : []), ...(child.all?.(selector) ?? [])]); },
    };
    return node;
  };
  const places = [element("div"), element("div")];
  for (const place of places) place.hidden = true;
  const title = { dataset: { i18n: "home.title" }, textContent: es.home.title };
  const field = { dataset: { i18nAttr: "placeholder:entry.email_placeholder aria-label:entry.email" }, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  const url = new URL(address);
  const page = { store, places, title, field, root: { lang: "es" }, url, focused: null, replaced: [], listeners };
  const context = {
    LANGUAGES, language, languageFor, languageNamed, onLanguage, setLanguage, t,
    URL, URLSearchParams,
    location: { get href() { return url.href; }, get search() { return url.search; } },
    history: { state: { n: 1 }, replaceState(state, _, next) { page.replaced.push(String(next)); url.href = String(next); } },
    navigator: { languages: preferred },
    localStorage: storage
      ? { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) }
      : { getItem() { throw new Error("refused"); }, setItem() { throw new Error("refused"); } },
    document: {
      documentElement: page.root,
      get activeElement() { return page.focused; },
      createElement: element,
      addEventListener: (type, listener) => listeners[type].push(listener),
      querySelectorAll: (selector) =>
        selector === "[data-language]" ? places
          : selector === "[data-language] details" ? places.flatMap((place) => place.children)
          : selector === "[data-i18n]" ? [title]
          : selector === "[data-i18n-attr]" ? [field] : [],
    },
  };
  setLanguage("es");
  runInNewContext(picker.replace(/^import .*;\n/m, ""), context);
  page.pick = (code, place = 0) => places[place].children[0].all("button").find((button) => button.dataset.code === code).listeners.click();
  page.click = (target) => listeners.click.forEach((listener) => listener({ target }));
  return page;
}

test("a visit shows the address's language, else the kept one, else the browser's; the markup and the page's lang follow", () => {
  try {
    let page = load({ address: "https://aule.example/session/?lang=en", kept: "es", preferred: ["es-PE"] });
    assert.equal(language(), "en");
    assert.equal(page.root.lang, "en");
    assert.equal(page.title.textContent, LANGUAGES.en.home.title);
    assert.deepEqual(page.field.attributes, { placeholder: LANGUAGES.en.entry.email_placeholder, "aria-label": LANGUAGES.en.entry.email });
    // Arriving by a link stores nothing: the address still says it.
    assert.equal(page.store.get("aule.language"), "es");

    page = load({ kept: "en", preferred: ["es-PE"] });
    assert.equal(page.root.lang, "en");
    page = load({ preferred: ["en-US", "es"] });
    assert.equal(page.root.lang, "en");
    assert.equal(page.store.size, 0, "the browser's own language is not a choice to keep");
    page = load({ address: "https://aule.example/session/?lang=zz", preferred: ["fr"] });
    assert.equal(page.root.lang, "es");
    assert.equal(page.title.textContent, es.home.title);
    // A browser that keeps nothing still shows a language, and picking one still changes the page.
    page = load({ storage: false, preferred: ["en"] });
    assert.equal(page.root.lang, "en");
    page.pick("es");
    assert.equal(page.root.lang, "es");
  } finally {
    setLanguage("es");
  }
});

test("the picker lists each language by its own name, changes the page at once, keeps the choice and takes ?lang= out of the address", () => {
  try {
    const page = load({ address: "https://aule.example/session/01a215c0-9f37-718e-b5cf-bb3c99184cdd?src=cesar&lang=en#top", preferred: ["es"] });
    assert.equal(page.places.length, 2);
    for (const place of page.places) {
      assert.equal(place.hidden, false);
      const [details] = place.children;
      assert.equal(details.tag, "details");
      const [summary, list] = details.children;
      assert.equal(summary.tag, "summary");
      // Closed: «Language: » for a screen reader, then the language showing.
      assert.deepEqual(summary.children.map((child) => [child.className ?? "", child.textContent]), [["sr-only", "Language: "], ["", "English"]]);
      const buttons = list.all("button");
      assert.deepEqual(buttons.map((button) => [button.dataset.code, button.lang, button.textContent, button.type]), Object.entries(LANGUAGES).map(([code, words]) => [code, code, words.language.name, "button"]));
      assert.deepEqual(buttons.map((button) => button.attributes["aria-current"]), [undefined, "true"]);
    }
    assert.equal(page.store.size, 0);
    const [first, second] = page.places.map((place) => place.children[0]);
    first.open = true;
    page.pick("es");
    assert.equal(language(), "es");
    assert.equal(page.root.lang, "es");
    assert.equal(page.title.textContent, es.home.title);
    assert.equal(page.store.get("aule.language"), "es");
    // The address keeps everything but the language it asked for, and its history entry.
    assert.deepEqual(page.replaced, ["https://aule.example/session/01a215c0-9f37-718e-b5cf-bb3c99184cdd?src=cesar#top"]);
    assert.equal(first.open, false);
    assert.equal(page.focused, first.children[0], "the focus stays on the picker");
    // Both pickers say the language showing now.
    for (const details of [first, second]) {
      assert.deepEqual(details.children[0].children.map((child) => child.textContent), ["Idioma: ", "Español"]);
      assert.deepEqual(details.all("button").map((button) => button.attributes["aria-current"]), ["true", undefined]);
    }
    // Escape, or a press elsewhere, closes an open picker.
    second.open = true;
    page.listeners.keydown.forEach((listener) => listener({ key: "Escape" }));
    assert.equal(second.open, false);
    second.open = true;
    page.listeners.pointerdown.forEach((listener) => listener({ target: second.children[0] }));
    assert.equal(second.open, true);
    page.listeners.pointerdown.forEach((listener) => listener({ target: {} }));
    assert.equal(second.open, false);
  } finally {
    setLanguage("es");
  }
});

test("leaving to sign in with a provider keeps the language the address asked for, since the way back drops it", async () => {
  // GitHub, Apple and Facebook come back to the page's bare address, or with ?signin= alone.
  const server = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.match(server, /Location: `\$\{settings\.basePath\}\/\$\{outcome \? `\?signin=\$\{outcome\}` : ""\}`,/);
  const provider = { closest: (selector) => (selector === "a[data-provider][href]" ? {} : null) };
  const other = { closest: () => null };
  try {
    let page = load({ address: "https://aule.example/session/?lang=en", preferred: ["es"] });
    page.click(other);
    assert.equal(page.store.size, 0, "any other press keeps nothing");
    page.click(provider);
    assert.equal(page.store.get("aule.language"), "en");
    // Back at the bare address, the page shows it again.
    page = load({ kept: page.store.get("aule.language"), preferred: ["es"] });
    assert.equal(page.root.lang, "en");
    // With no language in the address, or one the page lacks, leaving keeps nothing.
    for (const address of ["https://aule.example/session/", "https://aule.example/session/?lang=zz"]) {
      page = load({ address, preferred: ["en"] });
      page.click(provider);
      assert.equal(page.store.size, 0, address);
    }
  } finally {
    setLanguage("es");
  }
  // And a failed sign-in's ?signin= is taken out of the address without taking a language with it.
  const signin = await read("signin.js");
  assert.match(signin, /address\.searchParams\.delete\("signin"\);\s*history\.replaceState\(null, "", `\$\{address\.pathname\}\$\{address\.search\}`\);/);
});
