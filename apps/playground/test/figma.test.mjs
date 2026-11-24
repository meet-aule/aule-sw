// The code says which Figma frame each screen follows (Code Connect is not on
// the team's plan, so the comments, steps.js and FIGMA.md are the map). These
// keep the three in step.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { FIGMA_FILE, SCREENS } from "../public/steps.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const html = await read("../public/index.html");
const css = await read("../public/style.css");
const map = await read("../FIGMA.md");

// Each screen's section, with the comment right before it (if there is one).
const all = [...html.matchAll(/<section\b[^>]*\bdata-screen="([^"]+)"/g)].map(([, id]) => id);
const commented = new Map(
  [...html.matchAll(/<!--\s*Figma:((?:(?!-->)[\s\S])*)-->\s*<section\b[^>]*\bdata-screen="([^"]+)"/g)].map(([, comment, id]) => [
    id,
    comment.trim(),
  ]),
);

test("every screen in the page names its Figma frame, or says it is web-only and what it is built from", () => {
  for (const id of all) {
    const comment = commented.get(id);
    assert.ok(comment, `${id} has a <!-- Figma: … --> comment right before it`);
    assert.match(comment, /\d+:\d+/, `${id} names a node`);
    assert.ok(/\b[CPA]\d{2}\b/.test(comment) || /web-only/.test(comment), `${id}: ${comment}`);
  }
});

test("the page's screens and steps.js's table are the same, with the same nodes and surfaces", () => {
  assert.deepEqual([...all].sort(), Object.keys(SCREENS).sort());
  for (const id of all) {
    const screen = SCREENS[id];
    const comment = commented.get(id);
    for (const node of screen.nodes) assert.ok(comment.includes(node), `${id}'s comment names ${node}`);
    if (screen.code) assert.ok(comment.startsWith(screen.code), `${id}'s comment starts with ${screen.code}`);
    else assert.match(comment, /^web-only/, id);
    assert.match(html, new RegExp(`data-screen="${id}" data-surface="${screen.surface}"`), `${id} is on ${screen.surface}`);
  }
});

// Every Vigente screen of v8: the parent's on 160:1345, the student's on 190:717.
const CODES = [
  "C00",
  "C01",
  ...Array.from({ length: 15 }, (_, i) => `P${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 15 }, (_, i) => `A${String(i + 1).padStart(2, "0")}`),
];
// The v8 components the page draws, with their variants.
const COMPONENTS = {
  "Encabezado/Base": ["160:1348", "160:1349", "160:1352"],
  "Barra de progreso/Base": ["160:1415", "160:1416"],
  "Pregunta/Base": ["161:2101"],
  "Campo/Línea": ["160:1355", "160:1356", "160:1362", "160:1368"],
  "Opción/Grande": ["160:1374", "160:1375", "160:1379", "160:1384", "160:1388"],
  "Botón/Principal": ["160:1392", "160:1393", "160:1395"],
  "Casilla/Base": ["160:1397", "160:1398", "160:1401"],
  "Dígito/Base": ["160:1405", "160:1406", "160:1408", "160:1410"],
  "Enlace/Base": ["161:2096"],
  "Acción/Pequeña": ["161:2104"],
  "Fila/Alumno": ["161:2110"],
  "Botón/Google": ["168:991"],
  "Cuadro/Opción": ["190:806", "190:822", "190:825"],
  "Botón/Negro": ["190:834", "190:835", "190:838"],
  "Botón/Micrófono": ["193:709", "193:705", "193:708"],
  "Botón/Compacto": ["191:1396"],
  "Campo/Línea · Aparato": ["191:1333"],
  "Íconos · Aparato": ["190:995"],
};
const ICONS = {
  check: "191:1398",
  mic: "191:1401",
  mic_off: "191:1404",
  videocam: "191:1407",
  videocam_off: "191:1410",
  task_alt: "191:1413",
  assignment: "191:1415",
  school: "191:1418",
  help_outline: "191:1421",
};
const VARIABLES = ["3:4", "3:5", "3:6", "3:7", "3:8", "3:9", "162:427", "162:430", "90:698", "90:699"];

test("FIGMA.md names the file, every Vigente screen, every component, token and icon", () => {
  assert.ok(map.includes(FIGMA_FILE));
  for (const page of ["160:1345", "190:717"]) assert.ok(map.includes(page), page);
  for (const code of CODES) assert.match(map, new RegExp(`\\b${code}\\b`), code);
  for (const [name, ids] of Object.entries(COMPONENTS)) {
    assert.ok(map.includes(name), name);
    for (const id of ids) assert.ok(map.includes(id), `${name} ${id}`);
  }
  for (const [name, id] of Object.entries(ICONS)) assert.ok(map.includes(name) && map.includes(id), name);
  for (const variable of VARIABLES) assert.ok(map.includes(variable), variable);
  for (const id of Object.keys(SCREENS)) assert.ok(map.includes(`\`${id}\``), `FIGMA.md maps ${id}`);
});

test("the stylesheet names the Figma component above its rules, and each token's variable", () => {
  for (const [name, [id]] of Object.entries(COMPONENTS)) assert.ok(css.includes(id), `${name} ${id}`);
  for (const variable of VARIABLES) assert.ok(css.includes(`VariableID:${variable}`), variable);
  for (const [name, id] of Object.entries(ICONS)) {
    assert.ok(css.includes(`Ícono/${name} ${id}`), name);
    assert.match(css, new RegExp(`\\.icon\\[data-icon="${name}"\\]`), name);
  }
});
