// The words the console shows for the platform's codes, and its arithmetic of
// times (public/labels.js). Times are read in Lima, as the team reads them.
process.env.TZ = "America/Lima";

import assert from "node:assert/strict";
import { test } from "node:test";

import { NONE, STATUSES, ago, clock, clockSeconds, label, mode, since, verdict, way } from "../public/labels.js";

const AT = "2026-11-25T15:42:05Z"; // 10:42:05 in Lima
const minutesLater = (minutes) => Date.parse(AT) + minutes * 60_000;

test("a deploy can go only when the platform says, in so many words, that no session is open", () => {
  assert.deepEqual(verdict({ open: 0, starting: 0, overdue: 0, overdue_after_minutes: 70 }), {
    safe: true,
    text: "Ninguna sesión abierta: se puede desplegar.",
  });
  assert.deepEqual(verdict({ open: 1, overdue: 0, overdue_after_minutes: 70 }), { safe: false, text: "1 sesión abierta: no despliegues ahora." });
  assert.deepEqual(verdict({ open: 3, overdue: 0, overdue_after_minutes: 70 }), { safe: false, text: "3 sesiones abiertas: no despliegues ahora." });
  // An answer that says nothing, or nonsense, is never safe.
  for (const odd of [undefined, null, {}, { open: "0" }, { open: -1 }, { open: 0.5 }, { open: null }]) {
    const said = verdict(odd);
    assert.equal(said.safe, false, JSON.stringify(odd));
    assert.equal(said.text, "No se sabe si hay sesiones abiertas: no despliegues todavía.");
  }
});

test("sessions open too long are said apart, and still counted", () => {
  assert.equal(
    verdict({ open: 2, overdue: 1, overdue_after_minutes: 70 }).text,
    "2 sesiones abiertas: no despliegues ahora. 1 lleva más de 70 minutos: puede estar colgada; la limpieza la cierra a las 3 horas.",
  );
  assert.equal(
    verdict({ open: 2, overdue: 2, overdue_after_minutes: 80 }).text,
    "2 sesiones abiertas: no despliegues ahora. 2 llevan más de 80 minutos: pueden estar colgadas; la limpieza las cierra a las 3 horas.",
  );
  assert.equal(verdict({ open: 1, overdue: 1, overdue_after_minutes: 70 }).safe, false);
});

test("since when a session is open: the time, and how long ago", () => {
  assert.equal(clock(new Date(AT)), "10:42");
  assert.equal(clockSeconds(new Date(AT)), "10:42:05");
  assert.equal(ago(AT, minutesLater(0.5)), "hace un momento");
  assert.equal(ago(AT, minutesLater(12)), "hace 12 min");
  assert.equal(ago(AT, minutesLater(125)), "hace 2 h 5 min");
  // A clock a little behind the server's is not a session from the future.
  assert.equal(ago(AT, minutesLater(-2)), "hace un momento");
  assert.equal(since(AT, minutesLater(12)), "10:42, hace 12 min");
  for (const odd of [null, undefined, "", "ayer"]) assert.equal(since(odd, minutesLater(1)), NONE, String(odd));
});

test("a code is shown in words, as itself when there are none, and «—» when there is nothing", () => {
  assert.equal(label(STATUSES, "created"), "empezando");
  assert.equal(label(STATUSES, "active"), "en curso");
  assert.equal(label(STATUSES, "paused"), "paused");
  // A name every object has is no word of the table's.
  assert.equal(label(STATUSES, "constructor"), "constructor");
  assert.equal(label(STATUSES, "__proto__"), "__proto__");
  for (const nothing of [null, undefined, ""]) assert.equal(label(STATUSES, nothing), NONE);
  assert.deepEqual([mode(true), mode(false), way("device"), way("web"), way(undefined)], ["motor", "libre", "aparato", "web", "web"]);
});
