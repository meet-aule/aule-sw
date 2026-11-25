// «En vivo» (public/live.html, live.js) run in a fake document: the line that
// says whether a deploy can go, the table of who is in a session, what is
// drawn as text, and how it asks again.
process.env.TZ = "America/Lima";

import assert from "node:assert/strict";
import { test } from "node:test";

import { open, rows, settle, walk } from "./dom.mjs";

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const session = (more) => ({
  family_id: "01a1f5f4-ede7-7028-a524-9d8e2f36b92d",
  family: "Quispe",
  child: "Mateo",
  audience: "child",
  status: "active",
  created_at: minutesAgo(12),
  started_at: minutesAgo(11),
  engine: false,
  via: "web",
  overdue: false,
  ...more,
});
const live = (sessions, more = {}) => ({
  open: sessions.length,
  starting: sessions.filter((one) => one.status === "created").length,
  overdue: sessions.filter((one) => one.overdue).length,
  overdue_after_minutes: 70,
  more: false,
  sessions,
  ...more,
});
const answering = (body, status = 200) => () => ({ status, body });

test("with no session open, the line says a deploy can go, in ink", async () => {
  const page = await open("live.html", "live.js", { answer: answering(live([])) });
  assert.deepEqual(
    page.asked.map(({ path, method }) => `${method} ${path}`),
    ["GET /api/sessions/open"],
  );
  assert.equal(page.$("verdict").textContent, "Ninguna sesión abierta: se puede desplegar.");
  assert.equal(page.$("verdict").className, "verdict");
  assert.equal(page.$("verdict").hidden, false);
  assert.deepEqual(rows(page.$("sessions")), []);
  assert.match(page.$("updated").textContent, /^Actualizado a las \d\d:\d\d:\d\d$/);
  assert.equal(page.$("more").hidden, true);
});

test("open sessions say not to deploy, in red, and each one is a line of facts", async () => {
  const sessions = [
    session({ status: "created", started_at: null, created_at: minutesAgo(0.2), engine: true }),
    session({ family_id: null, family: null, child: null, audience: "operator", created_at: minutesAgo(3) }),
    session({ via: "device", child: "Lucía", created_at: minutesAgo(30) }),
    session({ overdue: true, created_at: minutesAgo(125) }),
  ];
  const page = await open("live.html", "live.js", { answer: answering(live(sessions)) });
  assert.equal(
    page.$("verdict").textContent,
    "4 sesiones abiertas: no despliegues ahora. 1 lleva más de 70 minutos: puede estar colgada; la limpieza la cierra a las 3 horas.",
  );
  assert.equal(page.$("verdict").className, "verdict danger");
  const drawn = rows(page.$("sessions"));
  assert.deepEqual(
    drawn.map(([family, child, , state, mode, way]) => [family, child, state, mode, way]),
    [
      ["Quispe", "Mateo", "empezando", "motor", "web"],
      ["prueba del equipo", "—", "en curso", "libre", "web"],
      ["Quispe", "Lucía", "en curso", "libre", "aparato"],
      ["Quispe", "Mateo", "en curso · ¿colgada?", "libre", "web"],
    ],
  );
  assert.match(drawn[0][2], /^\d\d:\d\d, hace un momento$/);
  assert.match(drawn[2][2], /^\d\d:\d\d, hace 30 min$/);
  assert.match(drawn[3][2], /^\d\d:\d\d, hace 2 h 5 min$/);
  assert.deepEqual(page.$("sessions").children.map((line) => line.className), ["", "", "", "overdue"]);
  // A family's name goes to its page; the team's test has no family to go to.
  const links = [...walk(page.$("sessions"))].filter((element) => element.tagName === "A");
  assert.deepEqual(
    links.map((link) => [link.href, link.textContent]),
    [0, 2, 3].map(() => ["/family?id=01a1f5f4-ede7-7028-a524-9d8e2f36b92d", "Quispe"]),
  );
  assert.equal(page.$("sessions").children[1].children[0].children.length, 0);
});

test("what the platform answers is drawn as text, never as HTML", async () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const page = await open("live.html", "live.js", {
    answer: answering(live([session({ family: hostile, child: "<script>alert(2)</script>", status: "<b>x</b>" })])),
  });
  const [line] = rows(page.$("sessions"));
  assert.equal(line[0], hostile);
  assert.equal(line[1], "<script>alert(2)</script>");
  assert.equal(line[3], "<b>x</b>");
  const made = [...walk(page.$("sessions"))].map((element) => element.tagName);
  assert.deepEqual([...new Set(made)].sort(), ["A", "TBODY", "TD", "TR"]);
  assert.equal(made.filter((tag) => tag === "A").length, 1, "the family's name, as a link's text");
});

test("more than 100 open: the newest are listed, and the page says so", async () => {
  const page = await open("live.html", "live.js", { answer: answering(live([session()], { open: 140, more: true })) });
  assert.equal(page.$("more").hidden, false);
  assert.match(page.$("verdict").textContent, /^140 sesiones abiertas/);
});

test("a failed answer takes the line away instead of leaving an older one standing", async () => {
  let next = { status: 200, body: live([]) };
  const page = await open("live.html", "live.js", { answer: () => next });
  assert.equal(page.$("verdict").textContent, "Ninguna sesión abierta: se puede desplegar.");
  for (const failure of [{ status: 502, body: { error: "platform" } }, { status: 500 }]) {
    next = { status: 200, body: live([]) };
    await page.$("refresh").fire("click");
    assert.equal(page.$("verdict").hidden, false);
    next = failure;
    await page.$("refresh").fire("click");
    assert.equal(page.$("verdict").hidden, true, JSON.stringify(failure));
    assert.equal(page.$("message").hidden, false);
    assert.equal(page.$("message").textContent, "No se pudo saber quién está en una sesión. Vuelve a intentarlo con «Actualizar».");
  }
  // An answer that does not say how many are open is no reason to deploy.
  next = { status: 200, body: { sessions: [] } };
  await page.$("refresh").fire("click");
  assert.equal(page.$("verdict").textContent, "No se sabe si hay sesiones abiertas: no despliegues todavía.");
  assert.equal(page.$("verdict").className, "verdict danger");
  // The next answer that comes brings the line back, and the message goes.
  next = { status: 200, body: live([session()]) };
  await page.$("refresh").fire("click");
  assert.equal(page.$("verdict").hidden, false);
  assert.equal(page.$("message").hidden, true);
});

test("an answer that comes late is dropped: only the latest question is drawn", async () => {
  const waiting = [];
  const page = await open("live.html", "live.js", {
    answer: () => new Promise((resolve) => waiting.push(resolve)),
  });
  // The first question (on load) is still unanswered; «Actualizar» asks again.
  const again = page.$("refresh").fire("click");
  await settle();
  assert.equal(waiting.length, 2);
  waiting[1]({ status: 200, body: live([session()]) });
  await again;
  waiting[0]({ status: 200, body: live([]) });
  await settle();
  assert.equal(page.$("verdict").textContent, "1 sesión abierta: no despliegues ahora.");
});

test("it asks again every 15 seconds while in view, at once back in view, and stops once signed out", async () => {
  let status = 200;
  const page = await open("live.html", "live.js", { answer: () => ({ status, body: live([]) }) });
  assert.equal(page.timers.length, 1);
  assert.equal(page.timers[0].ms, 15_000);
  page.timers[0].run();
  await settle();
  assert.equal(page.asked.length, 2);
  // Out of view, the timer asks nothing; back in view, it asks at once.
  page.document.visibilityState = "hidden";
  page.timers[0].run();
  await settle();
  assert.equal(page.asked.length, 2);
  page.document.visibilityState = "visible";
  await page.document.fire("visibilitychange");
  await settle();
  assert.equal(page.asked.length, 3);
  // Signed out: the sign-in page, and no more questions.
  status = 401;
  page.timers[0].run();
  await settle();
  assert.deepEqual(page.moves, ["/signin"]);
  assert.equal(page.timers[0].cleared, true);
});

test("a line older than 20 seconds gives way to «Comprobando…» while the next answer is on its way", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-25T15:00:00Z") });
  const waiting = [];
  let late = false;
  const page = await open("live.html", "live.js", {
    answer: () => (late ? new Promise((resolve) => waiting.push(resolve)) : { status: 200, body: live([]) }),
  });
  assert.equal(page.$("verdict").textContent, "Ninguna sesión abierta: se puede desplegar.");
  // Every 15 seconds in view, the line stays while the next answer comes: it is still fresh.
  late = true;
  t.mock.timers.tick(15_000);
  page.timers[0].run();
  await settle();
  assert.equal(page.$("verdict").hidden, false);
  // Back in view an hour later, the old «se puede desplegar» is gone before anything is answered.
  t.mock.timers.tick(60 * 60_000);
  page.document.visibilityState = "visible";
  page.document.fire("visibilitychange");
  await settle();
  assert.equal(page.$("verdict").hidden, true);
  assert.equal(page.$("updated").textContent, "Comprobando…");
  // The answer brings a line again, and the time it was drawn.
  waiting.at(-1)({ status: 200, body: live([session()]) });
  await settle();
  assert.equal(page.$("verdict").hidden, false);
  assert.equal(page.$("verdict").textContent, "1 sesión abierta: no despliegues ahora.");
  assert.match(page.$("updated").textContent, /^Actualizado a las \d\d:\d\d:\d\d$/);
  // A request that hangs: 20 seconds on, the next one takes the line away, and a failure says when the table is from.
  t.mock.timers.tick(21_000);
  page.timers[0].run();
  await settle();
  assert.equal(page.$("verdict").hidden, true);
  waiting.at(-1)({ status: 502, body: { error: "platform" } });
  await settle();
  assert.equal(page.$("verdict").hidden, true);
  assert.match(page.$("updated").textContent, /^Actualizado a las \d\d:\d\d:\d\d$/);
});

test("«Salir» ends the session and goes to the sign-in", async () => {
  const page = await open("live.html", "live.js", { answer: answering(live([])) });
  await page.$("signout").fire("click");
  assert.deepEqual(page.asked.at(-1), { path: "/api/signout", method: "POST", body: "{}" });
  assert.deepEqual(page.moves, ["/signin"]);
  assert.equal(page.$("signout").disabled, true);
});
