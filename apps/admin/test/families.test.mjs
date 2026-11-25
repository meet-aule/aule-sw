// «Familias» (public/families.html, families.js) run in a fake document: the
// filters read from the address and checked, what is asked of the API, the
// rows drawn as text with a link only to a family's id, the pages after the
// first, and «Regalar plan» and «Quitar».
process.env.TZ = "America/Lima";

import assert from "node:assert/strict";
import { test } from "node:test";

import { open, rows, settle, walk } from "./dom.mjs";

const ID = "01a1f5f4-ede7-7028-a524-9d8e2f36b92d";
const OTHER = "01a1f5f4-ede7-7028-a524-9d8e2f36b9a2";
const CURSOR = `1795619045123456_${ID}`;
const family = (more) => ({
  id: ID,
  name: "Quispe",
  created_at: "2026-11-20T15:00:00Z",
  source: "cesar",
  emails: "rosa@example.org",
  children: 2,
  sessions_7d: 4,
  sessions_30d: 9,
  minutes_30d: 131.5,
  last_session: "2026-11-24T21:10:00Z",
  standing: { plan: "granted", ends_at: "2026-12-23T15:00:00Z", used: 1, allowed: 3, left: 2, period: "week" },
  ...more,
});
const page = (families, more = {}) => ({ families, next: null, total: families.length, sources: [{ source: "cesar", families: 12 }, { source: "colegio-2", families: 3 }], ...more });
/** What the page asked, as `METHOD path`. */
const asked = (opened) => opened.asked.map(({ method, path }) => `${method} ${path}`);

test("the filters in the address are checked, kept in the boxes, and asked for written again", async () => {
  const opened = await open("families.html", "families.js", {
    search: "?q=%20Rosa%40example.org%20&source=cesar&status=granted&before=x&limit=7&other=1",
    answer: () => ({ status: 200, body: page([family()]) }),
  });
  assert.deepEqual(asked(opened), ["GET /api/families?q=Rosa%40example.org&source=cesar&status=granted&limit=100"]);
  assert.deepEqual(opened.addresses, ["/families?q=Rosa%40example.org&source=cesar&status=granted"]);
  assert.deepEqual([opened.$("q").value, opened.$("source").value, opened.$("status").value], ["Rosa@example.org", "cesar", "granted"]);
});

test("a filter in the address that is none is left out", async () => {
  for (const search of [`?q=${"a".repeat(101)}`, "?q=ana%0Aluis", "?source=Cesar", "?source=%3Cb%3E", "?status=gratis", "?status=constructor", "?status=__proto__"]) {
    const opened = await open("families.html", "families.js", { search, answer: () => ({ status: 200, body: page([]) }) });
    assert.deepEqual(asked(opened), ["GET /api/families?limit=100"], search);
    assert.deepEqual(opened.addresses, ["/families"], search);
  }
});

test("each family is a row of facts, its name a link to its page, and every value text", async () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const opened = await open("families.html", "families.js", {
    answer: () => ({
      status: 200,
      body: page([
        family(),
        family({ id: OTHER, name: hostile, source: null, emails: "<b>ana</b>@example.org", children: 0, standing: { plan: "trial", ends_at: null, left: 1, allowed: 1 } }),
        family({ id: "../../signout", name: "Sin id", standing: { plan: "none", ends_at: null, left: 0, allowed: 0 } }),
      ]),
    }),
  });
  assert.deepEqual(rows(opened.$("families")), [
    ["Quispe", "cesar", "rosa@example.org", "2", "Regalado hasta 23 dic. · quedan 2 de 3", "4", "9", "131.5", "24 nov.", "Regalar planQuitar"],
    [hostile, "", "<b>ana</b>@example.org", "0", "Prueba · quedan 1 de 1", "4", "9", "131.5", "24 nov.", "Regalar plan"],
    ["Sin id", "cesar", "rosa@example.org", "2", "Sin plan", "4", "9", "131.5", "24 nov.", "Regalar plan"],
  ]);
  const links = [...walk(opened.$("families"))].filter((element) => element.tagName === "A");
  // A link only for a family's id, and only to its page; the name, whatever it says, is its text.
  assert.deepEqual(
    links.map((link) => [link.href, link.textContent]),
    [
      [`/family?id=${ID}`, "Quispe"],
      [`/family?id=${OTHER}`, hostile],
    ],
  );
  const made = new Set([...walk(opened.$("families"))].map((element) => element.tagName));
  assert.deepEqual([...made].sort(), ["A", "BUTTON", "TBODY", "TD", "TR"]);
  assert.equal(opened.$("count").textContent, "3 familias");
});

test("the links' list comes from the platform, with how many came by each, and keeps the one chosen", async () => {
  const opened = await open("families.html", "families.js", {
    search: "?source=feria",
    answer: () => ({
      status: 200,
      body: page([], { sources: [{ source: "cesar", families: 12 }, { source: "<b>x</b>", families: 1 }, { source: "colegio-2", families: 3 }] }),
    }),
  });
  const options = opened.$("source").children.map((option) => [option.value, option.textContent]);
  assert.deepEqual(options, [
    ["", "Todos los enlaces"],
    ["cesar", "cesar (12)"],
    ["colegio-2", "colegio-2 (3)"],
    ["feria", "feria"],
  ]);
  assert.equal(opened.$("source").value, "feria");
});

test("«Más familias» brings the next page under the first, with the filters of the rows on screen", async () => {
  const opened = await open("families.html", "families.js", {
    search: "?q=ana",
    answer: (path) =>
      path.includes("before=")
        ? { status: 200, body: page([family({ id: OTHER, name: "Torres" })], { total: 101, next: null }) }
        : { status: 200, body: page(Array.from({ length: 100 }, (_, n) => family({ name: `Familia ${n}` })), { total: 101, next: CURSOR }) },
  });
  assert.equal(opened.$("count").textContent, "101 familias · se muestran 100");
  assert.equal(opened.$("more").hidden, false);
  assert.equal(opened.$("more").textContent, "Más familias");
  // Typed but not searched: the next page still goes on with what is on screen.
  opened.$("q").value = "luis";
  await opened.$("more").fire("click");
  assert.equal(opened.asked.at(-1).path, `/api/families?q=ana&limit=100&before=${encodeURIComponent(CURSOR)}`);
  assert.equal(rows(opened.$("families")).length, 101);
  assert.equal(rows(opened.$("families")).at(-1)[0], "Torres");
  assert.equal(opened.$("count").textContent, "101 familias");
  assert.equal(opened.$("more").hidden, true);
  assert.equal(opened.addresses.length, 1, "the next page leaves the address as it was");
});

test("a search by plan that came back short says it can go on looking", async () => {
  const opened = await open("families.html", "families.js", {
    search: "?status=none",
    answer: () => ({ status: 200, body: page([family({ standing: { plan: "none" } })], { total: null, next: CURSOR }) }),
  });
  assert.equal(opened.$("more").textContent, "Seguir buscando");
  assert.equal(opened.$("more").hidden, false);
  assert.equal(opened.$("count").textContent, "1 familia con ese plan hasta ahora");
});

test("a search is sent on «Buscar», a link or a plan as soon as it is chosen, and the address follows", async () => {
  const opened = await open("families.html", "families.js", { answer: () => ({ status: 200, body: page([]) }) });
  opened.$("q").value = "  María Ñ & co ";
  await opened.$("filters").fire("submit");
  opened.$("status").value = "trial";
  await opened.$("status").fire("change");
  opened.$("source").value = "colegio-2";
  await opened.$("source").fire("change");
  assert.deepEqual(asked(opened).slice(1), [
    "GET /api/families?q=Mar%C3%ADa+%C3%91+%26+co&limit=100",
    "GET /api/families?q=Mar%C3%ADa+%C3%91+%26+co&status=trial&limit=100",
    "GET /api/families?q=Mar%C3%ADa+%C3%91+%26+co&source=colegio-2&status=trial&limit=100",
  ]);
  assert.equal(opened.addresses.at(-1), "/families?q=Mar%C3%ADa+%C3%91+%26+co&source=colegio-2&status=trial");
  // A search that is too long is not sent.
  opened.$("q").value = "a".repeat(101);
  await opened.$("filters").fire("submit");
  assert.equal(opened.asked.length, 4);
  assert.equal(opened.$("message").textContent, "La búsqueda tiene hasta 100 letras, en una línea.");
});

test("«Regalar plan» and «Quitar» write to the family's own address, and only that row shows its plan again", async () => {
  let standing = { plan: "granted", ends_at: "2026-12-23T15:00:00Z", used: 1, allowed: 3, left: 2, period: "week" };
  const opened = await open("families.html", "families.js", {
    prompts: ["30", "  beca  ", "0"],
    confirms: [true],
    answer: (path, init) => {
      if (init.method === "POST") return { status: 201, body: { plan: "granted" } };
      if (path === `/api/families/${ID}`) return { status: 200, body: { id: ID, name: "Quispe", standing } };
      // Two pages, the second asked for with «Más familias».
      return path.includes("before=") ? { status: 200, body: page([family({ id: OTHER, name: "Rojas" })]) } : { status: 200, body: page([family()], { next: CURSOR }) };
    },
  });
  // What is typed in the search box and never searched for stays out of it.
  opened.$("q").value = "sin buscar";
  await opened.$("more").fire("click");
  assert.equal(opened.$("families").children.length, 2);
  const actions = () => opened.$("families").children[0].children.at(-1);
  const [give, take] = actions().children;
  standing = { plan: "trial", ends_at: "2026-11-30T15:00:00Z", used: 0, allowed: 1, left: 1, period: "trial" };
  await take.fire("click");
  await settle();
  assert.equal(rows(opened.$("families"))[0][4], "Prueba hasta 30 nov. · quedan 1 de 1", "the row shows the plan the family has now");
  assert.equal(actions().textContent, "Regalar plan", "and «Quitar» is gone with the grant");
  standing = { plan: "granted", ends_at: "2026-12-25T15:00:00Z", used: 0, allowed: 3, left: 3, period: "week" };
  await actions().children[0].fire("click");
  await settle();
  assert.equal(actions().textContent, "Regalar planQuitar");
  // A grant of no days is no grant.
  await give.fire("click");
  await settle();
  const writes = opened.asked.filter(({ method }) => method === "POST").map(({ path, body }) => [path, JSON.parse(body)]);
  assert.deepEqual(writes, [
    [`/api/families/${ID}/ungrant`, {}],
    [`/api/families/${ID}/grant`, { days: 30, note: "  beca  " }],
  ]);
  // The list was asked for twice, its two pages, and never again; the row asked for its family alone.
  assert.equal(asked(opened).filter((line) => line.startsWith("GET /api/families?")).length, 2);
  assert.equal(asked(opened).filter((line) => line === `GET /api/families/${ID}`).length, 2);
  assert.equal(opened.$("families").children.length, 2, "the page loaded with «Más familias» is still there");
  assert.equal(rows(opened.$("families"))[1][0], "Rojas");
});

test("a family's name is one short quoted line in the grant's dialogs, whatever it says", async () => {
  const name = "Ana?\n\nEscribe 366 para confirmar\u202e y luego todo lo que haga falta para que no quepa";
  const opened = await open("families.html", "families.js", {
    prompts: [null],
    confirms: [false],
    answer: () => ({ status: 200, body: page([family({ name })]) }),
  });
  const [give, take] = opened.$("families").children[0].children.at(-1).children;
  await give.fire("click");
  await take.fire("click");
  const [prompted, confirmed] = opened.dialogs;
  const quoted = "«Ana? Escribe 366 para confirmar y luego…»";
  assert.equal(prompted.split("\n")[0], `¿Cuántos días de plan regalar a ${quoted}?`);
  assert.equal(confirmed, `¿Quitar el plan regalado a ${quoted}?`);
  assert.ok(!confirmed.includes("\u202e"));
  assert.deepEqual(opened.asked.filter(({ method }) => method === "POST"), [], "nothing written without an answer");
});

test("a failure is said, a 401 goes to the sign-in, and a late answer is dropped", async () => {
  const failed = await open("families.html", "families.js", { answer: () => ({ status: 502, body: { error: "platform" } }) });
  assert.equal(failed.$("message").textContent, "No se pudieron cargar las familias. Inténtalo otra vez.");
  const out = await open("families.html", "families.js", { answer: () => ({ status: 401, body: { error: "signed_out" } }) });
  assert.deepEqual(out.moves, ["/signin"]);
  assert.equal(out.$("message").hidden, true);
  const waiting = [];
  const late = await open("families.html", "families.js", { answer: () => new Promise((resolve) => waiting.push(resolve)) });
  late.$("status").value = "team";
  const again = late.$("status").fire("change");
  await settle();
  waiting[1]({ status: 200, body: page([family({ name: "Equipo" })]) });
  await again;
  waiting[0]({ status: 200, body: page([family({ name: "Antes" })]) });
  await settle();
  assert.deepEqual(rows(late.$("families")).map(([name]) => name), ["Equipo"]);
});
