import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { contrastFailures, over, pairs, ratio } from "../contrast.mjs";
import { generate, MODES, parseDesign, readDesign } from "../tokens.mjs";

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
  for (const gone of ["accent", "accent-tint", "accent-deep", "paper-deep", "surface", "on-accent", "esp32-accent"]) {
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
    "color/primary": "#0075de",
    "color/text-accent": "#62aef0",
    "color/white-70": "#ffffffb3",
    "color/disabled": "#707070",
  });
  const value = (name) => variables.find((v) => v.name === name).value;
  assert.equal(value("space/target"), 150);
  assert.equal(value("space/target-gap"), 38);
  assert.equal(value("space/stroke"), 4);
  assert.equal(value("radius/md"), 24);
  // The button is the blue with white text, and the accent text is for text on black.
  const all = pairs(state);
  assert.ok(all.find((p) => p.component === "esp32-button").ratio >= 4.5);
  assert.ok(all.find((p) => p.component === "esp32-text-accent").ratio > 8.5);
});

test("a colour with an alpha channel keeps its eight hex digits and says its alpha in the Figma files", () => {
  const files = generate({ design: DESIGN, figma: FIGMA_DIR });
  const web = JSON.parse(files[join(FIGMA_DIR, "figma-web.json")]).variables;
  const ink = web.find((v) => v.name === "color/ink");
  assert.equal(ink.value, "#000000e5");
  assert.equal(ink.alpha, 0.898);
  assert.equal(web.find((v) => v.name === "color/paper").alpha, undefined);
});

test("the grey of a disabled esp32 button is a graphic: 3:1, not 4.5:1, and its text is white at 70% over black", () => {
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
