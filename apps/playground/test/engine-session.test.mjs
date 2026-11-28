// A session the engine runs, as the page shows it: its route (D39) and the
// exercise on its card (D40). The page's own functions, run against a stand-in
// for the few elements they touch.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { count, t } from "../public/i18n.js";

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
  // The route's own words are the page's, as i18n.js says them: Spanish, the language the tests run in.
  const showRoute = runInNewContext(`${source("showRoute")}\nshowRoute`, { $: () => line, document, count, t });
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

// --- the card: the exercise Aule posed (D40) ---------------------------------

/** The card's functions with a stand-in board: `drawn` is every visual the board drew. */
function cardPage() {
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, { id, hidden: true, textContent: "", value: "" });
    return elements.get(id);
  };
  const drawn = [];
  const constant = (name) => {
    const found = app.match(new RegExp(`\\nconst ${name} = [^\\n]*;`))?.[0];
    assert.ok(found, name);
    return found;
  };
  const functions = ["shownAs", "posedCard", "aulePosed", "showCard", "presentCard", "boardToCard", "cardOwn", "displayVisual", "onVisual"].map(source);
  const page = runInNewContext(
    `let cardShown = "", cardOnScreen = null, cardWaiting = null, lately = [], posed = new Set(), trustCard = false;
    let progressiveBoard = null, inkMode = false, lastExercise = null, boardShows = null;
    ${constant("plain")}
    ${constant("LATELY_KEPT")}
    function showStage() {}
    function showInk() {}
    function draw(visual) {
      drawn.push(visual);
      $("board").hidden = false;
      boardShows = visual.kind;
    }
    ${functions.join("\n")}
    ({
      showCard,
      show: (visual) => onVisual({ readAll: async () => JSON.stringify(visual) }),
      // As onTranscription hands over a line of Aule's.
      say: (text) => aulePosed(\`words:\${plain(text)}\`),
      resumed: () => { trustCard = true; },
    })`,
    { $, drawn },
  );
  return {
    ...page,
    $,
    // Copies made here: a visual parsed in the page's context has that context's prototypes.
    get drawn() {
      return JSON.parse(JSON.stringify(drawn));
    },
    statement: () => ($("card").hidden ? null : $("card-statement").textContent),
  };
}

const PIZZA = {
  title: "Etapa 2: Refuerzo · Ejercicio 1 de 5",
  statement: "Ana comió 2/8 de una pizza y Beto comió 3/8. ¿Qué fracción de la pizza comieron entre los dos?",
  visual: null,
  asks_answer: true,
  asks_explanation: false,
};
// The engine's line that presents it carries its statement, wrapped to the screen's lines (card_line).
const PIZZA_SHOWN = { kind: "exercise", lines: ["Ana comió 2/8 de una pizza y Beto comió 3/8. ¿Qué", "fracción de la pizza comieron entre los dos?"] };
const CAKE = { ...PIZZA, title: "Etapa 2: Refuerzo · Ejercicio 2 de 5", statement: "Una torta se corta en 6 partes iguales. Si comes 2, ¿qué fracción comiste?" };
// What the tutor shows to explain a word, with other numbers (the engine's rules for talk).
const EXAMPLE = { kind: "exercise", lines: ["Por ejemplo: 4/10 = 2/5"] };

test("the engine's next exercise is not on the card until Aule poses it, and then the card shows it whole (D40)", async () => {
  const page = cardPage();
  page.showCard(PIZZA);
  assert.equal(page.statement(), null, "the engine reached it; Aule has not said it");
  await page.show(PIZZA_SHOWN);
  assert.equal(page.statement(), PIZZA.statement);
  assert.equal(page.$("card-title").textContent, PIZZA.title);
  assert.equal(page.$("answer").hidden, false);
  assert.deepEqual(page.drawn, [], "the card's words are not written on the board as well");
});

test("an exercise Aule showed before the page asked the engine is on the card as soon as the engine says it", async () => {
  const page = cardPage();
  await page.show(PIZZA_SHOWN);
  assert.deepEqual(page.drawn, [PIZZA_SHOWN], "with no card, the board shows it");
  page.showCard(PIZZA);
  assert.equal(page.statement(), PIZZA.statement);
  assert.equal(page.$("board").hidden, true, "the card has its words now");
});

test("while the engine's next exercise waits for Aule, the card keeps the one Aule posed, without its answer box", async () => {
  const page = cardPage();
  page.showCard(PIZZA);
  await page.show(PIZZA_SHOWN);
  page.showCard(CAKE);
  assert.equal(page.statement(), PIZZA.statement);
  assert.equal(page.$("answer").hidden, true, "a typed answer would be checked against the engine's next exercise");
  page.say(`¡Muy bien! ${CAKE.statement}`);
  assert.equal(page.statement(), CAKE.statement, "saying it poses it too");
  assert.equal(page.$("answer").hidden, false);
});

test("an exercise Aule shows that is not the card's is drawn next to the card, and the card's own brings the board back", async () => {
  const page = cardPage();
  page.showCard(PIZZA);
  await page.show(PIZZA_SHOWN);
  await page.show(EXAMPLE);
  assert.deepEqual(page.drawn, [EXAMPLE], "the tutor's example is on the board, where it was dropped before");
  assert.equal(page.statement(), PIZZA.statement, "the exercise in hand stays on the card");
  assert.equal(page.$("answer").hidden, false);
  // «¿Me repites?»: the engine says the statement again, with its words for the screen.
  await page.show(PIZZA_SHOWN);
  assert.equal(page.$("board").hidden, true, "the board goes back to the exercise in hand");
  assert.deepEqual(page.drawn, [EXAMPLE], "and the card's words are not written on it");
});

test("the card's drawing poses its exercise, whatever the order of its description's keys", async () => {
  const page = cardPage();
  const bars = { kind: "fraction_bars", fractions: [{ numerator: 3, denominator: 4, labelled: false }] };
  const card = { ...PIZZA, statement: "¿Qué fracción de la barra está sombreada?", visual: bars };
  page.showCard(card);
  assert.equal(page.statement(), null);
  await page.show({ fractions: [{ labelled: false, denominator: 4, numerator: 3 }], kind: "fraction_bars" });
  assert.equal(page.statement(), card.statement);
  assert.deepEqual(page.drawn, [bars], "the board draws it once, from the card");
});

test("a session carried on after a reload shows the card it is on, and the steps of one exercise never wait again", async () => {
  const page = cardPage();
  page.resumed();
  page.showCard(PIZZA);
  assert.equal(page.statement(), PIZZA.statement, "Aule posed it before the reload");
  page.showCard(CAKE);
  assert.equal(page.statement(), PIZZA.statement, "only the card it was on is taken on trust");
  // A guided example keeps its statement from one step to the next: the new step shows at once.
  const guided = cardPage();
  guided.showCard({ ...CAKE, title: "Paso 1 de 3" });
  guided.say(CAKE.statement);
  guided.showCard({ ...CAKE, title: "Paso 2 de 3" });
  assert.equal(guided.$("card-title").textContent, "Paso 2 de 3");
  guided.showCard(null);
  assert.equal(guided.statement(), null, "no card from the engine, no card on the screen");
});

test("Aule's lines, and only Aule's, reach the card; a session carried on after a reload trusts its card", () => {
  assert.match(source("onTranscription"), /\n  if \(!mine\) aulePosed\(`words:\$\{plain\(text\)\}`\);\n\}$/);
  assert.match(source("followSteps"), /stopSteps\(\);\s*trustCard = resumed;/);
  assert.match(source("join"), /followSteps\(session\.session_id, resumed\);/);
  // Nothing but the card's own words is kept off the board.
  assert.doesNotMatch(source("onVisual"), /\$\("card"\)\.hidden/);
});
