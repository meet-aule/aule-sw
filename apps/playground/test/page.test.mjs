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
const ownScripts = ["app.js", "students.js", "signin.js", "steps.js", "screens.js", "onboarding.js", "home.js", "visuals.js", "admin.js"];
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
  for (const name of ["signin.js", "onboarding.js", "home.js"]) {
    assert.deepEqual([...graph[name]].sort(), ["screens.js", "steps.js", "students.js"], name);
  }
  assert.deepEqual([...graph["app.js"]].sort(), ["home.js", "screens.js", "visuals.js"]);
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

test("what is kept about a child is the parent's to choose: both choices show before «Autorizo», with the editor's defaults (D5)", () => {
  const panel = html.match(/<div class="keep-panel" id="keep-panel"[^>]*>/)?.[0];
  assert.ok(panel, "P04 has the panel");
  assert.doesNotMatch(panel, /\bhidden\b/, "the panel shows from the start");
  assert.match(html, /id="keep-toggle"[^>]*aria-expanded="true"/);
  const box = (id) => html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0] ?? "";
  // Remembering between sessions starts ticked and the written conversation does not, on P04 as in the editor.
  for (const [ticked, unticked] of [["keep-memory", "keep-transcripts"], ["student-remembers", "student-transcripts"]]) {
    assert.match(box(ticked), /\bchecked\b/, `${ticked} is ticked by default`);
    assert.match(box(unticked), /type="checkbox"/, unticked);
    assert.doesNotMatch(box(unticked), /\bchecked\b/, `${unticked} is not ticked by default`);
  }
  // The parent's own consent is never ticked for them.
  assert.match(box("consent"), /type="checkbox"/, "P04's box");
  assert.doesNotMatch(box("consent"), /\bchecked\b/, "P04's box is not ticked by default");
  assert.ok(html.indexOf('id="keep-panel"') < html.indexOf('id="consent-ok"'), "the choices come before «Autorizo»");
  // And the onboarding sets them back to those defaults, and open, each time it starts again.
  assert.match(scripts["onboarding.js"], /const DEFAULTS = \{ remembers: true, keepsTranscripts: false \};/);
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
