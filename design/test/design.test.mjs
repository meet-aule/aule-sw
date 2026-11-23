import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { contrastFailures, pairs } from "../contrast.mjs";
import { derived, deriveInto, generate, MODES, parseDesign, readDesign } from "../tokens.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESIGN = join(HERE, "..", "..", "DESIGN.md");
const PLAYGROUND_CSS = join(HERE, "..", "..", "apps", "playground", "public", "tokens.css");
const FIGMA_DIR = join(HERE, "..");

const { text, state, report } = readDesign(DESIGN);

test("DESIGN.md passes the linter of @google/design.md with no error and no warning", () => {
  const bad = report.findings.filter((f) => f.severity !== "info");
  assert.deepEqual(bad, []);
});

test("every text and background pair of every component reaches 4.5:1", () => {
  const all = pairs(state);
  // A DESIGN.md with no pairs would pass for nothing.
  assert.ok(all.length >= 20, `only ${all.length} pairs`);
  assert.deepEqual(
    contrastFailures(state).map((p) => `${p.component}: ${p.text} on ${p.background} is ${p.ratio.toFixed(2)}:1`),
    [],
  );
});

test("the contrast check fails an accent used as both the background and the text of a button", () => {
  const broken = text.replace(
    /(  button-primary:\n    backgroundColor: "\{colors\.accent\}"\n    textColor: )"\{colors\.on-accent\}"/,
    '$1"{colors.accent}"',
  );
  assert.notEqual(broken, text);
  const failures = contrastFailures(parseDesign(broken).state);
  assert.ok(failures.some((p) => p.component === "button-primary"), JSON.stringify(failures));
});

test("accent-tint and accent-deep are what accent says they are", () => {
  const want = derived(state.colors.get("accent").hex, state.colors.get("paper").hex);
  assert.equal(state.colors.get("accent-tint").hex, want["accent-tint"], "run `pnpm design-derive`");
  assert.equal(state.colors.get("accent-deep").hex, want["accent-deep"], "run `pnpm design-derive`");
  assert.equal(deriveInto(text, state), text);
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

test("the esp32 mode is black, white and its own accent, and has none of the web colours", () => {
  const files = generate({ design: DESIGN, figma: FIGMA_DIR });
  const { variables } = JSON.parse(files[join(FIGMA_DIR, "figma-esp32.json")]);
  const colors = Object.fromEntries(variables.filter((v) => v.type === "COLOR").map((v) => [v.name, v.value]));
  assert.deepEqual(colors, { "color/black": "#000000", "color/white": "#ffffff", "color/accent": "#e8a26b" });
  assert.equal(variables.find((v) => v.name === "space/target").value, 150);
});
