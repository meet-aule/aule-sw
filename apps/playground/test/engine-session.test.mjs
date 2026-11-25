// A session the engine runs, as the page shows it: its route (D39). The page's
// own functions, run against a stand-in for the few elements they touch.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

/** A function of app.js, as written there. */
function source(name) {
  const found = app.match(new RegExp(`\\n(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(found, name);
  return found;
}

/** An element of the stand-in page: what it holds, its attributes and whether it is hidden. */
function element(tagName = "div") {
  return {
    tagName: tagName.toUpperCase(),
    className: "",
    hidden: false,
    attributes: {},
    nodes: [],
    set textContent(text) {
      this.nodes = [String(text)];
    },
    get textContent() {
      return this.nodes.map((node) => (typeof node === "string" ? node : node.textContent)).join("");
    },
    append(...nodes) {
      this.nodes.push(...nodes);
    },
    replaceChildren(...nodes) {
      this.nodes = nodes;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
  };
}

/** The words a person sees: none of a screen reader's own, nor of what is hidden from it. */
const seen = (node) =>
  typeof node === "string"
    ? node
    : node.className === "sr-only"
      ? ""
      : node.nodes.map(seen).join("");
/** The words a screen reader says: none of what is hidden from it. */
const said = (node) => (typeof node === "string" ? node : node.attributes["aria-hidden"] === "true" ? "" : node.nodes.map(said).join(""));
const dots = (node) => node.nodes.find((child) => child.className === "route-done")?.nodes.length ?? 0;

function route(stops) {
  const line = element("p");
  const document = { createElement: element };
  const showRoute = runInNewContext(`${source("showRoute")}\nshowRoute`, { $: () => line, document });
  showRoute(stops);
  return line;
}

const FIRST_SESSION = [
  { name: "Tamizaje", detail: "5 preguntas", state: "done" },
  { name: "Descubrimiento", detail: "Nivel 2", state: "done" },
  { name: "Refuerzo", detail: "Nivel 2", state: "current" },
  { name: "Descubrimiento", detail: "Nivel 3", state: "pending" },
  { name: "Refuerzo", detail: "Nivel 3", state: "pending" },
  { name: "Tarea", detail: "5 ejercicios", state: "pending" },
];

test("the route shows only the stop in hand, after a dot for each stop done, and nothing still to come (D39)", () => {
  const line = route(FIRST_SESSION);
  assert.equal(line.hidden, false);
  assert.equal(seen(line), "Refuerzo Nivel 2");
  assert.equal(dots(line), 2);
  for (const ahead of ["Nivel 3", "Tarea", "5 ejercicios"]) assert.ok(!line.textContent.includes(ahead), ahead);
  // A screen reader hears where the child is and how much is done, never what is left.
  assert.equal(said(line), "Ahora: Refuerzo Nivel 2. Ya hiciste 2 partes.");
});

test("the route's first stop has no dots, one stop done is said in the singular, and a stop without detail reads cleanly", () => {
  const first = route([{ name: "Tamizaje", detail: "5 preguntas", state: "current" }, ...FIRST_SESSION.slice(3)]);
  assert.equal(seen(first), "Tamizaje 5 preguntas");
  assert.equal(dots(first), 0);
  assert.equal(said(first), "Ahora: Tamizaje 5 preguntas.");
  const second = route([{ name: "Tamizaje", detail: "5 preguntas", state: "done" }, { name: "Descubrimiento", detail: "", state: "current" }]);
  assert.equal(said(second), "Ahora: Descubrimiento. Ya hiciste 1 parte.");
});

test("with no stop in hand the route hides and keeps nothing", () => {
  const before = route(FIRST_SESSION.slice(3).map((stop) => ({ ...stop })));
  assert.equal(before.hidden, true);
  assert.equal(before.textContent, "");
  assert.equal(route([]).hidden, true);
});

test("the route is one line of the session, not a list of every stop", () => {
  const session = html.slice(html.indexOf('<section class="screen" data-screen="session"'), html.indexOf('data-screen="session-end"'));
  assert.match(session, /<p id="route" class="route" hidden><\/p>/);
  assert.doesNotMatch(app, /ROUTE_STATE|aria-current", "step"/);
});
