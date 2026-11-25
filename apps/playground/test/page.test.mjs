// The page as files: what it looks like is checked in a browser, but what it
// must never do again (an Andean layer, a font from elsewhere, a log line, a
// module cycle, motion for those who asked for less) is checked here.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

const pub = new URL("../public/", import.meta.url);
const files = await readdir(pub);
const read = (name) => readFile(new URL(name, pub), "utf8");
const html = await read("index.html");
const css = await read("style.css");
const guides = { es: await read("guia.html"), en: await read("guide.html") };
const ownScripts = ["app.js", "students.js", "signin.js", "steps.js", "screens.js", "onboarding.js", "home.js", "session-messages.js", "first-steps.js", "visuals.js", "admin.js", "pilot.js"];
const scripts = Object.fromEntries(await Promise.all(ownScripts.map(async (name) => [name, await read(name)])));

/** The body of every block that starts with `opening`, braces and all. */
function blocks(text, opening) {
  const found = [];
  for (let at = text.indexOf(opening); at !== -1; at = text.indexOf(opening, at + 1)) {
    const start = text.indexOf("{", at);
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth += 1;
      if (text[i] === "}" && --depth === 0) {
        found.push(text.slice(start + 1, i));
        break;
      }
    }
  }
  return found;
}

test("the Andean layer is gone, and the favicon and touch icons stay", () => {
  for (const gone of ["wall.png", "motifs.png", "dancers.png", "manta.png", "frame.png"]) {
    assert.ok(!files.includes(gone), `${gone} is deleted`);
    assert.ok(!html.includes(gone) && !css.includes(gone), `${gone} is named nowhere`);
  }
  for (const trace of ["border-image", "--iron", "--parchment", ".dancers", "@keyframes jig", "pixelated", "signin-mascot"]) {
    assert.ok(!css.includes(trace), trace);
  }
  assert.ok(!/class="dancers"|signin-tabs|signin-mascot/.test(html));
  assert.match(html, /<link rel="icon" href="icon\.svg"/);
  assert.match(html, /<link rel="apple-touch-icon" href="apple-touch-icon\.png"/);
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest"/);
  for (const icon of ["icon.svg", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png"]) {
    assert.ok(files.includes(icon), icon);
  }
});

test("the page's fonts are its own: Inter and Source Serif 4 from fonts/, nothing from elsewhere", () => {
  const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)/g)].map(([, url]) => url);
  assert.ok(urls.length > 0);
  for (const url of urls) assert.ok(url.startsWith("data:") || url.startsWith("#") || /^[\w./-]+$/.test(url), url);
  const faces = blocks(css, "@font-face");
  const face = (family, file) => faces.some((body) => body.includes(`font-family: "${family}"`) && body.includes(`url("fonts/${file}")`));
  assert.ok(face("Inter", "sans.woff2"));
  assert.ok(face("Inter", "sans-italic.woff2"));
  assert.ok(face("Source Serif 4", "serif.woff2"));
  assert.ok(face("Source Serif 4", "serif-italic.woff2"));
  assert.doesNotMatch(html + css, /fonts\.googleapis|fonts\.gstatic|fonts\.bunny/);
  assert.match(css, /--sans: "Inter"/);
});

test("motion stops for those who ask for less: the screens change without moving", () => {
  const reduced = blocks(css, "@media (prefers-reduced-motion: reduce)").join("\n");
  assert.match(reduced, /\.screen\.arrive/);
  assert.match(reduced, /\.screen\.return/);
  assert.match(reduced, /animation: none/);
  assert.match(reduced, /\.orb/, "the tutor's dot stays still too, as before");
  // A05's bar and the talk button's change without easing, and the coach line appears at once.
  for (const [selector, what] of [
    [/\.level span/, "transition: none"],
    [/\.talk-level span/, "transition: none"],
    [/\.talk-coach/, "animation: none"],
  ]) {
    const rule = [...reduced.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, found]) => selector.test(found));
    assert.ok(rule, String(selector));
    assert.match(rule[2], new RegExp(what), String(selector));
  }
});

test("the page's scripts log nothing", () => {
  for (const [name, text] of Object.entries(scripts)) assert.doesNotMatch(text, /\bconsole\./, name);
});

test("no inline script and no style attribute in the page, so the policy stays strict", () => {
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
  assert.doesNotMatch(html, /\sstyle="/);
  assert.doesNotMatch(html, /\son[a-z]+="/, "no inline handlers");
  const loaded = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map(([, src]) => src);
  assert.deepEqual(loaded, ["signin.js", "onboarding.js", "home.js", "livekit-client.js", "wobnimo.js", "app.js"]);
});

test("the page's own modules import each other without a cycle, as the plan draws them", () => {
  const graph = Object.fromEntries(
    Object.entries(scripts).map(([name, text]) => [name, [...text.matchAll(/\bfrom\s+"\.\/([\w-]+\.js)"/g)].map(([, dep]) => dep)]),
  );
  assert.deepEqual(graph["screens.js"], ["steps.js"]);
  assert.deepEqual(graph["steps.js"], []);
  assert.deepEqual(graph["students.js"], []);
  assert.deepEqual(graph["session-messages.js"], []);
  // The first steps' words lean on the session's languages, and nothing else.
  assert.deepEqual(graph["first-steps.js"], ["session-messages.js"]);
  for (const name of ["signin.js", "onboarding.js"]) {
    assert.deepEqual([...graph[name]].sort(), ["screens.js", "steps.js", "students.js"], name);
  }
  assert.deepEqual([...graph["home.js"]].sort(), ["first-steps.js", "screens.js", "steps.js", "students.js"]);
  assert.deepEqual([...graph["app.js"]].sort(), ["first-steps.js", "home.js", "screens.js", "session-messages.js", "visuals.js"]);
  // And none, followed through, comes back to itself.
  const visiting = new Set();
  const done = new Set();
  const walk = (name, path) => {
    assert.ok(!visiting.has(name), `a cycle: ${[...path, name].join(" → ")}`);
    if (done.has(name)) return;
    visiting.add(name);
    for (const dep of graph[name] ?? []) walk(dep, [...path, name]);
    visiting.delete(name);
    done.add(name);
  };
  for (const name of Object.keys(graph)) walk(name, []);
});

test("only signin.js touches the browser's storage, and only where a refusal is caught", () => {
  for (const [name, text] of Object.entries(scripts)) {
    if (name !== "signin.js") assert.doesNotMatch(text, /localStorage|sessionStorage/, name);
  }
  const signin = scripts["signin.js"];
  // The two stores are named once each, and read, written and cleared in one place each.
  assert.equal(signin.match(/localStorage|sessionStorage/g).length, 2);
  for (const use of [/\.getItem\(/g, /\.setItem\(/g, /\.removeItem\(/g]) assert.equal(signin.match(use).length, 1, String(use));
  assert.match(signin, /try \{\s*return store\(\)\.getItem\(key\);\s*\} catch/);
  assert.match(signin, /try \{\s*store\(\)\.setItem\(key, value\);\s*\} catch/);
  assert.match(signin, /try \{\s*store\(\)\.removeItem\(key\);\s*\} catch/);
});

test("Google's sign-in script is fetched only where a guardian signs in, never with the page or its landing", () => {
  // Not preloaded and not loaded by the page: a student's session never asks Google for anything.
  assert.doesNotMatch(html, /accounts\.google\.com|gsi\/client/);
  for (const [name, text] of Object.entries(scripts)) {
    if (name !== "signin.js") assert.doesNotMatch(text, /accounts\.google\.com/, name);
  }
  const signin = scripts["signin.js"];
  // One function fetches it, and nothing at the top of the module does.
  assert.equal(signin.match(/\bloadGoogleScript\(\)/g).length, 2, "its definition and one call");
  assert.match(blocks(signin, "function needGoogle()")[0], /\bloadGoogleScript\(\)/);
  // That function is called where a guardian signs in only: P01 and P13. Not on C01, the
  // landing: a visit that only looks at the first question asks Google for nothing.
  const asked = (text) => (text.match(/\bneedGoogle\b/g) ?? []).length;
  const guardian = asked(blocks(signin, 'onShow("p01"')[0]) + asked(blocks(signin, 'onShow("p13"')[0]);
  assert.equal(guardian, 2);
  assert.equal(asked(signin), guardian + 1, "the definition and those two, nothing else");
  assert.doesNotMatch(signin, /onShow\("c01"/);
  // And it does nothing for a family that is already signed in.
  assert.match(blocks(signin, "function needGoogle()")[0], /account\.signed_in/);
});

/** Every innermost rule of a stylesheet: [what comes before its brace, its body]. */
const rules = (text) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => [selector.trim(), body]);

test("what is kept about a child is the parent's to choose: both choices show before «Autorizo», and neither is ticked for them (D5)", () => {
  const panel = html.match(/<div class="keep-panel" id="keep-panel"[^>]*>/)?.[0];
  assert.ok(panel, "P04 has the panel");
  assert.doesNotMatch(panel, /\bhidden\b/, "the panel shows from the start");
  assert.match(html, /id="keep-toggle"[^>]*aria-expanded="true"/);
  const box = (id) => html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0] ?? "";
  // Remembering between sessions and the written conversation both start unticked, on P04 as in the
  // editor: consent is the parent's own tick (Ley 29733, DS 016-2024-JUS), never one made for them.
  for (const id of ["keep-memory", "keep-transcripts", "student-remembers", "student-transcripts"]) {
    assert.match(box(id), /type="checkbox"/, id);
    assert.doesNotMatch(box(id), /\bchecked\b/, `${id} is not ticked by default`);
  }
  // The parent's own consent is never ticked for them.
  assert.match(box("consent"), /type="checkbox"/, "P04's box");
  assert.doesNotMatch(box("consent"), /\bchecked\b/, "P04's box is not ticked by default");
  assert.ok(html.indexOf('id="keep-panel"') < html.indexOf('id="consent-ok"'), "the choices come before «Autorizo»");
  // And the onboarding sets them back to those defaults, and open, each time it starts again;
  // the editor shows a choice ticked only where the family made it.
  assert.match(scripts["onboarding.js"], /const DEFAULTS = \{ remembers: false, keepsTranscripts: false \};/);
  assert.match(scripts["students.js"], /\$\("student-remembers"\)\.checked = student\.remembers === true;/);
  assert.match(scripts["onboarding.js"], /\$\("keep-panel"\)\.hidden = false;/);
});

test("a field's error is announced as it shows, also when the form is sent from the field itself", () => {
  const errors = [...html.matchAll(/<p class="field-error"[^>]*>/g)].map(([tag]) => tag);
  assert.ok(errors.length >= 3);
  for (const tag of errors) assert.match(tag, /role="alert"/, tag);
});

test("focus on paper is a solid copper outline, which forced colours keep", () => {
  assert.match(css, /--focus: #9a5b2e;/, "solid: at 40 % the ring is 1.73:1 on the paper");
  for (const [selector, body] of rules(css)) {
    if (selector.includes(":focus-visible")) assert.doesNotMatch(body, /outline: none/, selector);
  }
  assert.doesNotMatch(css, /box-shadow: 0 0 0 3px/, "no ring drawn as a shadow");
});

test("A04 · Detalles' day keeps the black ring on its calendar button, where the field is only :focus-within", () => {
  const ring = rules(css).find(([selector]) => selector.includes('.ink-field input[type="date"]:focus-within'));
  assert.ok(ring, "the date field has a :focus-within ring");
  assert.match(ring[1], /outline: 3px solid var\(--device-ink\)/);
});

test("a toggle that is off is drawn as a control, not as a disabled button", () => {
  for (const [selector, body] of rules(css)) {
    if (selector.includes('[aria-pressed="false"]')) assert.doesNotMatch(body, /dashed/, selector);
  }
  assert.match(css, /\.compact:disabled \{\s*border-style: dashed;/);
});

test("A05 ignores taps for longer than the other student screens, so a late tap cannot start a session", () => {
  const settle = Number(scripts["screens.js"].match(/const SETTLE_MS = \{ a05: (\d+) \}/)?.[1]);
  assert.ok(settle >= 1000, `A05 waits ${settle} ms`);
});

test("a control reached by Tab is scrolled clear of the cookie notice", () => {
  const [, root] = rules(css).find(([selector]) => selector.endsWith("html")) ?? [];
  assert.match(root ?? "", /scroll-padding-bottom: var\(--notice-room\)/);
});

/** The body of `function name(…)` in a script, past its parameters, which may hold braces of their own. */
function bodyOf(text, name) {
  const start = text.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name}`);
  let i = text.indexOf("(", start);
  for (let depth = 0; i < text.length; i++) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")" && --depth === 0) break;
  }
  return blocks(text.slice(i), "{")[0];
}

test("a session started from an A05 reached past A04 is asked what it is for on A04 before api/session is (D22)", () => {
  // After a reload, a student whose session is still open comes to A05 past A04. Carrying that
  // session on keeps its purpose; starting another, or one from an A05 whose session closed
  // meanwhile, has none yet, so A04 asks it first, in A05's place.
  const app = scripts["app.js"];
  const start = bodyOf(app, "startSession");
  const asks = start.indexOf('if (!purposeAsked()) return go("a04", { replace: true });');
  assert.notEqual(asks, -1, "a start with no purpose goes to A04");
  assert.ok(start.indexOf("showRecoverable(null);") < asks, "after the open session is closed");
  assert.ok(asks < start.indexOf('fetch("api/session"'), "before api/session is asked for a session");
  // A tile («No lo sé» among them) is an answer; a platform that keeps no subjects asks nothing.
  assert.match(scripts["home.js"], /export function purposeAsked\(\) \{\s*return kind !== undefined \|\| subjectsKept\(\) === null;\s*\}/);
  // «Seguir con la sesión» carries the session on with its own purpose: A04 is not asked again.
  const [resume] = blocks(app, '$("resume").addEventListener("click"');
  assert.doesNotMatch(resume, /purposeAsked|"a04"/);
});

test("a session's words go with it: the conversation, the card and anything half typed are emptied when it ends and on signing out", () => {
  const app = scripts["app.js"];
  const forget = bodyOf(app, "forgetWords");
  assert.match(forget, /\$\("transcript"\)\.replaceChildren\(\);/);
  assert.match(forget, /lines\.clear\(\);/);
  assert.match(forget, /heldLines = \[\];/);
  assert.match(forget, /\$\("route"\)\.replaceChildren\(\);/);
  assert.match(forget, /for \(const id of \["card-title", "card-statement", "card-help"\]\) \$\(id\)\.textContent = "";/);
  // Every field the session has is emptied, so one added later is too or this fails.
  const session = html.slice(html.indexOf('data-screen="session"'), html.indexOf('data-screen="session-end"'));
  const fields = [...session.matchAll(/<(?:input|textarea)\b[^>]*\bid="([^"]+)"/g)].map(([, id]) => id).sort();
  assert.deepEqual(fields, ["answer-text", "explanation-text", "typed"]);
  assert.match(forget, /for \(const id of \["typed", "answer-text", "explanation-text"\]\) \$\(id\)\.value = "";/);
  // Every way a session ends closes it through teardown(), and signing out forgets too,
  // with what A04 · Detalles held (its subject is the child's default one).
  assert.match(bodyOf(app, "teardown"), /\bforgetWords\(\);/);
  assert.match(blocks(app, "onAccount((account) =>").join("\n"), /\bforgetWords\(\);/);
  const signedOut = blocks(scripts["home.js"], "onAccount((account) =>").join("\n");
  for (const clear of ['$("subject").replaceChildren();', '$("topic").value = "";', '$("due").value = "";']) assert.ok(signedOut.includes(clear), clear);
  // An answer or a message still on its way when the session ends is not written back after it.
  const [answer] = blocks(app, '$("answer").addEventListener("submit"');
  const answerGuard = answer.indexOf("if (id !== sessionId) return;");
  assert.ok(answerGuard !== -1 && answerGuard < answer.indexOf('$("transcript").append('));
  const [typed] = blocks(app, '$("type").addEventListener("submit"');
  const typedGuard = typed.indexOf("if (sending !== room) return;");
  assert.ok(typedGuard !== -1 && typedGuard < typed.indexOf('$("transcript").append('));
});

test("A05's web-only state names itself to a screen reader: its status line is in the tree before its words, and its title takes the focus again", () => {
  const note = html.match(/<p[^>]*\bid="recovery-note"[^>]*>/)?.[0] ?? "";
  assert.match(note, /role="status"/);
  assert.doesNotMatch(note, /\bhidden\b/, "never hidden, only empty");
  assert.doesNotMatch(scripts["app.js"], /\$\("recovery-note"\)\.hidden/);
  const [, empty] = rules(css).find(([selector]) => selector.endsWith("#recovery-note:empty")) ?? [];
  assert.match(empty ?? "", /position: absolute;/, "empty, it takes no room");
  assert.doesNotMatch(empty ?? "", /display: none|visibility: hidden/, "and stays in the tree");
  // The title has the focus from when A05 showed, as «Antes de empezar»: once the state is drawn
  // it is focused again, so its new name is read.
  const offer = bodyOf(scripts["app.js"], "offerRecovery");
  const drawn = offer.indexOf("showRecoverable(answer);");
  assert.ok(drawn !== -1 && offer.indexOf("document.activeElement === title") < drawn);
  assert.ok(drawn < offer.indexOf("title.blur();") && offer.indexOf("title.blur();") < offer.indexOf("title.focus({ preventScroll: true });"));
});

test("the words of session-messages.js are marked with the language they are in where they are written (WCAG 3.1.2)", () => {
  const app = scripts["app.js"];
  // Only through write(), which marks the element; never straight into textContent.
  assert.doesNotMatch(app, /textContent = [^;\n]*\b(?:recoveryText|recoveryMessage|endedMessage)\(/);
  assert.match(bodyOf(app, "write"), /element\.textContent = text;\s*element\.lang = languageOf\(language\);/);
  // The end screen's title, line and button in one language: the platform's for the session when it said one.
  const ended = bodyOf(app, "tellEnded");
  for (const id of ["ended-title", "ended-text", "ended-resume"]) assert.ok(ended.includes(`write($("${id}")`), id);
  assert.match(app, /const language = answer\.language \?\? sessionRequest\(\)\?\.language;/);
  assert.match(app, /const language = session\.language \?\? sessionRequest\(\)\?\.language;/);
  // On the shared message line, in a span of their own that goes as soon as anything else writes the line.
  assert.match(bodyOf(app, "showMessage"), /write\(words, text, language\);\s*message\.replaceChildren\(words\);/);
});

test("the family guide is a page of its own, in Spanish and in English, with the same parts and links", () => {
  const ids = (page) => [...page.matchAll(/<section id="([^"]+)"/g)].map(([, id]) => id);
  assert.deepEqual(ids(guides.es), ["entrar", "prueba", "sesion", "plan", "seguir", "privacidad"]);
  assert.equal(ids(guides.en).length, ids(guides.es).length);
  const links = (page) => [...page.matchAll(/href="([^"]+)"/g)].map(([, href]) => href).filter((href) => !/^(guia|guide)$/.test(href));
  assert.deepEqual(links(guides.en), links(guides.es), "the same links, in the same order");
  for (const [lang, page] of Object.entries(guides)) {
    assert.match(page, new RegExp(`<html lang="${lang}"`), lang);
    assert.match(page, /<link rel="stylesheet" href="style\.css" \/>/, lang);
    // Nothing the policy would refuse: no script at all, no style attribute, no handler.
    assert.doesNotMatch(page, /<script\b/, lang);
    assert.doesNotMatch(page, /\sstyle="|\son[a-z]+="/, lang);
    assert.match(page, /href="https:\/\/meetaule\.com\/legal\/privacy"/, `${lang} links the privacy policy`);
    assert.match(page, /href="mailto:admin@meetaule\.com"/, lang);
    assert.match(page, /class="primary" href="\.\/"/, `${lang} leads into Aule`);
  }
  assert.match(guides.es, /href="guide" hreflang="en"/);
  assert.match(guides.en, /href="guia" hreflang="es"/);
});

test("every «…» a guide quotes is the page's own words, and the English guide marks them as Spanish", () => {
  // A guide that sends parents to a button the page no longer has (C00's «Soy padre de familia»,
  // retired on 24 Nov) fails here.
  const page = [html, ...Object.values(scripts)].join("\n");
  for (const [lang, guide] of Object.entries(guides)) {
    const visible = guide.replace(/<!--[\s\S]*?-->/g, "");
    const quoted = [...visible.matchAll(/«([^«»]+)»/g)].map(([, words]) => words);
    assert.ok(quoted.length >= 6, lang);
    for (const words of quoted) assert.ok(page.includes(words), `${lang}: «${words}» is on the page`);
  }
  for (const words of ["¿Ya tienes una cuenta en Aule?", "No, es mi primera vez", "¡Qué bueno que estés de vuelta!", "Sí, ya tengo cuenta"]) {
    assert.ok(guides.es.includes(`«${words}»`) && guides.en.includes(`<span lang="es">«${words}»</span>`), words);
  }
  const english = guides.en.replace(/<!--[\s\S]*?-->/g, "").replace(/<span lang="es">«[^«»]+»<\/span>/g, "");
  assert.doesNotMatch(english, /«/, "each Spanish quote of the English guide is marked lang=es");
  // The browser asks for the camera only when it is turned on (D12).
  assert.doesNotMatch(guides.es, /permiso para usar el micrófono y la cámara/);
  assert.doesNotMatch(guides.en, /asks to use the microphone and the camera/);
});

test("the guide says the plan in the landing's words, and the child's needs", () => {
  const text = (page) => page.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const es = text(guides.es);
  for (const words of [
    "El plan Aule",
    "S/59 al mes",
    "3 sesiones cada 7 días",
    "7 días gratis desde la primera sesión, una sesión al día, sin tarjeta",
    "escríbenos a admin@meetaule.com y te activamos el plan",
    "Todavía no se puede pagar desde la app",
    "Un lugar tranquilo",
    "Audífonos, si quieres: son opcionales",
  ]) {
    assert.ok(es.includes(words), words);
  }
  const en = text(guides.en);
  for (const words of ["The Aule plan", "S/59 a month", "3 sessions in any 7 days", "7 days free from the first session", "admin@meetaule.com", "A quiet place", "Headphones, if you like"]) {
    assert.ok(en.includes(words), words);
  }
  // Privacy says what Aule itself does with the audio and the video; the
  // services it uses are the policy's to describe, so nothing absolute.
  assert.ok(es.includes("y no guarda el audio ni el video de la sesión"));
  assert.ok(en.includes("and doesn't store the session's audio or video"));
  assert.doesNotMatch(es + en, /nunca se guarda|never stored|are never/);
  // Privacy in two sentences, with the policy linked from the second.
  for (const [lang, page] of Object.entries(guides)) {
    const privacy = page.match(/<section id="(?:privacidad|privacy)"[\s\S]*?<p>([\s\S]*?)<\/p>/)?.[1] ?? "";
    assert.equal(text(privacy).trim().split(/[.;:]\s+(?=[A-ZÁÉÍÓÚ])/).length, 2, lang);
    assert.match(privacy, /legal\/privacy/, lang);
  }
});

test("the page's words for an ended trial and a used week are the plan's, and the cookie notice names the link's cookie", () => {
  const app = scripts["app.js"];
  assert.match(app, /trial_over: "Tu prueba gratis de 7 días terminó\. Para seguir, escríbenos a admin@meetaule\.com y te activamos el plan Aule\."/);
  assert.match(app, /week_used: "Ya usaste las sesiones del plan Aule de estos 7 días\./);
  assert.doesNotMatch(app + scripts["steps.js"], /Suscríbete|suscribirte|por semana/);
  const notice = html.match(/<div id="cookies"[\s\S]*?<\/div>/)?.[0] ?? "";
  const said = notice.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ");
  // Only the necessary ones, which is why «Entendido» is the one answer (the policy rests storage
  // without consent on «estrictamente necesario»); the link's cookie only for whoever came by an
  // invitation, and how long it lasts; none for advertising; the policy's own section.
  assert.match(said, /Solo cookies propias y necesarias/);
  assert.match(said, /si te invitaron, tu enlace hasta que entres/);
  assert.match(said, /nada de publicidad/);
  assert.match(notice, /<a href="https:\/\/meetaule\.com\/legal\/privacy#cookies">Política de cookies<\/a>/);
  // The sign-in providers' own cookies are said beside their buttons, not here (D36).
  assert.doesNotMatch(said, /Google|GitHub|Facebook|Apple/);
  for (const [id, next] of [
    ["p01", "p02"],
    ["p13", "p14"],
  ]) {
    const screen = html.slice(html.indexOf(`data-screen="${id}"`), html.indexOf(`data-screen="${next}"`));
    const line = screen.match(/<p class="small-help ways-note"[^>]*>([^<]*)<\/p>/);
    assert.ok(line, `${id} has the providers' line`);
    assert.equal(line[1], "Google, GitHub, Facebook y Apple usan sus propias cookies cuando entras con ellos.", id);
    assert.ok(screen.indexOf("ways-note") > screen.indexOf('class="other-ways"'), `${id}: after the ways in`);
  }
  // It shows wherever Google or another provider is offered, and only there.
  assert.match(bodyOf(scripts["signin.js"], "showWays"), /for \(const note of document\.querySelectorAll\("\.ways-note"\)\) note\.hidden = !google && others\.length === 0;/);
});

test("the cookie notice is a slim bar along the bottom edge on a phone and a short screen, and a card from 481 px", () => {
  // A short screen (a phone on its side, 800 × 480) gets the bar too: under the card's inset the
  // footer's first line showed, cut by the bottom of the screen.
  const phone = blocks(css, "@media (max-width: 480px), (max-height: 600px)").join("\n");
  const [, bar] = rules(phone).find(([selector]) => selector === ".cookie-notice") ?? [];
  assert.ok(bar, "a phone's rule for the notice");
  for (const declaration of ["bottom: 0;", "left: 0;", "right: 0;", "border-radius: 0;", "flex-wrap: nowrap;", "border-width: 1.5px 0 0;"]) {
    assert.ok(bar.includes(declaration), declaration);
  }
  assert.match(bar, /padding: 8px 10px calc\(8px \+ env\(safe-area-inset-bottom\)\);/);
  // «Entendido» keeps its 44 px (D21); the words take what is left beside it.
  const [, words] = rules(phone).find(([selector]) => selector === ".cookie-notice p") ?? [];
  assert.match(words ?? "", /min-width: 0;/);
  assert.doesNotMatch(phone, /min-height/);
  // From 481 px, the card: the rule at the top level of the sheet.
  const card = css.match(/\n\.cookie-notice \{([^}]*)\}/)?.[1] ?? "";
  assert.match(card, /max-width: 880px;/);
  assert.match(card, /border-radius: var\(--radius\);/);
  // Not drawn on a student's screen, and the room it takes is measured: from just above its top
  // edge down, the card's inset included, so the footer after a paper screen starts behind it
  // instead of across its edge (the old card's fixed 32 px left the phone's bar cutting a line).
  assert.match(css, /html\[data-surface="ink"\] \.cookie-notice \{\s*display: none;/);
  const room = bodyOf(scripts["signin.js"], "noticeRoom");
  assert.match(room, /--notice-room/);
  assert.match(room, /const below = parseFloat\(getComputedStyle\(notice\)\.bottom\) \|\| 0;/);
  assert.match(room, /Math\.round\(notice\.getBoundingClientRect\(\)\.height \+ below\) \+ NOTICE_CLEAR_PX/);
  assert.doesNotMatch(room, /\+ 32/);
  const clear = Number(scripts["signin.js"].match(/const NOTICE_CLEAR_PX = (\d+);/)?.[1]);
  assert.ok(clear >= 5 && clear < 24, "clear of a 3 px ring 2 px out, and under the footer's 24 px");
});

test("A05 asks for the microphone alone; the camera is asked for when it is turned on, and a session never turns it on as it joins (D12)", () => {
  const app = scripts["app.js"];
  const asks = [...app.matchAll(/getUserMedia\(\{([\s\S]*?)\}\)/g)].map(([, constraints]) => constraints);
  assert.equal(asks.length, 2, "the microphone, and the camera when it is turned on");
  const microphone = bodyOf(app, "askMicrophone");
  assert.match(microphone, /getUserMedia\(\{\s*audio:/);
  assert.doesNotMatch(microphone, /video/);
  assert.doesNotMatch(bodyOf(app, "openLobby"), /getUserMedia/);
  const [camera] = blocks(app, '$("lobby-cam").addEventListener("click"');
  assert.match(camera, /getUserMedia\(\{ video:/);
  // Both start as A05 shows them: the microphone on, the camera off.
  assert.match(app, /const wanted = \{ mic: true, cam: false \};/);
  assert.match(bodyOf(app, "openLobby"), /wanted\.cam = false;/);
  assert.match(html.match(/<button[^>]*id="lobby-cam"[^>]*>/)?.[0] ?? "", /aria-pressed="false"/);
  // The camera goes on only where the child asks for it: «Mostrar mi tarea» (showWork) and,
  // with a tutor that takes no pictures, the session's «Cámara». Nothing else turns it on:
  // not join(), nor the tutor coming in or saying how it works, since the tutor says it takes
  // pictures only at the end of its start-up (apps/agent worker.py), and until then every
  // tutor looks like one that takes none (the review of 24 Nov saw the camera sent then).
  const turnsOn = (text) => [...text.matchAll(/setCameraEnabled\(([^)]*)\)/g)].filter(([, on]) => on.trim() !== "false").length;
  const [toggle] = blocks(app, '$("cam").addEventListener("click"');
  assert.equal(turnsOn(bodyOf(app, "showWork")), 1, "«Mostrar mi tarea»");
  assert.equal(turnsOn(toggle), 1, "the session's «Cámara»");
  assert.equal(turnsOn(app), 2, "and nowhere else");
  for (const name of ["join", "watchTutor", "usePhotos", "tutorArrived", "showCamera"]) assert.equal(turnsOn(bodyOf(app, name)), 0, name);
  assert.doesNotMatch(bodyOf(app, "usePhotos") + bodyOf(app, "watchTutor"), /wanted\.cam/, "A05's camera is a preview, not a wish the session acts on");
  assert.match(bodyOf(app, "showCamera"), /\$\("cam"\)\.disabled = !tutorCame;/, "no camera for a room the tutor has not reached");
  assert.match(bodyOf(app, "tutorArrived"), /if \(room\) showCamera\(\);/, "and «Cámara» can be pressed once it has");
});

test("the microphone check stays on the device: a meter never reaches the speakers, and no voice is synthesised, recognised or recorded", () => {
  for (const [name, text] of Object.entries(scripts)) {
    assert.doesNotMatch(text, /speechSynthesis|SpeechSynthesisUtterance|SpeechRecognition|MediaRecorder/, name);
  }
  const app = scripts["app.js"];
  const meter = bodyOf(app, "startMeter");
  assert.match(meter, /createMediaStreamSource\(stream\)\.connect\(analyser\);/);
  assert.doesNotMatch(meter, /destination|connect\(context/, "the analyser goes nowhere");
  // Only the join chime's synth reaches the speakers.
  assert.equal(app.match(/\.destination\b/g).length, 1);
  assert.match(bodyOf(app, "readySounds"), /\.connect\(sounds\.destination\)/);
  // What runs on A05 sends nothing: no request, no message, no data.
  for (const name of ["askMicrophone", "onLobbyLevel", "showCheck", "startMeter", "showPreview", "openLobby"]) {
    assert.doesNotMatch(bodyOf(app, name), /fetch\(|sendText|performRpc|publishData|sendBeacon|WebSocket/, name);
  }
  // The talk button's bar is the same meter, on the session's own track.
  assert.match(bodyOf(app, "startTalkMeter"), /startMeter\(new MediaStream\(\[track\]\), \$\("talk-bar"\)/);
});

test("a microphone A05 cannot use is said in words, asked for again, and never drawn as on (Pendiente 260:716)", () => {
  const app = scripts["app.js"];
  // The status line is in the tree before its words: never hidden, only empty.
  const status = html.match(/<p[^>]*\bid="check-status"[^>]*>/)?.[0] ?? "";
  assert.match(status, /role="status"/);
  assert.doesNotMatch(status, /\bhidden\b/);
  assert.match(html, /<div id="level" class="level" aria-hidden="true">/);
  assert.match(html, /<wobnimo-mascot id="check-face"[^>]*aria-hidden="true"/);
  // The cause, from the browser's error; the button cannot be pressed and is not drawn as on.
  assert.match(bodyOf(app, "askMicrophone"), /trouble = micProblem\(error\?\.name\);/);
  const preview = bodyOf(app, "showPreview");
  assert.match(preview, /setRound\(\$\("lobby-mic"\), wanted\.mic && !micTrouble\);/);
  assert.match(preview, /\$\("lobby-mic"\)\.disabled = Boolean\(micTrouble\);/);
  assert.match(preview, /writeWords\(\$\("lobby-mic-text"\), "mic_unavailable"\);/);
  const [press] = blocks(app, '$("lobby-mic").addEventListener("click"');
  assert.match(press, /^\s*if \(micTrouble\) return;/);
  assert.match(css, /\.round-toggle:disabled \{\s*border-style: dashed;/);
  // «Intentar otra vez» goes once the microphone works; its focus goes to A05's title, not to the page.
  assert.match(bodyOf(app, "showCheck"), /if \(!retry\) hideKeepingFocus\(\$\("mic-retry"\), \$\("a05-title"\)\);/);
  assert.match(bodyOf(app, "hideKeepingFocus"), /if \(document\.activeElement === button\) title\.focus\(\{ preventScroll: true \}\);\s*button\.hidden = true;/);
  // «Intentar otra vez», coming back to the tab, and the browser allowing it ask again.
  assert.match(app, /\$\("mic-retry"\)\.addEventListener\("click", \(\) => askMicrophone\(\)\);/);
  assert.match(blocks(app, 'document.addEventListener("visibilitychange"')[0], /askAgain\(\)/);
  assert.match(app, /try \{\s*navigator\.permissions\s*\?\.query\(\{ name: "microphone" \}\)/);
  // The check never holds back «Empezar la sesión»: only a microphone that answered does.
  assert.match(bodyOf(app, "askMicrophone"), /for \(const id of \["join", "resume", "restart"\]\) \$\(id\)\.disabled = !mediaReady;/);
  assert.doesNotMatch(bodyOf(app, "showCheck") + bodyOf(app, "onLobbyLevel"), /disabled/);
});

test("the sound test plays the chime Aule joins with, and the chime cannot pass the check for the child", () => {
  const app = scripts["app.js"];
  const [sound] = blocks(app, '$("sound-test").addEventListener("click"');
  assert.match(sound, /play\(hello\);/);
  assert.match(sound, /check\.quietUntil = now \+ HELLO_MS \+ AFTER_CHIME_MS;/);
  assert.match(app, /const AFTER_CHIME_MS = 300;/);
  assert.match(bodyOf(app, "onLobbyLevel"), /const counted = wanted\.mic && now >= check\.quietUntil \? level : 0;/);
});

test("the talk button keeps its label in a span of its own, next to its bar, and its coach is a status above it", () => {
  const talk = html.match(/<button[^>]*id="talk"[\s\S]*?<\/button>/)?.[0] ?? "";
  assert.match(talk, /<span id="talk-label">Mantén apretado para hablar<\/span>/);
  assert.match(talk, /<span class="talk-level" aria-hidden="true"><span id="talk-bar"><\/span><\/span>/);
  const coach = html.match(/<p[^>]*\bid="talk-coach"[^>]*>/)?.[0] ?? "";
  assert.match(coach, /role="status"/);
  assert.doesNotMatch(coach, /\bhidden\b/, "never hidden, only empty");
  assert.ok(html.indexOf('id="talk-coach"') < html.indexOf('id="talk"'), "right above the button");
  const app = scripts["app.js"];
  assert.doesNotMatch(app, /\$\("talk"\)\.textContent/, "the label is written into its span, so the bar stays");
  // In the student's language, like the coach above it.
  assert.match(bodyOf(app, "showTalk"), /writeWords\(\$\("talk-label"\), !wanted\.mic \? "talk_off" : talking \? "talk_listening" : touchOnly \? "talk_hold" : "talk_hold_key"\);/);
  // Over the page, above the fixed button, only on a tall screen: on a short one (a phone on
  // its side, 800 × 480) it would cover «Terminar», «Mostrar mi tarea» and «Modo tinta».
  const fixedCoach = [...css.matchAll(/@media ([^{]+)\{((?:[^{}]*\{[^{}]*\})+)\s*\}/g)]
    .filter(([, query, body]) => /\.talk-coach/.test(body) && /position: fixed/.test(body))
    .map(([, query]) => query.trim());
  assert.deepEqual(fixedCoach, ["(max-width: 900px) and (min-height: 640px)"]);
  assert.match(css, /@media \(max-width: 900px\) and \(max-height: 639px\) \{\s*main\.push-to-talk \.work:not\(\.with-card\) > \.tile \{\s*max-height: 28vh;/);
  // A tap is looked at once it is let go, and only a real end of a turn is.
  assert.match(bodyOf(app, "stopTalking"), /if \(method === "end_turn"\) coachAfter\(performance\.now\(\) - heldAt, talkVoice\);/);
  assert.match(app, /const TAP_HINTS = 3;/);
  // The coach shows only with held turns, a tutor ready and a microphone on.
  assert.match(bodyOf(app, "showCoach"), /manualTurns && tutorReady && wanted\.mic/);
  // On a first run only, never after a reload carried a session on.
  assert.match(bodyOf(app, "join"), /firstSession = !resumed && firstRun\(\);\s*coaching = firstSession;/);
});

test("when Aule does not arrive the page says so and offers to try again; a session it never came to says it does not count", () => {
  const app = scripts["app.js"];
  assert.match(bodyOf(app, "finishSession"), /tutorCame \? endedMessage\("child_ended", sessionRequest\(\)\?\.language\) : recoveryText\("no_tutor"\)/);
  const missing = bodyOf(app, "tutorMissing");
  assert.match(missing, /tutorLate = true;\s*setTutorState\("missing"\);\s*showIntro\(\);/);
  assert.match(missing, /\$\("retry-session"\)\.hidden = false;/);
  // Said once, politely: in the status line under A15's title, which A16's words leave for it,
  // and not on the alert line; the tile shows its short line without saying it again.
  assert.doesNotMatch(missing, /showMessage/);
  const intro = bodyOf(app, "showIntro");
  assert.match(intro, /if \(tutorLate\) \{\s*write\(\$\("session-title"\), SESSION_TITLE, "es"\);\s*write\(\$\("session-intro"\), recoveryText\("tutor_missing"\)\);/);
  assert.ok(intro.indexOf("tutorLate") < intro.indexOf("firstSession"), "Aule not arriving comes before A16's words");
  const line = html.match(/<p[^>]*\bid="session-intro"[^>]*>/)?.[0] ?? "";
  assert.match(line, /role="status"/);
  assert.doesNotMatch(line, /\bhidden\b/, "never hidden, only empty");
  assert.doesNotMatch(app, /\$\("session-intro"\)\.hidden/);
  const [, empty] = rules(css).find(([selector]) => selector === ".session-intro:empty") ?? [];
  assert.match(empty ?? "", /position: absolute;/);
  const tile = bodyOf(app, "setTutorState");
  assert.match(tile, /line\.setAttribute\("aria-live", "off"\);\s*write\(line, recoveryText\("tutor_missing_short"\)\);/);
  assert.match(tile, /line\.removeAttribute\("aria-live"\);/);
  // The clock shows once the tutor is in; a tutor who comes late clears the offer.
  assert.match(html, /<span id="clock" class="clock" aria-label="Tiempo que queda" hidden><\/span>/);
  const arrived = bodyOf(app, "tutorArrived");
  assert.match(arrived, /\$\("clock"\)\.hidden = false;/);
  assert.match(arrived, /hideKeepingFocus\(\$\("retry-session"\), \$\("session-title"\)\);/);
  assert.match(arrived, /if \(tutorLate\) \{\s*tutorLate = false;\s*showIntro\(\);\s*\}/, "A16's words come back with Aule");
  // «Intentar otra vez» closes the attempt with the platform, without the goodbye, and goes back to A05.
  const [retry] = blocks(app, '$("retry-session").addEventListener("click"');
  assert.match(retry, /teardown\(\{ quiet: true \}\)/);
  assert.match(retry, /ending = sessionAction\("end", \{ session_id: id \}\)/);
  assert.match(retry, /back\(\);/);
  assert.match(bodyOf(app, "teardown"), /if \(!quiet\) play\(goodbye\);/);
  // A new session waits for that close, since the platform starts no other until then,
  // and A05 does not offer to carry on the attempt while it closes.
  assert.match(app, /const closing = \(\) => Promise\.race\(\[ending, /);
  const start = bodyOf(app, "startSession");
  const waits = start.indexOf("await closing();");
  assert.ok(waits !== -1 && waits < start.indexOf('fetch("api/session"'));
  // A close that takes a moment is not a silent wait: A05's status line says «Un momento…».
  assert.match(start, /setTimeout\(\(\) => write\(note, recoveryText\("checking_title"\)\), CLOSING_NOTE_MS\);\s*await closing\(\);\s*clearTimeout\(waiting\);/);
  const offer = bodyOf(app, "offerRecovery");
  assert.ok(offer.indexOf("await closing();") !== -1 && offer.indexOf("await closing();") < offer.indexOf('fetch("api/session/recovery")'));
});

test("the home reads the family's account again each time it shows", () => {
  const home = scripts["home.js"];
  assert.match(blocks(home, 'onShow("home"')[0], /\breadAgain\(\);/);
  const again = bodyOf(home, "readAgain");
  assert.match(again, /await call\("api\/account"\)/);
  assert.match(again, /if \(current\(\) !== "home" \|\| getAccount\(\)\.signed_in !== true\) return;/);
  assert.match(again, /"Tu sesión se cerró\. Vuelve a entrar\."/);
  // A failed read keeps what is drawn.
  assert.match(again, /catch \{\s*return;\s*\}/);
});

test("a signed-out visit starts on C01, or on P13 for a browser that signed in before; C00 is gone", () => {
  const signin = scripts["signin.js"];
  assert.match(bodyOf(signin, "firstScreen"), /return land === "c01" && recall\(local, RETURNING\) === "1" \? "p13" : land;/);
  for (const name of ["start", "signedOut"]) assert.match(bodyOf(signin, name), /const first = firstScreen\(\);\s*go\(first,/, name);
  assert.match(bodyOf(scripts["screens.js"], "landing"), /"c01" : null/);
  for (const [name, text] of Object.entries(scripts)) assert.doesNotMatch(text, /"c00/, name);
  assert.doesNotMatch(html, /data-screen="c00|id="c00-/);
  // C01 is the first question: it has no way back (Encabezado/Base · Atrás=No).
  const c01 = html.slice(html.indexOf('data-screen="c01"'), html.indexOf('data-screen="p01"'));
  assert.doesNotMatch(c01, /data-back/);
});

test("a02 hands the browser to the child: first-steps.js's words in the child's language, the name as the parent wrote it", () => {
  const home = scripts["home.js"];
  const a02 = html.slice(html.indexOf('data-screen="a02"'), html.indexOf('data-screen="a04"'));
  assert.match(a02, /aria-labelledby="a02-title a02-name"/);
  for (const id of ["a02-yes", "a02-no", "a02-back"]) assert.match(a02, new RegExp(`<button type="button"[^>]*id="${id}"`), id);
  const [shown] = blocks(home, 'onShow("a02"');
  assert.match(shown, /const language = languageOf\(student\.language\);/);
  for (const [id, key] of [
    ["a02-lead", "handoff_lead"],
    ["a02-title", "handoff_title"],
    ["a02-yes", "handoff_yes"],
    ["a02-no", "handoff_no"],
    ["a02-back", "back"],
  ]) {
    assert.ok(shown.includes(`writeWords($("${id}"), "${key}", language`), id);
  }
  assert.match(bodyOf(home, "writeWords"), /element\.lang = language;/);
  // P12's button opens it; «Sí, soy yo» is a first run, «No soy yo» opens Configurar.
  assert.match(blocks(home, '$("done-start").addEventListener("click"')[0], /go\("a02"\)/);
  assert.match(blocks(home, '$("a02-yes").addEventListener("click"')[0], /confirmed = true;\s*study\(student\.id\);/);
  assert.match(blocks(home, '$("a02-no").addEventListener("click"')[0], /edit\(student, true\)/);
  // First run is page memory: what a02 confirmed, or a trial that has not started; the home and signing out forget it.
  assert.match(bodyOf(home, "firstRun"), /return confirmed \|\| \(plan\?\.plan === "trial" && !plan\.ends_at\);/);
  assert.match(blocks(home, 'onShow("home"')[0], /confirmed = false;/);
  assert.match(blocks(home, "onAccount((account) =>").join("\n"), /confirmed = false;[\s\S]*\$\("a02-name"\)\.textContent = "";/);
});

test("each new state of the first steps names where it comes from in the Figma, or says it is web-only", () => {
  const a05 = html.slice(html.indexOf('data-screen="a05"'), html.indexOf('data-screen="session"'));
  assert.match(a05, /Pendiente · Sesión del alumno 260:654 \(the bar and its line\), 260:716 \(blocked\)/);
  assert.match(a05, /web-only state of A05 \(190:899\): the check/);
  assert.match(a05, /web-only state of A05: the sound test, a device link \(195:513\)/);
  const session = html.slice(html.indexOf('data-screen="session"'), html.indexOf('data-screen="session-end"'));
  assert.match(session, /A16 Hola, soy Aule 477:190 \(Vigente · Onboarding · v1\), first run/);
  assert.match(session, /web-only state of the session: Aule did not arrive/);
  assert.match(session, /web-only state of the talk button/);
  for (const component of ["Botón/Compacto 191:1396", "Cuadro/Opción 190:806"]) assert.ok(html.includes(component), component);
});
