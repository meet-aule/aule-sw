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
const ownScripts = ["app.js", "students.js", "signin.js", "steps.js", "screens.js", "onboarding.js", "home.js", "session-messages.js", "visuals.js", "admin.js"];
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
  for (const name of ["signin.js", "onboarding.js", "home.js"]) {
    assert.deepEqual([...graph[name]].sort(), ["screens.js", "steps.js", "students.js"], name);
  }
  assert.deepEqual([...graph["app.js"]].sort(), ["home.js", "screens.js", "session-messages.js", "visuals.js"]);
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
