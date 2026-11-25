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

test("the console has its pages and their scripts, and nothing else of the playground's", () => {
  assert.deepEqual(Object.keys(pages).sort(), ["families.html", "family.html", "index.html", "live.html", "passkeys.html", "signin.html"]);
  assert.deepEqual(Object.keys(scripts).sort(), [
    "admin.js", "common.js", "credential.js", "families.js", "family.js", "labels.js", "live.js", "passkeys.js", "pilot.js", "signin.js",
  ]);
  assert.deepEqual(files.sort(), [
    "admin.js", "common.js", "credential.js", "families.html", "families.js", "family.html", "family.js", "icon.svg", "index.html",
    "labels.js", "live.html", "live.js", "passkeys.html", "passkeys.js", "pilot.js", "signin.html", "signin.js", "style.css",
  ]);
});

// The pages a person moves between, in the header's order: [its address, its file, its link's words].
const NAVIGATION = [
  ["/", "index.html", "Resumen"],
  ["/live", "live.html", "En vivo"],
  ["/families", "families.html", "Familias"],
  ["/passkeys", "passkeys.html", "Passkeys"],
];
// A family's page has the same header, with no link of its own.
const HEADED = [...NAVIGATION.map(([, page]) => page), "family.html"];

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
  assert.match(pages["live.html"], /src="live\.js"/);
  assert.match(pages["families.html"], /src="families\.js"/);
  assert.match(pages["family.html"], /src="family\.js"/);
  assert.match(pages["passkeys.html"], /src="passkeys\.js"/);
  assert.match(pages["signin.html"], /src="signin\.js"/);
});

test("every reference is the console's own: no address of another site in a page, a script or the stylesheet", () => {
  for (const [name, text] of [...Object.entries(pages), ...Object.entries(scripts), ["style.css", css]]) {
    assert.doesNotMatch(text, /\b(https?:|wss?:)|\/\/[a-z0-9.-]+\.[a-z]{2,}/i, name);
    assert.doesNotMatch(text, /@import|fonts\.googleapis|fonts\.gstatic|googletagmanager|posthog|analytics/i, name);
  }
  const links = new Set(NAVIGATION.map(([address]) => address));
  for (const [name, html] of Object.entries(pages)) {
    for (const [, reference] of html.matchAll(/\b(?:href|src)="([^"]*)"/g)) {
      // A file of the page's own, or one of the console's pages by its fixed address.
      assert.ok(/^[a-z-]+\.(css|js|svg)$/.test(reference) || links.has(reference), `${name}: ${reference}`);
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
  assert.deepEqual([...new Set(moves)].sort(), ['location.replace("/")', 'location.replace("/signin")', "location.search"]);
  for (const [name, text] of Object.entries(scripts)) {
    assert.doesNotMatch(text, /location\.(hash|href|assign)|document\.referrer|window\.open|\.assign\(|pushState/, name);
  }
  // Only «Familias» and a family's page read their address: the filters and the family's id, each checked before use.
  for (const [name, text] of Object.entries(scripts)) {
    const reads = [...text.matchAll(/location\.search/g)].length;
    assert.equal(reads, name === "families.js" || name === "family.js" ? 1 : 0, name);
    if (reads) assert.match(text, /new URLSearchParams\(location\.search\)/, name);
  }
  assert.match(scripts["family.js"], /if \(!FAMILY_ID\.test\(id\)\) \{\s*say\("Esa familia no existe\."\);/);
  // «Familias» writes its filters into its own address, and nowhere else.
  const written = [...all.matchAll(/history\.replaceState\(([^;]*)\);/g)].map(([, args]) => args);
  assert.deepEqual(written, ['null, "", written ? `/families?${written}` : "/families"']);
  // A link goes to a family's page only, and only for a family's id.
  const hrefs = [...all.matchAll(/\.href = ([^;]*);/g)].map(([, value]) => value);
  assert.deepEqual(hrefs, ["`/family?id=${id}`"]);
  assert.match(scripts["common.js"], /if \(typeof id !== "string" \|\| !FAMILY_ID\.test\(id\)\) return document\.createTextNode\(text\);\s*const link = document\.createElement\("a"\);\s*link\.href = `\/family\?id=\$\{id\}`;/);
  // Signed out on any data call, a page goes to the sign-in; signed in, the sign-in goes to the overview.
  assert.match(scripts["common.js"], /if \(response\.status !== 401 && response\.status !== 403\) return false;\s*location\.replace\("\/signin"\);/);
  for (const name of ["admin.js", "live.js", "families.js", "family.js", "passkeys.js"]) {
    assert.doesNotMatch(scripts[name], /\bfetch\(/, `${name} asks the API only through common.js`);
  }
  assert.match(scripts["signin.js"], /if \(status === 200\) return location\.replace\("\/"\);/);
});

test("the scripts import each other as the pages draw them, and the sign-in stands alone", () => {
  const imports = (text) => [...text.matchAll(/\bfrom\s+"\.\/([\w-]+\.js)"/g)].map(([, dep]) => dep);
  assert.deepEqual(imports(scripts["admin.js"]), ["common.js", "pilot.js"]);
  for (const page of ["live.js", "families.js", "family.js"]) assert.deepEqual(imports(scripts[page]), ["common.js", "labels.js"], page);
  assert.deepEqual(imports(scripts["passkeys.js"]), ["common.js", "credential.js", "labels.js"]);
  for (const alone of ["common.js", "credential.js", "labels.js", "pilot.js", "signin.js"]) assert.deepEqual(imports(scripts[alone]), [], alone);
  // The words, the arithmetic and a passkey's JSON touch no page, so they are tested on their own.
  for (const pure of ["credential.js", "labels.js", "pilot.js"]) {
    assert.doesNotMatch(scripts[pure], /\bdocument\b|\blocation\b|\bfetch\b|\bwindow\b|\bnavigator\b/, pure);
  }
});

test("every element a script looks for is in its page", () => {
  for (const [script, page] of [
    ["admin.js", "index.html"],
    ["live.js", "live.html"],
    ["families.js", "families.html"],
    ["family.js", "family.html"],
    ["passkeys.js", "passkeys.html"],
    ["signin.js", "signin.html"],
    // What every page but the sign-in shares: the header's «Salir» and the message line.
    ...HEADED.map((page) => ["common.js", page]),
  ]) {
    const ids = new Set([...scripts[script].matchAll(/\$\("([\w-]+)"\)/g), ...scripts[script].matchAll(/id = "([\w-]+)"/g)].map(([, id]) => id));
    assert.ok(ids.size >= 2, script);
    for (const id of ids) assert.match(pages[page], new RegExp(`id="${id}"`), `${script} → ${page}#${id}`);
  }
});

test("every page but the sign-in has the same header, with its own link marked", () => {
  for (const page of HEADED) {
    const address = NAVIGATION.find(([, file]) => file === page)?.[0];
    const html = pages[page];
    assert.match(html, /<h1>Panel del equipo<\/h1>/, page);
    const nav = html.match(/<nav class="nav" aria-label="Consola del equipo">([\s\S]*?)<\/nav>/)?.[1] ?? "";
    const links = [...nav.matchAll(/<a href="([^"]+)"( aria-current="page")?>([^<]+)<\/a>/g)].map(([, href, current, words]) => [href, words, Boolean(current)]);
    assert.deepEqual(links, NAVIGATION.map(([href, , words]) => [href, words, href === address]), page);
    assert.match(nav, /<button type="button" class="link" id="signout">Salir<\/button>\s*$/, page);
  }
  assert.doesNotMatch(pages["signin.html"], /<nav\b|id="signout"/);
});

test("the overview is today's panel, moved as it was, with «Salir» where «Volver a Aule» was", () => {
  const html = pages["index.html"];
  assert.match(html, /<title>Aule · Panel del equipo<\/title>/);
  assert.match(html, /<h1>Panel del equipo<\/h1>/);
  assert.doesNotMatch(html, /Volver a Aule/);
  assert.match(html, /<button type="button" class="link" id="signout">Salir<\/button>/);
  for (const id of ["build", "message", "overview", "figures", "days", "pilot", "pilot-zone", "pilot-message", "pilot-figures", "weeks", "sources"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  for (const words of ["Últimos 14 días", "Piloto: las cuatro cifras", "Por enlace", "Activas en la 4.ª semana"]) {
    assert.ok(html.includes(words), words);
  }
  // The families moved to their own page; the overview counts them and links there.
  assert.doesNotMatch(html, /id="families"|id="filter"/);
  assert.match(html, /<p class="see"><a href="\/families">Ver las familias<\/a><\/p>/);
  assert.match(scripts["admin.js"], /get\("\/api\/families\?limit=1"\)/);
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

test("«Familias» and a family's page say what they are, in the panel's words", () => {
  const families = pages["families.html"];
  assert.match(families, /<input id="q" type="search" placeholder="Buscar por correo o nombre"[^>]* maxlength="100" \/>/);
  assert.match(families, /<option value="">Todos los enlaces<\/option>/);
  const plans = [...families.matchAll(/<option value="(\w*)">([^<]+)<\/option>/g)].map(([, value, words]) => [value, words]);
  assert.deepEqual(plans.slice(1), [
    ["", "Todos los planes"],
    ["trial", "Prueba"],
    ["paid", "Pagado"],
    ["granted", "Regalado"],
    ["none", "Sin plan"],
    ["team", "Equipo"],
    ["free", "Gratis ilimitado"],
  ]);
  const family = pages["family.html"];
  assert.match(family, /<a href="\/families">← Familias<\/a>/);
  for (const words of ["Adultos", "Alumnos", "Plan", "Sesiones", "Avisos", "Más sesiones", "Más avisos", "Regalar plan", "Quitar"]) {
    assert.ok(family.includes(words), words);
  }
  // A notice is listed by its kind and date: the page has no place for its words.
  assert.match(family, /Lo que se le envió a la familia: el tipo y cuándo, nunca el texto\./);
});

test("only «Passkeys» makes a passkey, with the browser's own dialog and nothing of another site", () => {
  const all = Object.values(scripts).join("\n");
  for (const [name, text] of Object.entries(scripts)) {
    const creates = [...text.matchAll(/navigator\.credentials\.create\(/g)].length;
    assert.equal(creates, name === "passkeys.js" ? 1 : 0, name);
  }
  assert.match(scripts["passkeys.js"], /navigator\.credentials\.create\(\{ publicKey: PublicKeyCredential\.parseCreationOptionsFromJSON\(publicKey\) \}\)/);
  // What it sends: the credential's JSON, by hand where a password manager's cannot write it.
  assert.match(scripts["passkeys.js"], /post\("\/api\/passkeys\/create", \{ label: name, credential: credentialJSON\(credential\) \}\)/);
  // The browser's own picker: never the address field's autofill, and no library.
  assert.doesNotMatch(all, /mediation|conditional/);
  // The ceremony stays in its HttpOnly cookie: no page script names it.
  assert.doesNotMatch(all, /ceremony/i);
  const page = pages["passkeys.html"];
  for (const words of [
    "Tus passkeys",
    "Crear passkey",
    "passkey (llave de acceso)",
    "Todavía no tienes passkeys.",
    "Este navegador no puede crear passkeys.",
    "Tienes 10 passkeys, el máximo.",
  ]) {
    assert.ok(page.includes(words), words);
  }
  // Before anyone tries, the page says a passkey wants a recent sign-in.
  assert.match(page, /Para crear una, tienes que haber entrado al panel en\s+los últimos 15 minutos\./);
  assert.match(page, /<input id="label" [^>]*maxlength="60"/);
  for (const words of ["Listo: ya puedes entrar con esta passkey.", "Ponle un nombre a la passkey.", "No se creó la passkey.", "Este dispositivo ya tiene una passkey tuya."]) {
    assert.ok(scripts["passkeys.js"].includes(words), words);
  }
});

test("only the sign-in signs in with a passkey, with the browser's own picker, and says so in the panel's words", () => {
  for (const [name, text] of Object.entries(scripts)) {
    const gets = [...text.matchAll(/navigator\.credentials\.get\(/g)].length;
    assert.equal(gets, name === "signin.js" ? 1 : 0, name);
  }
  assert.match(scripts["signin.js"], /navigator\.credentials\.get\(\{ publicKey: PublicKeyCredential\.parseRequestOptionsFromJSON\(publicKey\) \}\)/);
  assert.match(scripts["signin.js"], /if \(finished\.status === 200\) return location\.replace\("\/"\);/);
  // What it sends: the credential as the browser wrote it, and nothing else.
  assert.match(scripts["signin.js"], /post\("\/api\/signin\/passkey\/finish", \{ credential: credential\.toJSON\(\) \}\)/);
  assert.match(pages["signin.html"], /<div id="passkey-box" class="signin-passkey" hidden>\s*<button type="button" id="passkey">Entrar con passkey<\/button>/);
  for (const words of ["No pudimos confirmar esa passkey. Entra con tu correo.", "No se completó la passkey. Inténtalo otra vez o entra con tu correo."]) {
    assert.ok(scripts["signin.js"].includes(words), words);
  }
});
