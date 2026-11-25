// A family's page (public/family.html, family.js) run in a fake document: the
// id in the address checked before anything is asked, every section drawn as
// text, its sessions and notices a page at a time, and its plan granted or
// ended from the page.
process.env.TZ = "America/Lima";

import assert from "node:assert/strict";
import { test } from "node:test";

import { open, rows, settle, walk } from "./dom.mjs";

const ID = "01a1f5f4-ede7-7028-a524-9d8e2f36b92d";
const CURSOR = `1795619045123456_${ID}`;
const at = (day, time = "15:00:00") => `2026-11-${day}T${time}Z`;
const absent = { granted: false, at: null, source: null };
const FAMILY = {
  id: ID,
  name: "Quispe Mamani",
  source: "cesar",
  created_at: at("05"),
  guardians: [
    { name: "Rosa", email: "rosa@example.org", language: "es", created_at: at("05"), notices_by_email: true, notices_by_push: true },
    { name: "Jorge", email: "jorge@example.org", language: "en", created_at: at("06"), notices_by_email: true, notices_by_push: false },
  ],
  children: [
    {
      nickname: "Mateo",
      age: 10,
      grade: "P4",
      created_at: at("05"),
      consent: { voice: { granted: true, at: at("05"), source: "app" }, transcripts: absent, memory: { granted: true, at: at("06"), source: "papel" } },
    },
    { nickname: "Lucía", age: null, grade: null, created_at: at("07"), consent: { voice: { granted: false, at: at("09"), source: "app" }, transcripts: absent, memory: absent } },
  ],
  standing: { plan: "granted", ends_at: "2026-12-23T15:00:00Z", used: 1, allowed: 3, left: 2, period: "week" },
  trial: { started_at: at("08"), ends_at: at("15") },
  plans: [
    { plan: "granted", starts_at: at("23"), ends_at: "2026-12-23T15:00:00Z", note: "Pagó con Yape", granted_by: "team@example.org", created_at: at("23"), cancelled_at: null },
    { plan: "granted", starts_at: at("13"), ends_at: at("20"), note: null, granted_by: null, created_at: at("13"), cancelled_at: null },
    { plan: "paid", starts_at: at("01"), ends_at: at("10"), note: null, granted_by: null, created_at: at("01"), cancelled_at: null },
  ],
  sessions: { started: 25, last_started_at: at("25", "17:02:00"), open: 1 },
};
const SESSIONS = [
  { created_at: at("25", "17:02:00"), started_at: at("25", "17:02:20"), seconds: null, status: "active", end_reason: null, engine: true, via: "web", child: "Mateo", audience: "child" },
  { created_at: at("24", "15:00:00"), started_at: at("24", "15:00:20"), seconds: 1200, status: "ended", end_reason: "child_ended", engine: false, via: "device", child: "Lucía", audience: "child" },
  { created_at: at("23", "15:00:00"), started_at: null, seconds: null, status: "ended", end_reason: "device_offline", engine: false, via: "web", child: "Mateo", audience: "child" },
];
const NOTICES = [
  { kind: "session_summary", created_at: at("25", "16:37:00"), child: "Mateo", read_at: null, emailed_at: at("25", "16:38:00"), pushed_at: null },
  { kind: "attention", created_at: at("24", "07:07:00"), child: null, read_at: at("24", "08:07:00"), emailed_at: null, pushed_at: at("24", "07:08:00") },
];

/** The platform as the console passes it on: this family, its sessions and its notices. */
function platform(overrides = {}) {
  const answers = {
    [`/api/families/${ID}`]: { status: 200, body: FAMILY },
    [`/api/families/${ID}/sessions?limit=20`]: { status: 200, body: { sessions: SESSIONS, next: null } },
    [`/api/families/${ID}/notices?limit=20`]: { status: 200, body: { notices: NOTICES, next: null } },
    ...overrides,
  };
  return (path, init) => {
    if (init.method === "POST") return { status: 201, body: { plan: "granted" } };
    return answers[path] ?? { status: 404, body: { error: "not_found" } };
  };
}

test("an address that names no family's id is told so, and nothing is asked", async () => {
  for (const search of ["", "?id=", "?id=x", `?id=${ID.toUpperCase()}`, `?id=${ID}/sessions`, "?id=../../api/sessions/open", `?family=${ID}`]) {
    const opened = await open("family.html", "family.js", { search, answer: platform() });
    assert.deepEqual(opened.asked, [], search);
    assert.equal(opened.$("message").textContent, "Esa familia no existe.", search);
    assert.equal(opened.$("family").hidden, true, search);
  }
});

test("a family that is no longer there is told so", async () => {
  const opened = await open("family.html", "family.js", { search: `?id=${ID}`, answer: platform({ [`/api/families/${ID}`]: { status: 404, body: { error: "not_found" } } }) });
  assert.deepEqual(opened.asked.map(({ path }) => path), [`/api/families/${ID}`]);
  assert.equal(opened.$("message").textContent, "Esa familia ya no existe.");
  assert.equal(opened.$("family").hidden, true);
});

test("the page shows the family's adults, children and consents, plan and trial, sessions and notices", async () => {
  const opened = await open("family.html", "family.js", { search: `?id=${ID}`, answer: platform() });
  const { $ } = opened;
  assert.deepEqual(opened.asked.map(({ path }) => path), [`/api/families/${ID}`, `/api/families/${ID}/sessions?limit=20`, `/api/families/${ID}/notices?limit=20`]);
  assert.equal($("family").hidden, false);
  assert.equal($("family-name").textContent, "Quispe Mamani");
  assert.equal($("family-facts").textContent, "Enlace: cesar · Se registró el 5 nov. 2026");
  assert.deepEqual(rows($("guardians")), [
    ["Rosa", "rosa@example.org", "español", "correo y teléfono", "5 nov."],
    ["Jorge", "jorge@example.org", "inglés", "correo", "6 nov."],
  ]);
  assert.deepEqual(rows($("children")), [
    ["Mateo", "10 años", "P4", "sí, 5 nov. (app)", "no", "sí, 6 nov. (papel)", "5 nov."],
    ["Lucía", "—", "—", "no, 9 nov. (app)", "no", "no", "7 nov."],
  ]);
  assert.equal($("plan").textContent, "Regalado hasta 23 dic. · quedan 2 de 3");
  assert.equal($("trial").textContent, "Prueba: del 8 nov. 2026 al 15 nov. 2026.");
  assert.equal($("ungrant").hidden, false);
  assert.deepEqual(rows($("plans")), [
    ["Regalado", "23 nov.", "23 dic.", "30", "Pagó con Yape", "team@example.org"],
    ["Regalado", "13 nov.", "20 nov.", "7", "—", "operador"],
    ["Pagado", "1 nov.", "10 nov.", "9", "—", "—"],
  ]);
  assert.equal($("sessions-summary").textContent, "25 sesiones empezadas; la última el 25 nov., 12:02; 1 abierta ahora.");
  assert.deepEqual(rows($("sessions")), [
    ["25 nov., 12:02", "Mateo", "—", "en curso", "motor", "web"],
    ["24 nov., 10:00", "Lucía", "20 min", "la terminó el alumno", "libre", "aparato"],
    ["23 nov., 10:00", "Mateo", "—", "nadie entró o se desconectó", "libre", "web"],
  ]);
  assert.deepEqual(rows($("notices")), [
    ["25 nov., 11:37", "resumen de sesión", "Mateo", "—", "25 nov., 11:38", "—"],
    ["24 nov., 02:07", "atención", "—", "24 nov., 03:07", "—", "24 nov., 02:08"],
  ]);
  assert.equal($("more-sessions").hidden, true);
  assert.equal($("more-notices").hidden, true);
});

test("what the platform answers is drawn as text, never as HTML", async () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const family = {
    ...FAMILY,
    name: hostile,
    source: "<b>x</b>",
    guardians: [{ ...FAMILY.guardians[0], name: "<i>Rosa</i>", email: "<a href=x>r</a>@example.org", language: "<s>es</s>" }],
    children: [{ ...FAMILY.children[0], nickname: "<script>alert(2)</script>", grade: "<u>P4</u>", consent: { voice: { granted: true, at: at("05"), source: "<em>app</em>" } } }],
    plans: [{ ...FAMILY.plans[0], note: "</td><td>nota", granted_by: "<b>team</b>@example.org" }],
  };
  const opened = await open("family.html", "family.js", {
    search: `?id=${ID}`,
    answer: platform({
      [`/api/families/${ID}`]: { status: 200, body: family },
      [`/api/families/${ID}/sessions?limit=20`]: { status: 200, body: { sessions: [{ ...SESSIONS[1], child: "<b>Lucía</b>", end_reason: "<i>x</i>" }], next: null } },
      [`/api/families/${ID}/notices?limit=20`]: { status: 200, body: { notices: [{ ...NOTICES[0], kind: "<i>k</i>", child: "<b>M</b>" }], next: null } },
    }),
  });
  const { $ } = opened;
  assert.equal($("family-name").textContent, hostile);
  assert.equal($("family-facts").textContent, "Enlace: <b>x</b> · Se registró el 5 nov. 2026");
  assert.deepEqual(rows($("guardians"))[0].slice(0, 3), ["<i>Rosa</i>", "<a href=x>r</a>@example.org", "<s>es</s>"]);
  assert.deepEqual(rows($("children"))[0].slice(0, 4), ["<script>alert(2)</script>", "10 años", "<u>P4</u>", "sí, 5 nov. (<em>app</em>)"]);
  assert.deepEqual(rows($("plans"))[0].slice(4), ["</td><td>nota", "<b>team</b>@example.org"]);
  assert.deepEqual(rows($("sessions"))[0].slice(1, 4), ["<b>Lucía</b>", "20 min", "<i>x</i>"]);
  assert.deepEqual(rows($("notices"))[0].slice(1, 3), ["<i>k</i>", "<b>M</b>"]);
  for (const body of ["guardians", "children", "plans", "sessions", "notices"]) {
    const made = new Set([...walk($(body))].map((element) => element.tagName));
    assert.deepEqual([...made].sort(), ["TBODY", "TD", "TR"], body);
  }
});

test("«Más sesiones» and «Más avisos» bring the next pages under the first", async () => {
  const opened = await open("family.html", "family.js", {
    search: `?id=${ID}`,
    answer: platform({
      [`/api/families/${ID}/sessions?limit=20`]: { status: 200, body: { sessions: SESSIONS.slice(0, 2), next: CURSOR } },
      [`/api/families/${ID}/sessions?limit=20&before=${CURSOR}`]: { status: 200, body: { sessions: SESSIONS.slice(2), next: null } },
      [`/api/families/${ID}/notices?limit=20`]: { status: 200, body: { notices: NOTICES.slice(0, 1), next: CURSOR } },
      [`/api/families/${ID}/notices?limit=20&before=${CURSOR}`]: { status: 200, body: { notices: NOTICES.slice(1), next: null } },
    }),
  });
  const { $ } = opened;
  assert.equal($("more-sessions").hidden, false);
  assert.equal($("more-notices").hidden, false);
  await $("more-sessions").fire("click");
  await $("more-notices").fire("click");
  assert.equal(rows($("sessions")).length, 3);
  assert.equal(rows($("notices")).length, 2);
  assert.equal($("more-sessions").hidden, true);
  assert.equal($("more-notices").hidden, true);
});

test("a plan granted or ended from the page goes to this family, and the page shows it again", async () => {
  const opened = await open("family.html", "family.js", { search: `?id=${ID}`, answer: platform(), prompts: ["7", "beca"], confirms: [false, true] });
  const { $ } = opened;
  await $("grant").fire("click");
  // «Quitar» asks first; a no is a no.
  await $("ungrant").fire("click");
  await $("ungrant").fire("click");
  await settle();
  const writes = opened.asked.filter(({ method }) => method === "POST").map(({ path, body }) => [path, JSON.parse(body)]);
  assert.deepEqual(writes, [
    [`/api/families/${ID}/grant`, { days: 7, note: "beca" }],
    [`/api/families/${ID}/ungrant`, {}],
  ]);
  assert.equal(opened.asked.filter(({ path }) => path === `/api/families/${ID}`).length, 3, "the page after each write");
});
