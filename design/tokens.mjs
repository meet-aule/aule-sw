#!/usr/bin/env node
// Turns DESIGN.md into the files the products use, with @google/design.md
// (the same version in both repositories, pinned in package.json):
//   --css <file>     CSS variables of the `web` mode, for one product
//   --figma <dir>    variables for Figma, one file per mode (figma-<mode>.json)
//   --check          write nothing; fail if a generated file differs from what
//                    DESIGN.md says now (this is what CI runs)
//   --derive         rewrite `accent-tint` and `accent-deep` from `accent`
//   --design <file>  the DESIGN.md to read (default: ../DESIGN.md)
//
// This file is identical in aule-sw and aule-store.
//
// Why the typography comes from the CLI's library model and not from
// `design.md export`: in 0.4.0 the css-vars and css-tailwind exports leave out
// the line height and quote a whole font stack as one name, and the dtcg one
// leaves out the unit of a line height and the font features. The model that
// `lint` builds has all of it. Line heights are written in px in DESIGN.md
// because 0.4.0 drops a unitless one (1.5) from the model without a word.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { lint } from "@google/design.md/linter";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MODES = ["web", "eink", "esp32"];

// ---------------------------------------------------------------- reading

export function parseDesign(text) {
  const report = lint(text);
  return { text, report, state: report.designSystem };
}

export function readDesign(path) {
  return parseDesign(readFileSync(path, "utf8"));
}

/** Which mode a token belongs to, and its name without the prefix. */
export function modeOf(name) {
  for (const mode of ["eink", "esp32"]) {
    if (name.startsWith(`${mode}-`)) return { mode, name: name.slice(mode.length + 1) };
  }
  return { mode: "web", name };
}

const px = (d) => (d.unit === "rem" ? d.value * 16 : d.value);
const css = (d) => `${trim(d.value)}${d.unit}`;
const trim = (n) => String(Math.round(n * 1000) / 1000);

// ---------------------------------------------------------------- derived colours

const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb) => "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const mix = (a, b, share) => {
  const [x, y] = [toRgb(a), toRgb(b)];
  return toHex(x.map((v, i) => v * share + y[i] * (1 - share)));
};

/** What `accent-tint` and `accent-deep` must be for a given accent and paper. */
export function derived(accent, paper) {
  return { "accent-tint": mix(accent, paper, 0.16), "accent-deep": mix(accent, "#000000", 0.75) };
}

export function deriveInto(text, state) {
  const want = derived(state.colors.get("accent").hex, state.colors.get("paper").hex);
  let out = text;
  for (const [name, hex] of Object.entries(want)) {
    out = out.replace(new RegExp(`^(  ${name}: )"#[0-9a-fA-F]{6}"`, "m"), `$1"${hex}"`);
  }
  return out;
}

// ---------------------------------------------------------------- CSS

const quoteFamily = (stack) =>
  stack
    .split(",")
    .map((f) => f.trim())
    .map((f) => (/[\s]/.test(f) && !f.startsWith('"') ? `"${f}"` : f))
    .join(", ");

/** CSS variables of the `web` mode. */
export function makeCss(state, designName) {
  const lines = [];
  const add = (name, value) => lines.push(`  --aule-${name}: ${value};`);
  const web = (map) => [...map].map(([k, v]) => [k, v, modeOf(k)]).filter(([, , m]) => m.mode === "web");

  for (const [k, v] of web(state.colors)) add(`color-${k}`, v.hex);
  for (const [k, v] of web(state.spacing)) add(`space-${k}`, css(v));
  for (const [k, v] of web(state.rounded)) add(`radius-${k}`, css(v));
  let family = null;
  for (const [k, v] of web(state.typography)) {
    family ??= quoteFamily(v.fontFamily);
    if (quoteFamily(v.fontFamily) !== family) throw new Error(`typography.${k}: every web style uses the same font stack`);
    const size = css(v.fontSize);
    const leading = v.lineHeight ? `/${css(v.lineHeight)}` : "";
    add(`type-${k}`, `${v.fontWeight ?? 400} ${size}${leading} var(--aule-font-sans)`);
    if (v.letterSpacing) add(`tracking-${k}`, css(v.letterSpacing));
    if (v.fontFeature) add(`features-${k}`, `"${v.fontFeature}"`);
  }
  if (family) lines.splice(lines.findIndex((l) => l.includes("--aule-type-")), 0, `  --aule-font-sans: ${family};`);

  return [
    `/* Generated from DESIGN.md (${designName}) by design/tokens.mjs. Do not edit: change DESIGN.md and run`,
    `   the design-tokens script. CI fails if this file is not what DESIGN.md says. */`,
    ":root {",
    ...lines,
    "}",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- Figma

/**
 * One file per mode, flat, in the shape of Figma variables: the name has the
 * group in it ("color/paper"), the type is COLOR, FLOAT (px) or STRING.
 * `esp32` also carries the `web` colours and radii, which it uses as they are.
 */
export function makeFigma(state, mode, designName) {
  const variables = [];
  const take = (kind, map, own = true) => {
    for (const [key, value] of map) {
      const m = modeOf(key);
      if (own ? m.mode !== mode : m.mode !== "web") continue;
      kind(m.name, value);
    }
  };
  const color = (n, v) => variables.push({ name: `color/${n}`, type: "COLOR", value: v.hex });
  const num = (group) => (n, v) => variables.push({ name: `${group}/${n}`, type: "FLOAT", value: trim(px(v)) * 1 });
  const type = (n, v) => {
    const size = px(v.fontSize);
    variables.push({ name: `type/${n}/family`, type: "STRING", value: v.fontFamily.split(",")[0].trim() });
    variables.push({ name: `type/${n}/size`, type: "FLOAT", value: trim(size) * 1 });
    variables.push({ name: `type/${n}/weight`, type: "FLOAT", value: v.fontWeight ?? 400 });
    if (v.lineHeight) variables.push({ name: `type/${n}/line-height`, type: "FLOAT", value: trim(px(v.lineHeight)) * 1 });
    if (v.letterSpacing) {
      const spacing = v.letterSpacing.unit === "em" ? v.letterSpacing.value * size : px(v.letterSpacing);
      variables.push({ name: `type/${n}/letter-spacing`, type: "FLOAT", value: trim(spacing) * 1 });
    }
  };
  take(color, state.colors);
  take(num("space"), state.spacing);
  take(num("radius"), state.rounded);
  take(type, state.typography);
  if (mode === "esp32") {
    take(color, state.colors, false);
    take(num("radius"), state.rounded, false);
  }
  return (
    JSON.stringify(
      {
        $comment: `Generated from DESIGN.md (${designName}) by design/tokens.mjs. Do not edit. Mode "${mode}": one Figma variable per entry; FLOAT values are px.`,
        mode,
        variables,
      },
      null,
      2,
    ) + "\n"
  );
}

// ---------------------------------------------------------------- run

/** Everything that is generated, as { path: text }. */
export function generate({ design, css: cssPath, figma }) {
  const { state } = readDesign(design);
  const designName = state.name ?? "DESIGN.md";
  const files = {};
  if (cssPath) files[resolve(cssPath)] = makeCss(state, designName);
  if (figma) for (const mode of MODES) files[resolve(figma, `figma-${mode}.json`)] = makeFigma(state, mode, designName);
  return files;
}

function parse(argv) {
  const options = { design: resolve(HERE, "..", "DESIGN.md"), css: null, figma: null, check: false, derive: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") options.check = true;
    else if (a === "--derive") options.derive = true;
    else if (a === "--css") options.css = argv[++i];
    else if (a === "--figma") options.figma = argv[++i];
    else if (a === "--design") options.design = resolve(argv[++i]);
    else throw new Error(`unknown option ${a}`);
  }
  return options;
}

function main() {
  const options = parse(process.argv.slice(2));

  // The CLI's own validation first: a DESIGN.md with an error produces nothing.
  const cli = fileURLToPath(import.meta.resolve("@google/design.md"));
  try {
    execFileSync(process.execPath, [cli, "lint", options.design, "--format", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    process.stderr.write(`DESIGN.md does not pass design.md lint:\n${error.stdout ?? ""}${error.stderr ?? ""}`);
    process.exit(1);
  }

  if (options.derive) {
    const { text, state } = readDesign(options.design);
    const next = deriveInto(text, state);
    if (next !== text) writeFileSync(options.design, next);
    console.log(next === text ? "accent-tint and accent-deep already match accent" : "rewrote accent-tint and accent-deep");
    return;
  }

  const files = generate(options);
  if (options.check) {
    const stale = Object.entries(files).filter(([path, text]) => !existsSync(path) || readFileSync(path, "utf8") !== text);
    if (stale.length) {
      process.stderr.write(`Out of date with DESIGN.md:\n${stale.map(([p]) => `  ${p}`).join("\n")}\nRun the design-tokens script and commit the result.\n`);
      process.exit(1);
    }
    console.log(`${Object.keys(files).length} generated file(s) match DESIGN.md`);
    return;
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    console.log(`wrote ${path}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
