// The rules the page follows between the Figma's screens (public/steps.js).
// An .mjs test: tsc would refuse a typed import of the page's untyped module,
// and Node runs the server's .ts module it checks the objectives against.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DATED,
  KINDS,
  LIKES,
  REVIEW,
  SCREENS,
  SEGMENTS,
  codeDigits,
  defaultSubject,
  greeting,
  interestsFrom,
  kindKey,
  maskEmail,
  objectiveFor,
  planLine,
  progressAt,
} from "../public/steps.js";
import { objectiveFrom } from "../src/students.ts";
import { words } from "../public/first-steps.js";

const drawn = (id, flow) =>
  progressAt(id, flow)
    ?.map((part) => `${part.done}/${part.steps}${part.current ? "*" : ""}`)
    .join(" ") ?? "plain";

test("the progress has three named parts of 4, 4 and 2 steps, filled up to the step showing", () => {
  assert.deepEqual(
    SEGMENTS.map((part) => [part.name, part.steps]),
    [
      ["Tu cuenta", 4],
      ["Conocer a tu hijo (opcional)", 4],
      ["Su perfil", 2],
    ],
  );
  const expected = {
    p01: "1/4* 0/4 0/2",
    p02: "2/4* 0/4 0/2",
    p03: "3/4* 0/4 0/2",
    "p03-name": "3/4* 0/4 0/2",
    p04: "4/4* 0/4 0/2",
    p05: "4/4 1/4* 0/2",
    p06: "4/4 2/4* 0/2",
    "p06-grade": "4/4 3/4* 0/2",
    p07: "4/4 4/4* 0/2",
    "p10-name": "4/4 4/4 1/2*",
    p12: "4/4 4/4 2/2*",
  };
  for (const [id, parts] of Object.entries(expected)) assert.equal(drawn(id), parts, id);
  // Wherever there is progress, one part is the current one.
  for (const id of Object.keys(SCREENS)) {
    const parts = progressAt(id);
    if (parts) assert.equal(parts.filter((part) => part.current).length, 1, id);
  }
});

test("outside the onboarding, and for a family coming back, the header is the plain line", () => {
  for (const id of ["c01", "p13", "p14", "p15", "home", "editor"]) assert.equal(drawn(id), "plain", id);
  for (const id of ["p02", "p03", "p03-name"]) assert.equal(drawn(id, "back"), "plain", `${id} coming back`);
  assert.equal(drawn("p04", "back"), "4/4* 0/4 0/2", "adding a child is onboarding, whoever starts it");
});

test("each tile of A04 asks for its kind, «No lo sé» for nothing and the link for a review, and the server takes them all", () => {
  assert.deepEqual(
    KINDS.map((tile) => [tile.kind, tile.key, tile.icon]),
    [
      ["homework", "kind_homework", "task_alt"],
      ["exam_prep", "kind_exam_prep", "assignment"],
      ["explore", "kind_explore", "school"],
      ["", "kind_none", "help_outline"],
    ],
  );
  // Their words are first-steps.js's, the Figma's in Spanish, and in English too.
  assert.equal(words(KINDS[3].key, "es"), "No lo sé");
  assert.equal(words(REVIEW.key, "es"), "Revisar una evaluación que ya di");
  for (const tile of [...KINDS, REVIEW]) {
    assert.ok(words(tile.key, "es") && words(tile.key, "en") && words(tile.key, "es") !== words(tile.key, "en"), tile.key);
  }
  assert.equal(objectiveFor(""), null, "«No lo sé» leaves the session to Aule");
  assert.equal(REVIEW.kind, "exam_review");
  for (const kind of ["homework", "exam_prep", "explore", REVIEW.kind]) {
    const objective = objectiveFor(kind, { subject: "matematica", topic: " fracciones ", due: "2026-11-27" });
    assert.equal(objective.kind, kind);
    assert.equal(objective.topic, "fracciones");
    assert.deepEqual(objectiveFrom(objective), objective, `${kind} passes the server's check`);
    assert.ok(words(kindKey(kind), "es") && words(kindKey(kind), "en"), `${kind} has words for its details`);
  }
  assert.deepEqual(objectiveFrom(objectiveFor("explore")), { kind: "explore", subject: "other", topic: "", due: null });
});

test("a day goes only with homework and evaluations", () => {
  assert.deepEqual(DATED, ["homework", "exam_prep"]);
  const due = "2026-11-27";
  assert.equal(objectiveFor("homework", { due }).due, due);
  assert.equal(objectiveFor("exam_prep", { due }).due, due);
  assert.equal(objectiveFor("explore", { due }).due, null);
  assert.equal(objectiveFor("exam_review", { due }).due, null);
  assert.equal(objectiveFor("homework", { due: "" }).due, null);
});

test("a session starts on a subject the family wants, Matemática first, then the first the platform keeps, then «other»", () => {
  const kept = ["matematica", "comunicacion", "ciencia"];
  assert.equal(defaultSubject(["comunicacion", "matematica"], kept), "matematica");
  assert.equal(defaultSubject(["comunicacion", "ciencia"], kept), "comunicacion");
  assert.equal(defaultSubject(["latin"], kept), "matematica");
  assert.equal(defaultSubject([], ["ciencia", "ingles"]), "ciencia");
  assert.equal(defaultSubject(null, null), "other");
});

test("what a child likes is what was picked and typed, in lower case, without repeats, ten at most of 40 letters each", () => {
  assert.deepEqual(LIKES, ["Deportes", "Videojuegos", "Animales y naturaleza", "Espacio y ciencia", "Música y arte", "Libros e historias"]);
  assert.deepEqual(interestsFrom(["Deportes", "Espacio y ciencia"], " Dinosaurios, cocinar; ajedrez, deportes ").interests, [
    "deportes",
    "espacio y ciencia",
    "dinosaurios",
    "cocinar",
    "ajedrez",
  ]);
  assert.deepEqual(interestsFrom([], " , ;").interests, [], "nothing chosen is fine");
  assert.equal(interestsFrom(LIKES, "a, b, c, d").interests.length, 10);
  assert.deepEqual(interestsFrom(LIKES, "a, b, c, d, e"), { error: "too_many" });
  assert.deepEqual(interestsFrom([], "x".repeat(41)), { error: "too_long" });
});

test("an address is shown with only its first two letters", () => {
  assert.equal(maskEmail("nombre@correo.com"), "no•••@correo.com");
  assert.equal(maskEmail("a@b.co"), "a•••@b.co");
  assert.equal(maskEmail("no address"), "");
});

test("a pasted code keeps its six digits", () => {
  for (const pasted of ["519 042", "519-042", " 5 1 9 0 4 2 ", "519042"]) assert.equal(codeDigits(pasted), "519042", pasted);
  assert.equal(codeDigits("51a9b04c2"), "519042", "letters are dropped");
  assert.equal(codeDigits("5190427"), "519042", "a seventh digit is cut");
});

test("the plan line: free access is open with no number in both languages, and a used day or an ended trial is closed", () => {
  for (const [lang, text] of [
    ["es", "Acceso gratuito: sesiones sin límite."],
    ["en", "Free access: unlimited sessions."],
  ]) {
    const free = planLine({ plan: "free", left: null, allowed: null, ends_at: null }, lang);
    assert.equal(free.open, true);
    assert.equal(free.text, text);
  }
  const now = Date.parse("2026-11-23T12:00:00Z");
  assert.deepEqual(planLine({ plan: "trial", ends_at: "2026-11-28T12:00:00Z", left: 1 }, "es", now), {
    text: "Prueba gratis: te quedan 5 días, y hoy tienes tu sesión.",
    open: true,
  });
  assert.equal(planLine({ plan: "trial", ends_at: "2026-11-24T12:00:00Z", left: 0 }, "es", now).open, false);
  assert.equal(planLine({ plan: "none", left: 0 }).open, false);
  assert.deepEqual(planLine(null), { text: "", open: true });
});

test("the plan line says the plan in its own words: «el plan Aule», S/59 al mes, 3 sesiones cada 7 días, 7 días gratis", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  const price = { amount_cents: 5900, currency: "PEN", sessions_per_week: 3 };
  assert.deepEqual(planLine({ plan: "trial", ends_at: null, left: 1, price }, "es", now), {
    text: "Tu prueba: 7 días gratis desde la primera sesión, una sesión al día, sin tarjeta.",
    open: true,
  });
  // Paid or activated by the team after writing in, it is the same plan: nobody can pay in the app yet.
  for (const kind of ["paid", "granted"]) {
    const line = planLine({ plan: kind, ends_at: "2026-12-20T12:00:00Z", left: 2, allowed: 3, price }, "es", now);
    assert.equal(line.open, true);
    assert.match(line.text, /^El plan Aule hasta el 20 de diciembre: te quedan 2 sesiones de 3 en estos 7 días\.$/, kind);
    assert.doesNotMatch(line.text, /regalado/);
  }
  const used = planLine({ plan: "granted", ends_at: "2026-12-20T12:00:00Z", left: 0, allowed: 3, price }, "es", now);
  assert.equal(used.open, false);
  assert.match(used.text, /ya usaste las 3 sesiones de estos 7 días; cada una vuelve a los 7 días de usarla\.$/);
  // After the trial: how to go on, the way it works today.
  assert.deepEqual(planLine({ plan: "none", left: 0, allowed: 0, price }, "es", now), {
    text: "Tu prueba gratis terminó. Para seguir, escríbenos a admin@meetaule.com y te activamos el plan Aule: S/59 al mes, 3 sesiones cada 7 días. Todavía no se puede pagar desde la app.",
    open: false,
  });
  assert.doesNotMatch(planLine({ plan: "none", left: 0 }).text, /suscrib|por semana|pronto/i);
});

test("P13 welcomes back only a browser that signed in before", () => {
  assert.equal(greeting(true), "¡Qué bueno que estés de vuelta!");
  assert.equal(greeting(false), "Te damos la bienvenida");
});

test("every screen has its surface, a way back that exists, and the Figma nodes it follows", () => {
  for (const [id, screen] of Object.entries(SCREENS)) {
    assert.ok(["paper", "ink"].includes(screen.surface), id);
    assert.ok(["in", "out"].includes(screen.auth), id);
    if (screen.back) assert.ok(screen.back in SCREENS, `${id} goes back to ${screen.back}`);
    assert.ok(screen.nodes.length > 0 && screen.nodes.every((node) => /^\d+:\d+$/.test(node)), id);
  }
});

test("a signed-out visit starts at C01, which has no way back: C00 was retired on 24 Nov", () => {
  assert.ok(!("c00" in SCREENS) && !("c00-student" in SCREENS));
  assert.equal(SCREENS.c01.back, null);
  assert.equal(SCREENS.p13.back, "c01", "P13's «← Atrás» still reaches C01");
  // Nothing leads back to a screen that is gone.
  for (const [id, screen] of Object.entries(SCREENS)) assert.ok(!String(screen.back).startsWith("c00"), id);
});

test("a02, the hand-off, is the device's A02 on ink: no progress, it needs the child handed over, and it goes back to P12", () => {
  const { a02 } = SCREENS;
  assert.equal(a02.code, "A02");
  assert.deepEqual(a02.nodes, ["410:629"]);
  assert.equal(a02.surface, "ink");
  assert.equal(a02.auth, "in");
  assert.equal(a02.progress, null);
  assert.equal(drawn("a02"), "plain");
  assert.equal(a02.needs, "handoff");
  assert.equal(a02.back, "p12");
});
