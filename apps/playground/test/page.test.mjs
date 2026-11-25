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
const ownScripts = ["app.js", "students.js", "signin.js", "steps.js", "screens.js", "onboarding.js", "home.js", "session-messages.js", "first-steps.js", "summaries.js", "visuals.js", "cuy.js", "pixels.js"];
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
  for (const trace of ["border-image", "--iron", "--parchment", ".dancers", "@keyframes jig", "signin-mascot"]) {
    assert.ok(!css.includes(trace), trace);
  }
  // Pixels are back in one place only: Aule's face (face.test.mjs).
  assert.equal(css.split("pixelated").length - 1, 1);
  assert.match(css, /\.face-box\.pixels > wobnimo-mascot \{[^}]*image-rendering: pixelated;/);
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
  // The home's lines about a student's sessions are pure words and arithmetic.
  assert.deepEqual(graph["summaries.js"], []);
  assert.deepEqual([...graph["signin.js"]].sort(), ["screens.js", "steps.js", "students.js"]);
  // The name screen hands the browser to the child as the home does (home.js handOff).
  assert.deepEqual([...graph["onboarding.js"]].sort(), ["home.js", "screens.js", "steps.js", "students.js"]);
  assert.deepEqual([...graph["home.js"]].sort(), ["first-steps.js", "screens.js", "steps.js", "students.js", "summaries.js"]);
  // Aule's face, the cuy and its pixels, is data and arithmetic: the session's page is all that takes them.
  assert.deepEqual(graph["cuy.js"], []);
  assert.deepEqual(graph["pixels.js"], []);
  assert.deepEqual([...graph["app.js"]].sort(), ["cuy.js", "first-steps.js", "home.js", "pixels.js", "screens.js", "session-messages.js", "visuals.js"]);
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
  // The camera goes on only where the child asks for it: «Mostrar mi tarea» (aimCamera) and,
  // with a tutor that takes no pictures, the session's «Cámara». Nothing else turns it on:
  // not join(), nor the tutor coming in or saying how it works, since the tutor says it takes
  // pictures only at the end of its start-up (apps/agent worker.py), and until then every
  // tutor looks like one that takes none (the review of 24 Nov saw the camera sent then).
  // «Mostrar mi tarea» asks for a camera of this device only; «Listo» (showWork) publishes
  // that same one and asks for no other (D31).
  const turnsOn = (text) =>
    [...text.matchAll(/setCameraEnabled\(([^)]*)\)/g)].filter(([, on]) => on.trim() !== "false").length +
    (text.match(/\bcreateLocalVideoTrack\(/g) ?? []).length;
  const [toggle] = blocks(app, '$("cam").addEventListener("click"');
  assert.equal(turnsOn(bodyOf(app, "aimCamera")), 1, "«Mostrar mi tarea»");
  assert.equal(turnsOn(toggle), 1, "the session's «Cámara»");
  assert.equal(turnsOn(app), 2, "and nowhere else");
  for (const name of ["join", "watchTutor", "usePhotos", "tutorArrived", "showCamera", "showWork", "stopAiming"]) {
    assert.equal(turnsOn(bodyOf(app, name)), 0, name);
  }
  // Only «Listo» publishes, and what it publishes is the camera the child pointed.
  assert.equal((app.match(/\.publishTrack\(/g) ?? []).length, 1);
  assert.match(bodyOf(app, "showWork"), /const track = aimTrack;[\s\S]*\.publishTrack\(track, \{ source: Track\.Source\.Camera \}\)/);
  assert.doesNotMatch(bodyOf(app, "aimCamera"), /publishTrack|setCameraEnabled/);
  // The click turns it on, and only the click: «Mostrar mi tarea» is the one caller of aimCamera.
  assert.equal((app.match(/\baimCamera\(\)/g) ?? []).length, 2, "its definition and the click");
  assert.match(toggle, /if \(photos\) return aimCamera\(\);/);
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
  // Over the page, right above the fixed button, wherever the button is fixed: in the page, a
  // small phone's coach went behind the button (375 × 548, the review of 24 Nov). Never on a
  // short screen from 560 px (a phone on its side, 800 × 480), where nothing is fixed.
  const media = [...css.matchAll(/@media ([^{]+)\{((?:[^{}]*\{[^{}]*\})+)\s*\}/g)].map(([, query, body]) => [query.trim(), body]);
  const fixedCoach = media.filter(([, body]) => /\.talk-coach/.test(body) && /position: fixed/.test(body)).map(([query]) => query);
  assert.deepEqual(fixedCoach, ["(max-width: 900px) and (min-height: 640px), (max-width: 559px)"]);
  // On a short screen from 560 px the session is two columns and nothing in it is fixed: the
  // talk button sits in the right-hand column, and the stage's actions are on the first screen.
  const short = media.filter(([query]) => query === "(min-width: 560px) and (max-width: 900px) and (max-height: 639px)");
  assert.equal(short.length, 1);
  assert.match(short[0][1], /grid-template-columns: minmax\(0, 1fr\) minmax\(250px, 300px\);/);
  assert.doesNotMatch(short[0][1], /position: fixed/);
  // The talk button is fixed at the bottom only with one column.
  const fixedTalk = media.filter(([, body]) => /main\.push-to-talk \.talk \{[^}]*position: fixed/.test(body)).map(([query]) => query);
  assert.deepEqual(fixedTalk, ["(max-width: 900px) and (min-height: 640px), (max-width: 559px)"]);
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
  // The title says Aule could not make it, not that the session started; the line under it
  // says whose fault it is not, and nothing says it twice (the review of 24 Nov).
  assert.match(intro, /if \(tutorLate\) \{\s*write\(\$\("session-title"\), recoveryText\("missing_title"\)\);\s*write\(\$\("session-intro"\), recoveryText\("tutor_missing"\)\);/);
  assert.match(missing, /const focused = document\.activeElement === title;[\s\S]*showIntro\(\);\s*if \(focused\) \{\s*title\.blur\(\);\s*title\.focus\(\{ preventScroll: true \}\);/, "a screen reader on the title hears the new one");
  assert.ok(intro.indexOf("tutorLate") < intro.indexOf("firstSession"), "Aule not arriving comes before A16's words");
  const line = html.match(/<p[^>]*\bid="session-intro"[^>]*>/)?.[0] ?? "";
  assert.match(line, /role="status"/);
  assert.doesNotMatch(line, /\bhidden\b/, "never hidden, only empty");
  assert.doesNotMatch(app, /\$\("session-intro"\)\.hidden/);
  const [, empty] = rules(css).find(([selector]) => selector === ".session-intro:empty") ?? [];
  assert.match(empty ?? "", /position: absolute;/);
  const tile = bodyOf(app, "setTutorState");
  assert.match(tile, /line\.setAttribute\("aria-live", "off"\);\s*write\(line, ""\);/, "the sad face's line says nothing more");
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
  assert.match(blocks(home, 'onShow("home"')[0], /\breadAgain\(\)\.then\(/);
  const again = bodyOf(home, "readAgain");
  assert.match(again, /await call\("api\/account"\)/);
  assert.match(again, /if \(current\(\) !== "home" \|\| getAccount\(\)\.signed_in !== true\) return false;/);
  assert.match(again, /"Tu sesión se cerró\. Vuelve a entrar\."/);
  // A failed read keeps what is drawn.
  assert.match(again, /catch \{\s*return current\(\) === "home" && getAccount\(\)\.signed_in === true;\s*\}/);
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
  // The name screen's «Empezar su primera sesión» opens it, in the place of the steps that made the
  // child; «Sí, soy yo» is a first run, «No soy yo» opens Configurar.
  assert.doesNotMatch(home + html, /done-start/);
  assert.match(bodyOf(home, "handOff"), /handoff = id;\s*if \(!handoffStudent\(\)\) return false;\s*go\("a02", \{ replace: true, fresh: true \}\);/);
  assert.match(blocks(home, '$("a02-yes").addEventListener("click"')[0], /confirmed = true;\s*study\(student\.id\);/);
  assert.match(blocks(home, '$("a02-no").addEventListener("click"')[0], /edit\(student, true\)/);
  // First run is page memory: what a02 confirmed, or a trial that has not started; the home and signing out forget it.
  assert.match(bodyOf(home, "firstRun"), /return confirmed \|\| \(plan\?\.plan === "trial" && !plan\.ends_at\);/);
  assert.match(blocks(home, 'onShow("home"')[0], /confirmed = false;/);
  assert.match(blocks(home, "onAccount((account) =>").join("\n"), /confirmed = false;[\s\S]*\$\("a02-name"\)\.textContent = "";/);
});

test("a child's screen says one short sentence an element, and what only an adult can fix has a line of its own (D33)", () => {
  const a05 = html.slice(html.indexOf('data-screen="a05"'), html.indexOf('<section class="screen" data-screen="session"'));
  assert.doesNotMatch(html, /Si el botón es de color/);
  assert.match(a05, /<p class="ink-text" id="a05-text"><\/p>/, "A05's line is written from first-steps.js");
  // The round buttons say what they are, by first-steps.js's keys.
  for (const [id, on, off] of [
    ["lobby-mic-text", "mic_on", "mic_off"],
    ["lobby-cam-text", "cam_on", "cam_off"],
    ["mic-text", "mic_on", "mic_off"],
  ]) {
    assert.match(html, new RegExp(`id="${id}" data-on="${on}" data-off="${off}"`), id);
  }
  assert.match(bodyOf(scripts["app.js"], "setRound"), /writeWords\(says, on \? says\.dataset\.on : says\.dataset\.off\);/);
  // The adult's line sits under the child's status line, and is not a live region: the line above is.
  const help = a05.match(/<p[^>]*\bid="check-help"[^>]*>/)?.[0] ?? "";
  assert.match(help, /class="device-note check-help"/);
  assert.doesNotMatch(help, /role=|aria-live/);
  assert.ok(a05.indexOf('id="check-status"') < a05.indexOf('id="check-help"') && a05.indexOf('id="check-help"') < a05.indexOf('id="mic-retry"'));
  assert.match(bodyOf(scripts["app.js"], "showCheck"), /writeWords\(\$\("check-help"\), micTrouble \? `\$\{micTrouble\}_help` : ""\);/);
  // A04's title is César's question again, with the greeting over it; A04 · Detalles' note and the card's are one sentence.
  assert.match(html, /<p class="ink-text" id="a04-hello"><\/p>\s*<h2 class="ink-title" id="a04-title" tabindex="-1">¿Qué hacemos hoy\?<\/h2>/);
  assert.match(html, /id="subject-note" hidden>Aquí Aule te ayuda con lo que traigas\.<\/p>/);
  assert.match(html, /<p class="note">También puedes decirlo o mostrar tu cuaderno\.<\/p>/);
});

test("A04, A04 · Detalles and A05 speak the student's language, marked on each element, as a02 does", () => {
  const home = scripts["home.js"];
  assert.match(home, /const chosenLanguage = \(\) => languageOf\(chosen\?\.language\);/);
  const [a04] = blocks(home, 'onShow("a04"');
  for (const [id, key] of [
    ["a04-hello", '"a04_hello"'],
    ["a04-title", '"a04_title"'],
    ["kind-review", "REVIEW.key"],
    ["a04-back", '"back"'],
  ]) {
    assert.ok(a04.includes(`writeWords($("${id}"), ${key}, language`), id);
  }
  assert.match(a04, /writeWords\(\$\("a04-hello"\), "a04_hello", language, \{ name: chosen\.name \}\);/);
  assert.match(a04, /writeWords\(button\.querySelector\("\.choice-words"\), kindKey\(button\.dataset\.kind\), language\);/);
  const [details] = blocks(home, 'onShow("a04-details"');
  for (const id of ["a04-details-title", "a04-details-back", "a04-details-line", "subject-note", "details-next"]) {
    assert.ok(details.includes(`writeWords($("${id}"), `), id);
  }
  for (const id of ["subject-label", "due-label", "topic-label"]) assert.ok(details.includes(`fieldLabel($("${id}"), `), id);
  assert.match(details, /new Option\(words\(`subject_\$\{subject\}`, language\), subject\)/);
  assert.match(details, /\$\("subject"\)\.lang = language;/);
  assert.match(details, /\$\("topic"\)\.lang = language;/);
  assert.match(bodyOf(home, "fieldLabel"), /label\.lang = language;/);
  assert.match(bodyOf(home, "writeWords"), /element\.lang = language;/);
  // A05: its title and line, its buttons' names and «Volver».
  const app = scripts["app.js"];
  assert.match(bodyOf(app, "showRecoverable"), /else writeWords\(\$\("a05-title"\), "a05_title"\);/);
  const lobby = bodyOf(app, "openLobby");
  for (const write of ['writeWords($("a05-text"), "a05_line");', 'nameRound($("lobby-mic"), "mic_label");', 'nameRound($("lobby-cam"), "cam_label");', 'writeWords($("lobby-back"), "back");']) {
    assert.ok(lobby.includes(write), write);
  }
  assert.match(bodyOf(app, "nameRound"), /button\.setAttribute\("aria-label", words\(key, language\)\);\s*button\.lang = language;/);
  assert.doesNotMatch(app, /A05_TITLE/);
  // Signed out, A04's greeting, which names the child, goes.
  assert.match(blocks(home, "onAccount((account) =>").join("\n"), /\$\("a04-hello"\)\.textContent = "";/);
});

test("the home says what each child did in their latest sessions, facts only, and links the summaries in Configurar (D35)", () => {
  const home = scripts["home.js"];
  // Asked for each student together, once the account is read again and the rows drawn for it (a
  // session just changed it, so the rows are drawn twice), and drawn only while that row still shows.
  assert.doesNotMatch(bodyOf(home, "drawHome"), /drawSessions/);
  assert.match(blocks(home, 'onShow("home"')[0], /readAgain\(\)\.then\(\(home\) => \{\s*if \(home\) drawSessions\(\);\s*\}\);/);
  assert.equal((home.match(/\bdrawSessions\(\)/g) ?? []).length, 2, "its definition and that one call");
  const draw = bodyOf(home, "drawSessions");
  assert.match(draw, /call\("api\/student\/sessions", \{ student_id: item\.dataset\.student \}\)/);
  assert.match(draw, /if \(current\(\) !== "home" \|\| !item\.isConnected\) return;/);
  assert.match(draw, /sessionLine\(facts, \{ language \}\)/);
  // A failed read leaves the row as it is.
  assert.match(draw, /\(\) => undefined,\s*\);/);
  // Text only: nothing the platform sent becomes markup.
  assert.doesNotMatch(draw, /innerHTML/);
  // The list and the link are the row's own, hidden until there is a session to show.
  const row = bodyOf(home, "row");
  assert.match(row, /sessions\.className = "student-sessions";/);
  assert.match(row, /sessions\.setAttribute\("aria-label", homeWords\("list", language, \{ name: student\.name \}\)\);/);
  assert.match(row, /summaries\.className = "link student-summaries";/);
  assert.match(row, /summaries\.addEventListener\("click", \(\) => edit\(student, false, "past"\)\);/);
  // «Ver resúmenes» shows once the review has a summary to open on, not with the first line: right
  // after a session it has none, and the editor would open on another section (the review of 24 Nov).
  assert.match(draw, /item\.querySelector\("\.student-summaries"\)\.hidden = !\(answer\.summaries > 0\);/);
  // Its name starts with its visible words (WCAG 2.5.3), and it is a whole 44 px target.
  assert.match(row, /summaries\.setAttribute\("aria-label", homeWords\("see_summaries_of", language, \{ name: student\.name \}\)\);/);
  assert.match(rules(css).find(([selector]) => selector.replace(/\/\*[\s\S]*?\*\//g, "").trim() === ".student-summaries")?.[1] ?? "", /min-height: 44px;/);
  // «Ver resúmenes» opens Configurar at «Últimas sesiones», where the review's words already were.
  assert.match(bodyOf(home, "edit"), /\}, \{ at \}\);/);
  const known = bodyOf(scripts["students.js"], "showKnown");
  assert.match(known, /if \(at === "past"\) \{\s*const heading = known\.sessions\.length \? \$\("past-title"\) : \$\("known-title"\);/);
  assert.match(html, /<h3 id="past-title" tabindex="-1" hidden>Últimas sesiones<\/h3>/);
  // The home itself never shows a review's words, a topic or what was said.
  for (const text of [home, scripts["summaries.js"]]) assert.doesNotMatch(text, /guardian_summary|next_step|\.summary\b|\.topic\b|transcript/);
  assert.match(html, /web-only and built from it, ul\.student-sessions/);
});

test("A16's second line shows on a first run, now that the home says what each session was", () => {
  const intro = bodyOf(scripts["app.js"], "showIntro");
  assert.match(intro, /writeWords\(\$\("session-parent"\), firstSession && !tutorLate \? "intro_parent" : ""\);/);
  const line = html.match(/<p[^>]*\bid="session-parent"[^>]*>/)?.[0] ?? "";
  assert.match(line, /class="session-intro"/);
  assert.doesNotMatch(line, /role=|aria-live/, "not live: the line above is");
  assert.ok(html.indexOf('id="session-intro"') < html.indexOf('id="session-parent"'));
});

test("consent leads to the name, which starts the first session: P12 is folded in, and the grade is the one thing asked with it (D34)", () => {
  const onboarding = scripts["onboarding.js"];
  // «Autorizo» goes to the name; the interview's answers are no longer held from P04.
  const [consent] = blocks(onboarding, '$("consent-form").addEventListener("submit"');
  assert.match(consent, /held = \{ remembers: \$\("keep-memory"\)\.checked, keepsTranscripts: \$\("keep-transcripts"\)\.checked \};\s*go\("p10-name"\);/);
  assert.doesNotMatch(html, /data-screen="p12"|id="p12-/);
  // Two ways out of the name: the first session (handed to the child) only from «Empezar su
  // primera sesión», and only while the plan has a session; else the home says the child is made.
  const name = html.slice(html.indexOf('data-screen="p10-name"'), html.indexOf('data-screen="p13"'));
  assert.match(name, /<button type="submit" class="link" id="child-later">Empezar más tarde<\/button>\s*<button type="submit" class="primary" id="child-start">Empezar su primera sesión<\/button>/);
  const [submit] = blocks(onboarding, '$("child-name-form").addEventListener("submit"');
  assert.match(submit, /const starting = event\.submitter\?\.id === "child-start";/);
  assert.match(submit, /if \(starting && planOpen && handOff\(made\.id\)\) return;\s*go\("home", \{ replace: true, fresh: true, message: `Listo\. Aule ya conoce a \$\{made\.name\}\.`, tone: "info" \}\);/);
  assert.equal((onboarding.match(/\bhandOff\(/g) ?? []).length, 1, "and nowhere else");
  // One press, one child: the buttons stay disabled once the child is made, until the screen shows again.
  assert.match(submit, /\} catch \(error\) \{\s*for \(const id of \["child-start", "child-later"\]\) \$\(id\)\.disabled = false;/);
  assert.doesNotMatch(submit, /finally/);
  assert.match(blocks(onboarding, 'onShow("p10-name"')[0], /for \(const id of \["child-start", "child-later"\]\) \$\(id\)\.disabled = false;/);
  // Enter in the name is the primary button, not the link that comes first in the form.
  const [enter] = blocks(onboarding, '$("child-name").addEventListener("keydown"');
  assert.match(enter, /if \(!\$\("child-start"\)\.disabled\) \$\("child-name-form"\)\.requestSubmit\(\$\("child-start"\)\);/);
  // With no session left: «Guardar» alone, and the plan's line.
  const shown = blocks(onboarding, 'onShow("p10-name"')[0];
  assert.match(shown, /\$\("child-start"\)\.textContent = planOpen \? "Empezar su primera sesión" : "Guardar";/);
  assert.match(shown, /\$\("child-later"\)\.hidden = !planOpen;/);
  assert.match(shown, /\$\("child-plan"\)\.hidden = planOpen;/);
  // The grade (A2): optional, the interview's grades and «Prefiero decirlo después», none chosen at
  // first and none for the next child; sent as the interview sends it, and nothing else of the interview.
  assert.match(name, /<select id="child-grade">\s*<option value="" disabled selected>Elige su grado<\/option>\s*<\/select>/);
  assert.match(name, /¿En qué grado está\? <span class="optional">opcional<\/span>/);
  assert.match(onboarding, /\.\.\.Object\.entries\(GRADES\)\.map\(\(\[value, text\]\) => new Option\(text, value\)\),\s*new Option\("Prefiero decirlo después", "later"\),/);
  assert.match(bodyOf(onboarding, "drop"), /\$\("child-grade"\)\.selectedIndex = 0;/);
  assert.match(submit, /grade: Object\.hasOwn\(GRADES, grade\) \? grade : null,/);
  assert.match(submit, /interests: \[\],\s*tone: "calido",\s*note: "",/);
  // Asked only after consent: the name screen needs it.
  assert.ok(html.indexOf('data-screen="p04"') < html.indexOf('data-screen="p10-name"'));
});

test("a new family writes its name on P02, which is sent with the code; a family coming back is not asked", () => {
  const field = html.match(/<div class="field" id="email-name-field"[^>]*>/)?.[0] ?? "";
  assert.match(field, /\bhidden\b/, "hidden in the markup");
  assert.match(html, /<input id="email-name-new" type="text" autocomplete="name" maxlength="120"/);
  assert.match(html, /<p class="field-error" id="email-name-new-error" role="alert" hidden>Escribe tu nombre para crear tu cuenta\.<\/p>/);
  const signin = scripts["signin.js"];
  assert.match(blocks(signin, 'onShow("p02"')[0], /\$\("email-name-field"\)\.hidden = flowNow\(\) !== "new";/);
  assert.match(scripts["screens.js"], /export function flowNow\(\) \{\s*return flow;\s*\}/);
  const verify = bodyOf(signin, "verify");
  assert.match(verify, /const named = name \|\| newName;/);
  assert.match(verify, /\.\.\.\(named \? \{ name: named \} : \{\}\)/);
  // In page memory only, and forgotten with the address.
  assert.match(bodyOf(signin, "forgetAddress"), /newName = "";/);
  assert.match(bodyOf(signin, "forgetAddress"), /\$\("email-name-new"\)\.value = "";/);
  // p03-name stays for a family coming back with a new address.
  assert.match(verify, /if \(failure === "name_needed"\) return go\("p03-name"\);/);
});

test("the interview is offered on the home after the first session, and its save keeps the consents as they were", () => {
  const home = scripts["home.js"];
  const row = bodyOf(home, "row");
  assert.match(row, /if \(!student\.interests\?\.length && !student\.note\) \{/);
  assert.match(row, /interview\.dataset\.interview = student\.id;/);
  assert.match(row, /interview\.textContent = `Cuéntale a Aule sobre \$\{student\.name\}`;/);
  // A whole target, 44 px tall, as every paper control is (D21).
  assert.match(css.match(/\n\.student-interview \{([^}]*)\}/)?.[1] ?? "", /min-height: 44px;/);
  const onboarding = scripts["onboarding.js"];
  assert.match(onboarding, /need\("interview", \(\) => interviewing !== null\);/);
  assert.match(onboarding, /\$\("interview-later"\)\.addEventListener\("click", \(\) => go\("home"\)\);/);
  assert.match(onboarding, /\$\("interview-start"\)\.addEventListener\("click", \(\) => go\("p06-grade"\)\);/);
  // The grade the family gave shows chosen, and skipping a question keeps its answer.
  assert.match(blocks(onboarding, 'onShow("p06-grade"')[0], /button\.dataset\.grade === interviewing\?\.grade/);
  assert.match(onboarding, /\$\("grade-skip"\)\.addEventListener\("click", \(\) => go\("p06"\)\);/);
  // Read first, then saved with the consents and the relationship as read: profileFrom reads a missing flag as «no».
  const save = bodyOf(onboarding, "saveInterview");
  assert.ok(save.indexOf('call("api/student/read"') < save.indexOf('call("api/student/save"'));
  for (const kept of ["remembers: student.remembers,", "keeps_transcripts: student.keepsTranscripts,", "relationship: student.relationship,", "language: student.language,", "tone: student.tone,"]) {
    assert.ok(save.includes(kept), kept);
  }
  assert.match(save, /\.\.\.\(student\.subjects \? \{ subjects: student\.subjects \} : \{\}\)/);
  assert.match(save, /return say\("No se pudo guardar\. Inténtalo otra vez\."\);/);
  assert.match(save, /go\("home", \{ message: `Gracias\. Aule ya sabe más de \$\{name\}\.`, tone: "info" \}\);/);
  // The interview's grade comes first, as its first question.
  const order = ["p05", "p06-grade", "p06", "p07"].map((id) => html.indexOf(`data-screen="${id}"`));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
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
  assert.match(session, /web-only state of the session: the stage/);
  for (const component of ["Botón/Compacto 191:1396", "Cuadro/Opción 190:806"]) assert.ok(html.includes(component), component);
});

/** The session's section, from its opening tag to the end screen's. */
const sessionHtml = () => html.slice(html.indexOf('<section class="screen" data-screen="session"'), html.indexOf('data-screen="session-end"'));

test("the session puts Aule's face on a stage, which a drawing or the camera takes while it shows (D30)", () => {
  const session = sessionHtml();
  // The stage holds the face, the board and the camera, in that order; the section no longer is #stage.
  assert.doesNotMatch(session.match(/<section[^>]*>/)[0], /id="stage"/);
  const stage = session.match(/<div class="stage" id="stage" data-shows="face">[\s\S]*?\n {10}<\/div>/)?.[0] ?? "";
  const at = (id) => stage.indexOf(`id="${id}"`);
  assert.ok(at("tutor") > 0 && at("tutor") < at("board") && at("board") < at("camera-view"), "face, board, camera");
  assert.ok(at("camera") > at("camera-view"), "the video is in the camera's view");
  assert.match(stage, /<figure id="board" class="board" hidden aria-live="polite"><\/figure>/, "no device class in the markup");
  assert.match(stage, /<div class="camera-view" id="camera-view" hidden>/);
  assert.match(stage, /<p id="tutor-state" class="tile-state" role="status">/);
  // The camera tile, its sentence, the empty board's sentence and the ink sentence are gone.
  for (const gone of ["board-empty", "camera-off", "tile-label", "pantalla de tinta", "Aquí verás lo que Aule te muestre"]) {
    assert.ok(!html.includes(gone), `index.html: ${gone}`);
    assert.ok(!scripts["app.js"].includes(gone), `app.js: ${gone}`);
  }
  const app = scripts["app.js"];
  // What the stage shows comes from the camera's view and the board, and every change of either says so.
  assert.match(bodyOf(app, "showStage"), /\$\("stage"\)\.dataset\.shows = !\$\("camera-view"\)\.hidden \? "camera" : !\$\("board"\)\.hidden \? "drawing" : "face";/);
  for (const name of ["draw", "showCamera", "teardown"]) assert.match(bodyOf(app, name), /\bshowStage\(\);/, name);
  assert.match(bodyOf(app, "showStep"), /\$\("board"\)\.hidden = true;\s*boardShows = null;\s*showStage\(\);/);
  // A drawing stays until the next one, a new exercise or the end: no timer brings the face back.
  assert.doesNotMatch(bodyOf(app, "draw"), /setTimeout/);
  // While the camera shows, a drawing waits under it.
  assert.match(css, /\.stage\[data-shows="camera"\] > \.board \{\s*display: none;/);
  // «Modo tinta» is the team's: hidden in the markup, shown and on only for the team.
  assert.match(session, /<button type="button" class="compact" id="device" aria-pressed="false" hidden>/);
  assert.match(app, /let inkMode = false;/);
  assert.match(
    bodyOf(app, "join"),
    /const team = getAccount\(\)\.team === true;\s*inkMode = team;\s*\$\("device"\)\.hidden = !team;\s*\$\("board"\)\.classList\.toggle\("device", team\);/,
  );
  assert.equal((app.match(/\$\("device"\)\.hidden = /g) ?? []).length, 1, "nothing else shows it");
  // The ink screen draws only an exercise it kept: it has no placeholder of its own.
  assert.match(bodyOf(app, "showInk"), /^\s*if \(boardShows\) return;\s*if \(lastExercise\) draw\(lastExercise\);\s*$/);
});

test("«Terminar» comes last in the page, after the talk button and the typed message, and the bar draws it on the title's row", () => {
  const session = sessionHtml();
  const end = session.indexOf('id="end"');
  for (const id of ["talk", "type", "typed", "cam", "cam-send", "cam-cancel", "device", "mic"]) {
    assert.ok(session.indexOf(`id="${id}"`) !== -1 && session.indexOf(`id="${id}"`) < end, `#${id} comes before «Terminar»`);
  }
  assert.ok(session.indexOf('class="session-bar-end"') > session.indexOf('class="talking"'));
  assert.match(session, /Last in the page's order, first in the bar: a Tab never reaches «Terminar» before the talk button/);
  // Every rule for exactly this selector, wherever it is in the sheet.
  const row = (selector) =>
    rules(css)
      .filter(([found]) => found.replace(/\/\*[\s\S]*?\*\//g, "").trim() === selector)
      .map(([, body]) => body)
      .join("\n");
  assert.match(row(".session-title"), /grid-row: 1;/);
  assert.match(row(".session-bar-end"), /grid-row: 1;/);
  assert.match(row(".session-bar-end"), /justify-self: end;/);
  // A long title never runs under the clock and «Terminar».
  assert.match(row(".session-title"), /padding-right: 168px;/);
  assert.match(row(".session-end"), /min-height: 44px;/);
});

test("«Mostrar mi tarea» shows what the camera sees on this device first; «Listo» sends one picture, «Cancelar» and the wait turn it off (D31)", () => {
  const session = sessionHtml();
  assert.match(session, /<button type="button" class="compact" id="cam" hidden><span class="icon" data-icon="videocam" aria-hidden="true"><\/span>Mostrar mi tarea<\/button>/);
  // A status, never hidden, only empty; it takes the keyboard's place as the camera opens.
  assert.match(session, /<p class="camera-aim" id="camera-aim" role="status" tabindex="-1"><\/p>/);
  assert.match(session, /<button type="button" class="ink-button send" id="cam-send" hidden>Listo<\/button>/);
  assert.match(session, /<button type="button" class="ink-link" id="cam-cancel" hidden>Cancelar<\/button>/);
  const app = scripts["app.js"];
  const aim = bodyOf(app, "aimCamera");
  assert.match(aim, /^\s*if \(showing \|\| aiming \|\| !room \|\| !tutorIdentity\) return;/);
  assert.match(aim, /track = await createLocalVideoTrack\(CAMERA\);/);
  assert.match(aim, /writeWords\(\$\("camera-aim"\), "camera_aim"\);/);
  // The focus goes to the line that says what to do, never to «Listo», where Space, the talk
  // key, would send a picture; «Listo» is scrolled into sight, clear of the shelf.
  assert.match(aim, /\$\("camera-aim"\)\.focus\(\{ preventScroll: true \}\);\s*\$\("cam-send"\)\.scrollIntoView\(\{ block: "nearest" \}\);/);
  assert.doesNotMatch(app, /\$\("(cam-send|cam-cancel)"\)\.focus\(/);
  // The coach waits while the child aims: its shelf would cover «Listo» on a small phone.
  assert.match(bodyOf(app, "showCoach"), /manualTurns && tutorReady && wanted\.mic && !aiming/);
  assert.match(aim, /showCoach\(\);/);
  assert.match(bodyOf(app, "stopAiming"), /showCoach\(\);/);
  // After the wait the line says the camera went off, for a moment.
  assert.match(aim, /aimTimer = setTimeout\(\(\) => stopAiming\(\{ waited: true \}\), AIM_MS\);/);
  assert.match(bodyOf(app, "stopAiming"), /writeWords\(\$\("camera-aim"\), waited \? "camera_off" : ""\);\s*if \(waited\) \{\s*aimNoteTimer = setTimeout\(\(\) => \{\s*writeWords\(\$\("camera-aim"\), ""\);\s*showCoach\(\);\s*\}, PASSING_MS\);/);
  // The coach waits while that line says anything: on a small phone its shelf would cover it.
  assert.match(bodyOf(app, "showCoach"), /!aiming && !\$\("camera-aim"\)\.textContent/);
  const stopping = bodyOf(app, "stopAiming");
  assert.ok(stopping.indexOf('waited ? "camera_off"') < stopping.indexOf("showCoach();"), "the line is written before the coach looks at it");
  assert.match(app, /const AIM_MS = 30_000;/);
  // «Listo» does nothing unless the camera is pointed, and the wait ends as it is pressed.
  const send = bodyOf(app, "showWork");
  assert.match(send, /^\s*if \(!aiming \|\| showing \|\| !aimTrack \|\| !room \|\| !tutorIdentity\) return;/);
  assert.ok(send.indexOf("clearTimeout(aimTimer);") < send.indexOf("publishTrack("));
  assert.ok(send.indexOf("publishTrack(") < send.indexOf('method: "show_work"'), "published, then the tutor is asked");
  // While the picture goes, «Cancelar» cannot be pressed either; and a camera that went off
  // while it was being published (the session ended) is never looked at.
  assert.match(send, /\$\("cam-send"\)\.disabled = true;\s*\$\("cam-cancel"\)\.disabled = true;/);
  assert.match(send, /sent = \{ track, room: sending \};[\s\S]*?\.publishTrack\(track, \{ source: Track\.Source\.Camera \}\)\.catch\(\(error\) => \{\s*sent = null;\s*throw error;\s*\}\);\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*if \(!aiming \|\| aimTrack !== track \|\| room !== sending\) return;/);
  assert.match(send, /await new Promise\(\(resolve\) => setTimeout\(resolve, SHOWN_MS\)\);/);
  assert.match(send, /finally \{[\s\S]*\$\("cam-cancel"\)\.disabled = false;\s*await stopAiming\(\);/);
  // Off: what «Listo» published is taken back by the track, also while its publish is still on
  // its way (livekit-client's unpublishTrack waits for it), and the camera is stopped either way.
  const stop = bodyOf(app, "stopAiming");
  assert.match(stop, /clearTimeout\(aimTimer\);\s*aiming = false;/);
  assert.match(stop, /if \(sent\?\.track === track\) \{\s*const taken = sent\.room;\s*sent = null;\s*await taken\.localParticipant\.unpublishTrack\(track\)/);
  assert.doesNotMatch(stop, /getTrackPublication/, "not by the source, whose first publication may be another");
  assert.match(stop, /track\.stop\(\);/);
  assert.match(stop, /hideKeepingFocus\(\$\("cam-send"\), \$\("session-title"\)\);/);
  // The keyboard's place, when it was on the camera's row, goes back to talking.
  assert.match(stop, /if \(placed\) focusTalk\(\);/);
  assert.match(bodyOf(app, "focusTalk"), /\[manualTurns \? \$\("talk"\) : null, \$\("cam"\)\]/);
  // A camera already stopped is shown as off.
  assert.match(bodyOf(app, "showCamera"), /publication\.track\.mediaStreamTrack\?\.readyState !== "ended"/);
  assert.match(app, /\$\("cam-send"\)\.addEventListener\("click", \(\) => showWork\(\)\);/);
  assert.match(app, /\$\("cam-cancel"\)\.addEventListener\("click", \(\) => stopAiming\(\)\);/);
  // The session's end turns it off too.
  const teardown = bodyOf(app, "teardown");
  assert.match(teardown, /clearTimeout\(aimTimer\);\s*aiming = false;\s*aimTrack\?\.stop\(\);/);
  assert.match(teardown, /sent = null;/);
  assert.match(teardown, /\$\("cam-cancel"\)\.disabled = false;/);
  assert.match(teardown, /\$\("camera-view"\)\.hidden = true;/);
  // «Mostrar mi tarea» shows once the tutor is ready, and gives its place to «Listo» while the camera is on.
  assert.match(bodyOf(app, "showCamera"), /\$\("cam"\)\.hidden = !tutorReady \|\| aiming;/);
  assert.match(bodyOf(app, "watchTutor"), /showTalk\(\);\s*\/\/[^\n]*\n\s*if \(room\) showCamera\(\);/);
});

test("the line under Aule's face says whose turn it is, and follows the hold", () => {
  const app = scripts["app.js"];
  assert.doesNotMatch(app, /STATE_TEXT/);
  const state = bodyOf(app, "setTutorState");
  // «Tu turno» only once Aule has the child's turn: not in the tail after letting go, nor while
  // end_turn is on its way (closingTurn), when it would say so before Aule heard the turn.
  assert.match(state, /const key = state === "listening" && manualTurns && !talking && !closingTurn \? "your_turn" : STATE_KEYS\.includes\(state\) \? state : "waiting";/);
  const [, closing] = bodyOf(app, "stopTalking").match(/closingTurn = true;([\s\S]*?)closingTurn = false;/) ?? [];
  assert.match(closing ?? "", /showTalk\(\);/, "the line is written as the turn closes, and again once it has");
  assert.match(state, /const text = words\(`state_\$\{key\}`, language\);/);
  // Written only when it changes, so a status that stays is not said again.
  assert.match(state, /if \(line\.textContent !== text \|\| line\.lang !== language\) write\(line, text, language\);/);
  assert.match(app, /function setTutorState\(state = \$\("tutor"\)\.dataset\.state\)/);
  // The hold starts and ends in showTalk, which writes the line again.
  assert.match(bodyOf(app, "showTalk"), /\bsetTutorState\(\);/);
  // Nothing is heard before the tutor is ready, so the open microphone's switch waits for it.
  assert.match(bodyOf(app, "showTalk"), /\$\("mic-group"\)\.hidden = manualTurns \|\| !tutorReady;/);
  assert.match(sessionHtml(), /<div class="mic-group" id="mic-group" hidden>/);
  // It is with the talk, where the talk button is with held turns: in the row under the stage it
  // wrapped below the first screen of a short screen (800 × 480, the review of 24 Nov).
  const talking = sessionHtml().slice(sessionHtml().indexOf('<div class="talking">'), sessionHtml().indexOf('class="session-bar-end"'));
  assert.ok(talking.indexOf('id="mic-group"') !== -1 && talking.indexOf('id="mic-group"') < talking.indexOf('id="talk"'));
});

test("the session's own words follow the student's language: «Terminar», the clock, the typed message, the conversation and who said what", () => {
  const app = scripts["app.js"];
  assert.match(bodyOf(app, "join"), /coaching = firstSession;\s*sessionWords\(\);/);
  const said = bodyOf(app, "sessionWords");
  assert.match(said, /writeWords\(\$\("end"\), "end_session"\);/);
  assert.match(said, /writeWords\(\$\("type-send"\), "send"\);/);
  for (const [id, attribute, key] of [
    ["clock", "aria-label", "clock_label"],
    ["typed", "aria-label", "type_label"],
    ["typed", "placeholder", "type_placeholder"],
    ["transcript", "aria-label", "conversation"],
  ]) {
    assert.ok(said.includes(`[$("${id}"), "${attribute}", "${key}"]`), `${id} ${attribute}`);
  }
  // Marked with the language, so a screen reader reads the conversation's lines in it (WCAG 3.1.2).
  assert.match(said, /element\.lang = language;/);
  assert.match(sessionHtml(), /<button type="submit" class="compact" id="type-send">Enviar<\/button>/);
  // Who said each line, in that language; no Spanish «Tú» is written into a line.
  assert.doesNotMatch(app, /dataset\.name = (?:mine \? )?"Tú/);
  assert.equal((app.match(/dataset\.name = words\("you(?:_typed)?", sessionLanguage\(\)\)/g) ?? []).length, 3);
  assert.match(app, /line\.dataset\.name = mine \? words\("you", sessionLanguage\(\)\) : "Aule";/);
  // What went wrong with a turn or a typed message, too.
  for (const key of ["talk_not_started", "turn_unheard", "message_failed"]) assert.ok(app.includes(`words("${key}", language)`), key);
});

test("a camera the session cannot use says so to the child, and under it, smaller and not live, what an adult can do (D33)", () => {
  const app = scripts["app.js"];
  const help = sessionHtml().match(/<p[^>]*\bid="session-help"[^>]*>/)?.[0] ?? "";
  assert.match(help, /class="device-note session-help"/);
  assert.doesNotMatch(help, /role=|aria-live/, "the message line above it is the alert");
  assert.ok(sessionHtml().indexOf("data-message") < sessionHtml().indexOf('id="session-help"'));
  const trouble = bodyOf(app, "cameraTrouble");
  assert.match(trouble, /showPassingMessage\(words\(key, language\), language\);\s*writeWords\(\$\("session-help"\), `\$\{key\}_help`\);/);
  // Both the camera's ways in say it this way, and the adult's line goes with the child's.
  assert.equal((app.match(/cameraTrouble\(error\?\.name\)/g) ?? []).length, 2);
  assert.doesNotMatch(app, /words\(cameraProblem\(/);
  assert.match(bodyOf(app, "showMessage"), /writeWords\(\$\("session-help"\), ""\);/);
  assert.match(bodyOf(app, "teardown"), /writeWords\(\$\("session-help"\), ""\);/);
});

test("Space holds to talk on the talk button and on the camera's buttons, and never presses them", async () => {
  const app = scripts["app.js"];
  // A child who talks with Space presses it wherever the focus is: on «Mostrar mi tarea», «Listo»
  // or «Cancelar» it would open the camera or send a picture (the review of 24 Nov). Enter still
  // presses them; Space on any other control (and in a field) is that control's.
  const source = ["SPACE_TALKS", "typing"].map((name) => app.match(new RegExp(`const ${name} = [^\\n]*;`))?.[0] ?? "").join("\n");
  const { runInNewContext } = await import("node:vm");
  const typing = runInNewContext(`${source}\ntyping`);
  for (const id of ["talk", "cam", "cam-send", "cam-cancel"]) assert.equal(typing({ tagName: "BUTTON", id }), false, id);
  for (const [tagName, id] of [["BUTTON", "end"], ["BUTTON", "device"], ["BUTTON", "answer-send"], ["INPUT", "typed"], ["TEXTAREA", "explanation-text"], ["SELECT", ""]]) {
    assert.equal(typing({ tagName, id }), true, `${tagName}#${id}`);
  }
  assert.equal(typing({ tagName: "P", id: "camera-aim" }), false);
  // Held, the key repeats: every keydown it talks on is stopped (no scroll, no press), and the
  // turn starts once; its keyup is stopped too, so a focused button is never clicked.
  const [down] = blocks(app, 'document.addEventListener("keydown"');
  assert.match(down, /if \(!spaceTalks\(event\)\) return;\s*\/\/[^\n]*\n\s*event\.preventDefault\(\);\s*if \(!event\.repeat\) startTalking\(\);/);
  const [up] = blocks(app, 'document.addEventListener("keyup"');
  assert.match(up, /if \(spaceTalks\(event\)\) event\.preventDefault\(\);/);
  assert.match(app, /const spaceTalks = \(event\) => event\.code === "Space" && manualTurns && current\(\) === "session" && !typing\(event\.target\);/);
});

test("the stage gives a drawing and the camera the room they need, and the camera shows all of its frame (D30, D31)", () => {
  const media = [...css.matchAll(/@media ([^{]+)\{((?:[^{}]*\{[^{}]*\})+)\s*\}/g)].map(([, query, body]) => [query.trim(), body]);
  const block = (query) => media.filter(([found]) => found === query).map(([, body]) => body).join("\n");
  // A rule by its selector, past the comment before it.
  const rule = (selector) => rules(css).find(([found]) => found.replace(/\/\*[\s\S]*?\*\//g, "").trim() === selector);
  // The preview is the whole frame, letterboxed on the stage's paper: the child aims with what Aule gets.
  const [, video] = rule(".camera-view video") ?? [];
  assert.match(video ?? "", /object-fit: contain;/);
  // The face's height is --stage; on one column a drawing takes the full width at 800 × 480's
  // shape, with its band, and the camera what the screen leaves above «Listo» and the shelf.
  assert.match(rule(".stage")?.[1] ?? "", /height: var\(--stage\);/);
  const one = block("(max-width: 900px) and (min-height: 640px), (max-width: 559px)");
  assert.match(one, /\.stage\[data-shows="drawing"\] \{\s*height: max\(var\(--stage\), calc\(\(100vw - 36px\) \* 0\.6 \+ 68px\)\);/);
  assert.match(one, /\.stage\[data-shows="camera"\] \{\s*height: max\(var\(--stage\), min\(calc\(100vw \+ 32px\), calc\(100vh - 318px\), 560px\)\);/);
  // On a short screen from 560 px the stage leaves room for what shows over and under it: A16's
  // lines with the face, an engine's route and the camera's line.
  const short = block("(min-width: 560px) and (max-width: 900px) and (max-height: 639px)");
  assert.match(short, /--stage: max\(160px, calc\(100vh - 128px - var\(--intro-room, 0px\) - var\(--route-room, 0px\) - var\(--aim-room, 0px\)\)\);/);
  assert.match(short, /:has\(\.session-intro:not\(:empty\)\):has\(\.stage\[data-shows="face"\]\) \{\s*--intro-room: 72px;/);
  assert.match(short, /:has\(#route:not\(\[hidden\]\)\) \{\s*--route-room: 29px;/);
  assert.match(short, /:has\(\.camera-aim:not\(:empty\)\) \{\s*--aim-room: 16px;/);
  // Under 901 px A16's lines step aside while a drawing or the camera shows: out of sight, not
  // out of the tree, since the first is a status.
  const aside = block("(max-width: 900px)");
  assert.match(aside, /:has\(\.stage:not\(\[data-shows="face"\]\)\) \.session-intro:not\(:empty\) \{[^}]*clip: rect\(0 0 0 0\);/);
  assert.doesNotMatch(aside, /display: none/);
  // On a short screen an exercise card takes the room, and Aule's face goes to its band.
  assert.match(block("(max-width: 900px) and (max-height: 760px)"), /:has\(#card:not\(\[hidden\]\)\) \.stage\[data-shows="face"\] \{\s*height: auto;/);
  // The message line's empty place takes no row: the stage starts right under the title.
  assert.ok(rule(".session-message:not(:has(> :not([hidden])))"));
});

test("the team's link goes to the team's console, and the page names no other way to it", () => {
  assert.ok(!files.includes("admin.html") && !files.includes("admin.js") && !files.includes("pilot.js"), "the panel's files are gone");
  const link = html.match(/<a [^>]*id="team-panel"[^>]*>[^<]*<\/a>/)?.[0] ?? "";
  assert.equal(link, '<a class="link" id="team-panel" href="https://admin.meetaule.com/" hidden>Panel del equipo</a>');
  // Every other «admin» on the page is the team's mail address.
  assert.deepEqual([...new Set(html.match(/[\w.:/-]*admin[\w.:/@-]*/g))].sort(), ["admin@meetaule.com", "https://admin.meetaule.com/", "mailto:admin@meetaule.com"]);
  for (const [name, text] of Object.entries(scripts)) assert.doesNotMatch(text, /api\/admin|["'`]admin["'`]/, name);
});
