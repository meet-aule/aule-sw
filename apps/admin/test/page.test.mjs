// The console's pages as files. How they look is checked in a browser; what
// they must never do (inline code, a script or a font from elsewhere, HTML
// from a string, a log line, a way to send someone to an address of the
// request's choosing) is checked here, for every page and every script.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

const pub = new URL("../public/", import.meta.url);
const files = await readdir(pub);
const read = (name) => readFile(new URL(name, pub), "utf8");
const pages = Object.fromEntries(await Promise.all(files.filter((name) => name.endsWith(".html")).map(async (name) => [name, await read(name)])));
const scripts = Object.fromEntries(await Promise.all(files.filter((name) => name.endsWith(".js")).map(async (name) => [name, await read(name)])));
const css = await read("style.css");

test("the console has its two pages and three scripts, and nothing else of the playground's", () => {
  assert.deepEqual(Object.keys(pages).sort(), ["index.html", "signin.html"]);
  assert.deepEqual(Object.keys(scripts).sort(), ["admin.js", "pilot.js", "signin.js"]);
  assert.deepEqual(files.sort(), ["admin.js", "icon.svg", "index.html", "pilot.js", "signin.html", "signin.js", "style.css"]);
});

test("no inline script, style or handler in any page, and exactly one module of its own", () => {
  for (const [name, html] of Object.entries(pages)) {
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, `${name}: inline script`);
    assert.doesNotMatch(html, /<style\b/, `${name}: style element`);
    assert.doesNotMatch(html, /\sstyle="/, `${name}: style attribute`);
    assert.doesNotMatch(html, /\son[a-z]+=/i, `${name}: inline handler`);
    assert.doesNotMatch(html, /<(base|iframe|object|embed|frame)\b/i, name);
    assert.doesNotMatch(html, /\saction=/, `${name}: a form goes nowhere`);
    const loaded = [...html.matchAll(/<script([^>]*)>/g)].map(([, attributes]) => attributes);
    assert.equal(loaded.length, 1, `${name}: one script`);
    assert.match(loaded[0], /^ type="module" src="[a-z-]+\.js"$/, `${name}: a module of its own, by a relative name`);
    assert.match(html, /<meta name="robots" content="noindex, nofollow" \/>/, `${name}: robots`);
    assert.match(html, /<html lang="es">/, name);
  }
  assert.match(pages["index.html"], /src="admin\.js"/);
  assert.match(pages["signin.html"], /src="signin\.js"/);
});

test("every reference is the console's own: no address of another site in a page, a script or the stylesheet", () => {
  for (const [name, text] of [...Object.entries(pages), ...Object.entries(scripts), ["style.css", css]]) {
    assert.doesNotMatch(text, /\b(https?:|wss?:)|\/\/[a-z0-9.-]+\.[a-z]{2,}/i, name);
    assert.doesNotMatch(text, /@import|fonts\.googleapis|fonts\.gstatic|googletagmanager|posthog|analytics/i, name);
  }
  for (const [name, html] of Object.entries(pages)) {
    for (const [, reference] of html.matchAll(/\b(?:href|src)="([^"]*)"/g)) {
      assert.match(reference, /^[a-z-]+\.(css|js|svg)$/, `${name}: ${reference}`);
    }
  }
  const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)/g)].map(([, url]) => url);
  assert.deepEqual(urls, ["fonts/serif.woff2", "fonts/sans.woff2"]);
});

test("no script makes HTML from a string, runs a string as code, or logs", () => {
  for (const [name, text] of Object.entries(scripts)) {
    for (const sink of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function\b/, /setTimeout\(\s*["'`]/, /createContextualFragment/, /DOMParser/]) {
      assert.doesNotMatch(text, sink, `${name}: ${sink}`);
    }
    assert.doesNotMatch(text, /\bconsole\./, `${name} logs`);
    // A value from the platform is drawn as text, and nothing sets a style from code.
    assert.doesNotMatch(text, /\.style\b|cssText|setAttribute\(\s*["'](style|on)/, name);
    assert.doesNotMatch(text, /localStorage|sessionStorage|document\.cookie|indexedDB/, `${name} keeps nothing in the browser`);
  }
});

test("a page sends people only to the console's fixed addresses, and never to one the request names", () => {
  const all = Object.values(scripts).join("\n");
  const moves = [...all.matchAll(/location\.(\w+)(\([^)]*\))?/g)].map(([whole]) => whole);
  assert.deepEqual([...new Set(moves)].sort(), ['location.replace("/")', 'location.replace("/signin")']);
  for (const [name, text] of Object.entries(scripts)) {
    assert.doesNotMatch(text, /location\.(search|hash|href)|document\.referrer|window\.open|URLSearchParams|\.assign\(/, name);
  }
  // Signed out on any data call, the panel goes to the sign-in; signed in, the sign-in goes to the panel.
  assert.match(scripts["admin.js"], /if \(response\.status !== 401 && response\.status !== 403\) return false;\s*location\.replace\("\/signin"\);/);
  assert.match(scripts["signin.js"], /if \(status === 200\) return location\.replace\("\/"\);/);
});

test("the scripts import each other as the panel draws them: the panel and its arithmetic, and the sign-in alone", () => {
  const imports = (text) => [...text.matchAll(/\bfrom\s+"\.\/([\w-]+\.js)"/g)].map(([, dep]) => dep);
  assert.deepEqual(imports(scripts["admin.js"]), ["pilot.js"]);
  assert.deepEqual(imports(scripts["pilot.js"]), []);
  assert.deepEqual(imports(scripts["signin.js"]), []);
});

test("every element a script looks for is in its page", () => {
  for (const [script, page] of [
    ["admin.js", "index.html"],
    ["signin.js", "signin.html"],
  ]) {
    const ids = new Set([...scripts[script].matchAll(/\$\("([\w-]+)"\)/g)].map(([, id]) => id));
    assert.ok(ids.size > 3, script);
    for (const id of ids) assert.match(pages[page], new RegExp(`id="${id}"`), `${script} → ${page}#${id}`);
  }
});

test("the overview is today's panel, moved as it was, with «Salir» where «Volver a Aule» was", () => {
  const html = pages["index.html"];
  assert.match(html, /<title>Aule · Panel del equipo<\/title>/);
  assert.match(html, /<h1>Panel del equipo<\/h1>/);
  assert.doesNotMatch(html, /Volver a Aule/);
  assert.match(html, /<button type="button" class="link" id="signout">Salir<\/button>/);
  for (const id of ["build", "message", "overview", "figures", "days", "pilot", "pilot-zone", "pilot-message", "pilot-figures", "weeks", "sources", "families-section", "filter", "families"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  for (const words of ["Últimos 14 días", "Piloto: las cuatro cifras", "Por enlace", "Familias", "Buscar por nombre, correo o enlace", "Activas en la 4.ª semana"]) {
    assert.ok(html.includes(words), words);
  }
  // The meta tags are stamped by the server (src/build.ts).
  assert.match(html, /<meta name="aule-version" content="\{\{version\}\}" \/>/);
  assert.match(html, /<meta name="aule-commit" content="\{\{commit\}\}" \/>/);
});

test("the sign-in says the same thing whatever address is typed, in the panel's words", () => {
  const text = pages["signin.html"] + scripts["signin.js"];
  for (const words of [
    "Si es un correo del equipo, te enviamos un código. Vale 10 minutos.",
    "El código no es correcto o ya venció.",
    "Demasiados intentos. Espera unos minutos.",
  ]) {
    assert.ok(text.includes(words), words);
  }
  assert.match(pages["signin.html"], /<input id="code" [^>]*autocomplete="one-time-code"/);
  assert.match(pages["signin.html"], /<input id="email" [^>]*type="email"/);
  // The address and the code are sent, and nothing else: never a name or a link.
  assert.match(scripts["signin.js"], /post\("\/api\/signin\/start", \{ email: typed \}\)/);
  assert.match(scripts["signin.js"], /post\("\/api\/signin\/verify", \{ email, code \}\)/);
});

test("the stylesheet carries the panel's look on the playground's paper, with only the upright fonts", () => {
  for (const rule of [".admin {", ".admin .figures {", ".admin table.pilot th,", ".build {", ".message {", "[hidden] {", ":focus-visible {"]) {
    assert.ok(css.includes(rule), rule);
  }
  assert.doesNotMatch(css, /font-style: italic/);
  assert.match(css, /--bg: #f5f2ea;/);
  assert.match(css, /--sans: "Inter"/);
});
