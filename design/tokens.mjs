#!/usr/bin/env node
// Turns DESIGN.md into the files the products use, with @google/design.md
// (the same version in both repositories, pinned in package.json):
//   --css <file>     CSS variables of the `web` mode, for one product
//   --figma <dir>    variables for Figma, one file per mode (figma-<mode>.json)
//   --check          write nothing; fail if a generated file differs from what
//                    DESIGN.md says now (this is what CI runs)
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

/**
 * What a token is for, beyond its mode. Carried in the Figma files (`scope`) so that
 * a designer does not reach for them by accident. The Google ones are the one
 * exception to the palette and the letter: Google's brand, from its guide.
 */
export const SCOPES = {
  "playground-only": ["tile", "tile-ink", "board", "device-frame"],
  "interactive-web-only": ["surface-hover", "primary-hover", "secondary-hover", "link-hover", "danger-hover"],
  "third-party-google": ["google-border", "google-text"],
};
const scopeOf = (name) => Object.entries(SCOPES).find(([, names]) => names.includes(name))?.[0];

/** A token or component of Google's button: not Aule's CSS (Google draws it), only Figma's. */
export const isThirdParty = (name) => /^(google|button-google)(-|$)/.test(name);

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
  const web = (map) => [...map].map(([k, v]) => [k, v, modeOf(k)]).filter(([k, , m]) => m.mode === "web" && !isThirdParty(k));

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
  // The variants of every component: its background, text, type, radius, padding
  // and height, so that the CSS of a product never writes them by itself. A
  // button's border is its own background (the edge is there and does not show).
  for (const [name, def] of web(state.components)) {
    const p = def.properties;
    const prop = (suffix, value) => add(`c-${name}-${suffix}`, value);
    const bg = p.get("backgroundColor");
    if (bg?.type === "color") prop("bg", bg.hex);
    if (p.get("textColor")?.type === "color") prop("text", p.get("textColor").hex);
    const type = p.get("typography");
    if (type?.type === "typography") {
      prop("type", `${type.fontWeight ?? 400} ${css(type.fontSize)}${type.lineHeight ? `/${css(type.lineHeight)}` : ""} var(--aule-font-sans)`);
      if (type.letterSpacing) prop("tracking", css(type.letterSpacing));
    }
    if (p.get("rounded")?.type === "dimension") prop("radius", css(p.get("rounded")));
    if (p.get("padding")?.type === "dimension") prop("padding", css(p.get("padding")));
    if (p.get("height")?.type === "dimension") prop("height", css(p.get("height")));
    if (name.startsWith("button-") && bg?.type === "color" && !/-(hover|stroke)$/.test(name)) prop("border", bg.hex);
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
  // A colour with an alpha channel keeps its eight hex digits and also says the alpha.
  const color = (n, v) => {
    const entry = { name: `color/${n}`, type: "COLOR", value: v.hex };
    const scope = scopeOf(n);
    if (scope) entry.scope = scope;
    if (v.a !== undefined && v.a < 1) entry.alpha = Math.round(v.a * 1000) / 1000;
    variables.push(entry);
  };
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
  const options = { design: resolve(HERE, "..", "DESIGN.md"), css: null, figma: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") options.check = true;
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
