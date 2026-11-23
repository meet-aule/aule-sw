import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { contrastFailures, over, pairs, ratio } from "../contrast.mjs";
import { generate, makeCss, MODES, parseDesign, readDesign } from "../tokens.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESIGN = join(HERE, "..", "..", "DESIGN.md");
const PLAYGROUND_CSS = join(HERE, "..", "..", "apps", "playground", "public", "tokens.css");
const FIGMA_DIR = join(HERE, "..");

const { text, state, report } = readDesign(DESIGN);

test("DESIGN.md passes the linter of @google/design.md with no error and no warning", () => {
  // The linter measures every pair as text (4.5:1). A *-stroke component is a
  // graphic that has to reach 3:1, which the test below checks, so its warning
  // is the only one allowed.
  const bad = report.findings.filter(
    (f) => f.severity !== "info" && !(f.rule === "contrast-ratio" && f.path?.endsWith("-stroke")),
  );
  assert.deepEqual(bad, []);
});

test("every text pair of every component reaches 4.5:1 and every graphic 3:1", () => {
  const all = pairs(state);
  // A DESIGN.md with no pairs would pass for nothing.
  assert.ok(all.length >= 25, `only ${all.length} pairs`);
  assert.deepEqual(
    contrastFailures(state).map((p) => `${p.component}: ${p.text} on ${p.background} is ${p.ratio.toFixed(2)}:1, needs ${p.min}`),
    [],
  );
});

test("the contrast check fails a colour used as both the background and the text of a button", () => {
  const broken = text.replace(
    /(  button-primary:\n    backgroundColor: "\{colors\.primary\}"\n    textColor: )"\{colors\.on-primary\}"/,
    '$1"{colors.primary}"',
  );
  assert.notEqual(broken, text);
  const failures = contrastFailures(parseDesign(broken).state);
  assert.ok(failures.some((p) => p.component === "button-primary"), JSON.stringify(failures));
});

test("the colours are Notion's palette, as the proposal's section 7 lists them: no accent of our own", () => {
  const want = {
    paper: "#ffffff",
    "surface-neutral": "#f6f5f4",
    "surface-hover": "#0000000d",
    ink: "#000000e5",
    muted: "#0000008a",
    line: "#0000001a",
    "field-border": "#78736f",
    primary: "#0075de",
    "primary-hover": "#005bab",
    secondary: "#e6f3fe",
    "secondary-text": "#005bab",
    "secondary-hover": "#f2f9ff",
    "link-hover": "#00396b",
    danger: "#b01601",
    success: "#0f6220",
  };
  for (const [name, hex] of Object.entries(want)) assert.equal(state.colors.get(name)?.hex, hex, name);
  for (const gone of ["accent", "accent-tint", "accent-deep", "paper-deep", "surface", "on-accent", "esp32-primary"]) {
    assert.equal(state.colors.has(gone), false, `${gone} is still there`);
  }
  assert.ok(!/#9a5b2e|#cf5a1e|#e8a26b/i.test(text), "the copper, the orange or the light copper is still written");
});

test("a link on grey is secondary-text: the blue of a link does not reach 4.5:1 on grey, and muted is white-only", () => {
  const color = (name) => state.colors.get(name);
  const grey = color("surface-neutral");
  assert.ok(ratio(color("primary"), grey) < 4.5, "primary on grey would pass: the rule is not needed any more");
  assert.ok(ratio(color("secondary-text"), grey) >= 4.5);
  const rule = pairs(state).find((p) => p.component === "link-on-neutral");
  assert.equal(rule.background, "#f6f5f4");
  assert.equal(rule.text, "#005bab");
  assert.ok(rule.ratio >= 4.5, `${rule.ratio}`);
  // muted is 4.47:1 on grey: every muted pair has to be on white.
  const mutedOnGrey = [...state.components].filter(
    ([, d]) => d.properties.get("textColor")?.hex === "#0000008a" && d.properties.get("backgroundColor")?.hex !== "#ffffff",
  );
  assert.deepEqual(mutedOnGrey.map(([n]) => n), []);
});

test("a transparent colour is laid over its background before it is measured", () => {
  const all = pairs(state);
  // ink is black at 90%: on white it is about 17:1, not the 21:1 of plain black.
  const page = all.find((p) => p.component === "page");
  assert.ok(page.ratio > 15 && page.ratio < 20, `${page.ratio}`);
  // a transparent background is laid over the page too: ink on the 5% hover is still about 15:1.
  const hover = over(state.colors.get("surface-hover"), state.colors.get("paper"));
  const onHover = ratio(over(state.colors.get("ink"), hover), hover);
  assert.ok(onHover > 14, `${onHover}`);
  // primary on white is 4.57:1 (Notion's own figure for the filled button).
  const button = all.find((p) => p.component === "button-primary");
  assert.ok(button.ratio >= 4.5 && button.ratio < 4.7, `${button.ratio}`);
});

test("the generated CSS and the Figma files are what DESIGN.md says now", () => {
  const files = generate({ design: DESIGN, css: PLAYGROUND_CSS, figma: FIGMA_DIR });
  assert.equal(Object.keys(files).length, 1 + MODES.length);
  for (const [path, expected] of Object.entries(files)) {
    assert.equal(readFileSync(path, "utf8"), expected, `${path} is out of date: run pnpm design-tokens`);
  }
});

test("every mode has variables of its own", () => {
  const files = generate({ design: DESIGN, figma: FIGMA_DIR });
  for (const mode of MODES) {
    const { variables } = JSON.parse(files[join(FIGMA_DIR, `figma-${mode}.json`)]);
    assert.ok(variables.length > 10, mode);
  }
  const eink = JSON.parse(files[join(FIGMA_DIR, "figma-eink.json")]).variables;
  assert.equal(eink.find((v) => v.name === "space/margin-x").value, 40);
  assert.equal(eink.filter((v) => v.type === "COLOR").length, 4);
});

test("the playground's CSS draws only from the tokens: no colour, font or variable of its own", () => {
  const dir = join(HERE, "..", "..", "apps", "playground", "public");
  const style = readFileSync(join(dir, "style.css"), "utf8");
  const tokens = readFileSync(join(dir, "tokens.css"), "utf8");
  // The paper's grain is an SVG inside a data URI, drawn by the browser.
  const code = style.replace(/url\("data:[^"]*"\)/g, "");
  assert.deepEqual(code.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], [], "a colour written by hand");
  const families = [...code.matchAll(/font-family:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.deepEqual(families.filter((f) => f !== '"Inter"'), [], "a font family other than Inter");
  const defined = new Set([...(style + tokens).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const used = [...style.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].filter((v) => !defined.has(v)), [], "a variable that does not exist");
});

test("the esp32 mode is black, white and blue, and has none of the web colours", () => {
  const files = generate({ design: DESIGN, figma: FIGMA_DIR });
  const { variables } = JSON.parse(files[join(FIGMA_DIR, "figma-esp32.json")]);
  const colors = Object.fromEntries(variables.filter((v) => v.type === "COLOR").map((v) => [v.name, v.value]));
  assert.deepEqual(colors, {
    "color/black": "#000000",
    "color/white": "#ffffff",
    "color/accent": "#0075de",
    "color/white-70": "#ffffffb3",
    "color/disabled": "#707070",
  });
  const value = (name) => variables.find((v) => v.name === name).value;
  assert.equal(value("space/target"), 150);
  assert.equal(value("space/target-gap"), 38);
  assert.equal(value("space/stroke"), 4);
  assert.equal(value("radius/md"), 24);
  // One accent, the web's blue, with white text (4.57:1); the same contrast rule as the web.
  const all = pairs(state);
  const button = all.find((p) => p.component === "esp32-button");
  assert.equal(button.background, "#0075de");
  assert.equal(button.text, "#ffffff");
  assert.ok(button.ratio > 4.5 && button.ratio < 4.7, `${button.ratio}`);
  assert.equal(button.background, state.colors.get("primary").hex, "the esp32 accent is the web's primary");
  for (const name of ["esp32-mic-on", "esp32-button-small"]) assert.equal(all.find((p) => p.component === name).background, "#0075de");
  // the dot of "Te escucho" is a graphic in the accent on black: 3:1 is enough, and it has more
  const dot = all.find((p) => p.component === "esp32-listening-dot-stroke");
  assert.equal(dot.min, 3);
  assert.ok(dot.ratio >= 4.5, `${dot.ratio}`);
  assert.equal(JSON.stringify(variables).includes("#62aef0") || JSON.stringify(variables).includes("#e8a26b"), false);
});

test("a colour with an alpha channel keeps its eight hex digits and says its alpha in the Figma files", () => {
  const files = generate({ design: DESIGN, figma: FIGMA_DIR });
  const web = JSON.parse(files[join(FIGMA_DIR, "figma-web.json")]).variables;
  const ink = web.find((v) => v.name === "color/ink");
  assert.equal(ink.value, "#000000e5");
  assert.equal(ink.alpha, 0.898);
  assert.equal(web.find((v) => v.name === "color/paper").alpha, undefined);
});

test("the grey of a disabled esp32 button is a graphic: 3:1, and its text is 4.5:1, and its text is white at 70% over black", () => {
  const all = pairs(state);
  const stroke = all.find((p) => p.component === "esp32-button-disabled-stroke");
  assert.equal(stroke.min, 3);
  assert.ok(stroke.ratio >= 3 && stroke.ratio < 4.5, `${stroke.ratio}`);
  const text = all.find((p) => p.component === "esp32-button-disabled");
  assert.equal(text.min, 4.5);
  // 70% white over black is #b3b3b3, about 10:1, and not the 21:1 of plain white.
  assert.ok(text.ratio > 9 && text.ratio < 12, `${text.ratio}`);
  // #707070 is allowed only for that border.
  const users = [...state.components].filter(([, d]) => [...d.properties.values()].some((v) => v.hex === "#707070")).map(([n]) => n);
  assert.deepEqual(users, ["esp32-button-disabled-stroke"]);
});

test("a graphic below 3:1 and a text below 4.5:1 both fail", () => {
  const darker = parseDesign(text.replace('esp32-disabled: "#707070"', 'esp32-disabled: "#505050"')).state;
  assert.ok(contrastFailures(darker).some((p) => p.component === "esp32-button-disabled-stroke"));
  const dim = parseDesign(text.replace('"#ffffffb3"', '"#ffffff40"')).state;
  assert.ok(contrastFailures(dim).some((p) => p.component === "esp32-button-disabled"));
});

test("the esp32 screen has the web's rule: 4.5:1 in text and 3:1 in graphics, not 7:1", () => {
  const esp = pairs(state).filter((p) => p.component.startsWith("esp32-"));
  assert.ok(esp.length >= 8);
  for (const p of esp) assert.equal(p.min, p.component.endsWith("-stroke") ? 3 : 4.5, p.component);
  assert.deepEqual(esp.filter((p) => p.ratio < p.min).map((p) => p.component), []);
  // a text of 40 px at 5:1 passes here, as it would on the web
  const loose = parseDesign(text.replace('esp32-white-70: "#ffffffb3"', 'esp32-white-70: "#ffffff8c"')).state;
  assert.ok(pairs(loose).find((p) => p.component === "esp32-button-disabled").ratio < 7);
  assert.deepEqual(contrastFailures(loose).filter((p) => p.component === "esp32-button-disabled"), []);
  // and a button of the web's blue with text that does not reach 4.5:1 still fails
  const bad = parseDesign(text.replace(/(  esp32-button:\n    backgroundColor: "\{colors\.esp32-accent\}"\n    textColor: )"\{colors\.esp32-white\}"/, '$1"{colors.esp32-disabled}"')).state;
  assert.ok(contrastFailures(bad).some((p) => p.component === "esp32-button"));
});


// ---- the variants of a component reach the CSS of the product

/** The declarations of every rule of a stylesheet, by its selector (comments out, spaces collapsed). */
function rulesOf(css) {
  const rules = new Map();
  for (const [, selector, body] of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const key = selector.trim().replace(/\s+/g, " ");
    const declarations = Object.fromEntries(
      body.split(";").map((d) => d.trim()).filter(Boolean).map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]),
    );
    rules.set(key, { ...(rules.get(key) ?? {}), ...declarations });
  }
  return rules;
}

const v = (name) => `var(--aule-c-${name})`;
const playgroundCss = readFileSync(join(HERE, "..", "..", "apps", "playground", "public", "style.css"), "utf8");

test("a variant changed in DESIGN.md changes the generated CSS", () => {
  const before = makeCss(state, "x");
  assert.match(before, /--aule-c-button-primary-bg: #0075de;/);
  const changed = parseDesign(
    text.replace(/(  button-primary:\n    backgroundColor: )"\{colors\.primary\}"/, '$1"{colors.danger}"'),
  ).state;
  const after = makeCss(changed, "x");
  assert.notEqual(after, before);
  assert.match(after, /--aule-c-button-primary-bg: #b01601;/);
  // and so does its text, its hover, its radius and its padding
  for (const [pattern, replacement, expected] of [
    [/(  button-primary:\n    backgroundColor: "\{colors\.primary\}"\n    textColor: )"\{colors\.on-primary\}"/, '$1"{colors.ink}"', /--aule-c-button-primary-text: #000000e5;/],
    [/(  button-primary-hover:\n    backgroundColor: )"\{colors\.primary-hover\}"/, '$1"{colors.danger}"', /--aule-c-button-primary-hover-bg: #b01601;/],
    [/(  button-secondary:\n    backgroundColor: "\{colors\.secondary\}"\n    textColor: "\{colors\.secondary-text\}"\n    typography: "\{typography\.button\}"\n    rounded: )"\{rounded\.md\}"/, '$1"{rounded.xl}"', /--aule-c-button-secondary-radius: 16px;/],
  ]) {
    const next = text.replace(pattern, replacement);
    assert.notEqual(next, text, String(pattern));
    assert.match(makeCss(parseDesign(next).state, "x"), expected);
  }
});

test("the playground's CSS takes the colour, border, radius and type of every button variant from the generated variables", () => {
  const rules = rulesOf(playgroundCss);
  const need = {
    button: { background: v("button-secondary-bg"), color: v("button-secondary-text"), "border-radius": v("button-secondary-radius"), font: v("button-secondary-type") },
    "button:hover:not(:disabled)": { background: v("button-secondary-hover-bg"), color: v("button-secondary-hover-text") },
    'button[type="submit"], button.primary': { background: v("button-primary-bg"), "border-color": v("button-primary-border"), color: v("button-primary-text") },
    'button[type="submit"]:hover:not(:disabled), button.primary:hover:not(:disabled)': { background: v("button-primary-hover-bg"), color: v("button-primary-hover-text") },
    "button.danger": { background: v("button-danger-bg"), color: v("button-danger-text") },
    "button.quiet": { color: v("button-link-text") },
    "button.quiet:hover:not(:disabled)": { color: v("button-link-hover-text") },
    'button:disabled, button[type="submit"]:disabled, button.primary:disabled': { background: v("button-disabled-bg"), color: v("button-disabled-text") },
    '.talk[aria-pressed="true"]': { background: v("button-talk-active-bg"), color: v("button-talk-active-text") },
  };
  for (const [selector, declarations] of Object.entries(need)) {
    const rule = rules.get(selector);
    assert.ok(rule, `no rule for ${selector}`);
    for (const [property, value] of Object.entries(declarations)) assert.equal(rule[property], value, `${selector} { ${property} }`);
  }
  // Nothing that styles a button writes one of the variant colours by its own name.
  const own = /var\(--(primary|primary-hover|on-primary|secondary|secondary-text|secondary-hover)\)|var\(--aule-color-(primary|primary-hover|on-primary|secondary|secondary-text|secondary-hover)\)/;
  const bad = [...rules].filter(([sel]) => /button|\.talk/.test(sel)).flatMap(([sel, d]) =>
    Object.entries(d).filter(([, value]) => own.test(value)).map(([p, value]) => `${sel} { ${p}: ${value} }`));
  assert.deepEqual(bad, []);
  // A disabled button is never faded: its text came from a token, not from opacity.
  assert.equal(/opacity:\s*0?\.[0-9]+[^}]*\}/.test(playgroundCss.match(/button:disabled[^{]*\{[^}]*\}/)?.[0] ?? ""), false);
});

test("the border of a form control is field-border #78736f: a graphic at 3:1 (it is 4.69:1), and line is only for dividers and cards", () => {
  const stroke = pairs(state).find((p) => p.component === "field-border-stroke");
  assert.equal(stroke.min, 3);
  assert.equal(stroke.text, "#78736f");
  assert.ok(stroke.ratio > 4.6 && stroke.ratio < 4.8, `${stroke.ratio}`);
  // line (black at 10%) on white is 1.26:1: it would not do for a control
  const line = state.colors.get("line");
  const white = state.colors.get("paper");
  assert.ok(ratio(over(line, white), white) < 3);
  assert.equal(state.components.get("divider").properties.get("backgroundColor").hex, "#0000001a");
  // and the CSS: the rules of the controls take the edge from field-border and none takes it from line
  const rules = rulesOf(playgroundCss);
  const controls = [...rules].filter(([sel]) => /(^|[ ,])(input|select|textarea)\b|label\.chip span|label\.tone span|\.student span|\.card textarea/.test(sel));
  assert.ok(controls.length >= 5, `${controls.length}`);
  const onLine = controls.filter(([, d]) => /border(-color)?:[^;]*(var\(--line\)|var\(--aule-color-line\))/.test(Object.entries(d).map(([k, x]) => `${k}:${x}`).join(";")));
  assert.deepEqual(onLine.map(([sel]) => sel), []);
  for (const sel of ["input, select, textarea, button", 'input[type="checkbox"], input[type="radio"]', "label.chip span", ".card textarea"]) {
    assert.match(rules.get(sel)?.border ?? "", /--aule-color-field-border/, sel);
  }
});
