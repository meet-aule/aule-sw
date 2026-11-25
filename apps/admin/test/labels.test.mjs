// The words the console shows for the platform's codes, and its arithmetic of
// times (public/labels.js). Times are read in Lima, as the team reads them.
process.env.TZ = "America/Lima";

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ENDINGS,
  NONE,
  NOTICES,
  PLANS,
  STATUSES,
  age,
  ago,
  clock,
  clockSeconds,
  consentText,
  day,
  dayTime,
  dayYear,
  ending,
  grantedBy,
  label,
  length,
  mode,
  noticesBy,
  planDays,
  planText,
  since,
  trialText,
  verdict,
  way,
} from "../public/labels.js";

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

test("a plan in one line, as the panel has always said it", () => {
  assert.equal(planText({ plan: "granted", ends_at: "2026-12-23T15:00:00Z", left: 2, allowed: 3 }), "Regalado hasta 23 dic. · quedan 2 de 3");
  assert.equal(planText({ plan: "trial", ends_at: null, left: 1, allowed: 1 }), "Prueba · quedan 1 de 1");
  assert.equal(planText({ plan: "none", ends_at: "2026-11-23T15:00:00Z", left: 0, allowed: 0 }), "Sin plan hasta 23 nov.");
  assert.equal(planText({ plan: "team", ends_at: null, left: null, allowed: null }), "Equipo");
  assert.equal(planText({ plan: "free", ends_at: null, left: null, allowed: null }), "Gratis ilimitado");
  assert.equal(planText(undefined), "");
  assert.deepEqual(Object.keys(PLANS), ["trial", "paid", "granted", "none", "team", "free"]);
});

test("the trial's dates, and every plan's days and who gave it", () => {
  assert.equal(trialText({ started_at: "2026-11-08T15:00:00Z", ends_at: "2026-11-15T15:00:00Z" }), "Prueba: del 8 nov. 2026 al 15 nov. 2026.");
  assert.equal(trialText({ started_at: null, ends_at: null }), "Prueba: empieza con la primera sesión.");
  assert.equal(trialText(undefined), "Prueba: empieza con la primera sesión.");
  assert.equal(planDays({ starts_at: "2026-11-23T15:00:00Z", ends_at: "2026-12-23T15:00:00Z" }), "30");
  // A grant the team ended early shows the days it ran.
  assert.equal(planDays({ starts_at: "2026-11-23T15:00:00Z", ends_at: "2026-11-24T20:00:00Z" }), "1");
  assert.equal(planDays({ starts_at: null, ends_at: "x" }), NONE);
  assert.equal(grantedBy({ plan: "granted", granted_by: "team@example.org" }), "team@example.org");
  assert.equal(grantedBy({ plan: "granted", granted_by: null }), "operador");
  assert.equal(grantedBy({ plan: "paid", granted_by: null }), NONE);
});

test("what a consent says now, and how a guardian gets notices", () => {
  assert.equal(consentText({ granted: true, at: "2026-11-25T15:00:00Z", source: "app" }), "sí, 25 nov. (app)");
  assert.equal(consentText({ granted: false, at: "2026-11-25T15:00:00Z", source: "papel" }), "no, 25 nov. (papel)");
  // Never answered: not given.
  assert.equal(consentText({ granted: false, at: null, source: null }), "no");
  assert.equal(consentText(undefined), "no");
  assert.equal(consentText({ granted: "yes", at: "2026-11-25T15:00:00Z", source: null }), "no, 25 nov.");
  assert.equal(noticesBy({ notices_by_email: true, notices_by_push: true }), "correo y teléfono");
  assert.equal(noticesBy({ notices_by_email: true, notices_by_push: false }), "correo");
  assert.equal(noticesBy({ notices_by_email: false, notices_by_push: true }), "teléfono");
  assert.equal(noticesBy({ notices_by_email: false, notices_by_push: false }), "ninguno");
});

test("a session's length, how it ended, and a child's age", () => {
  assert.equal(length(1200), "20 min");
  assert.equal(length(89), "1 min");
  for (const unknown of [null, undefined, "1200", Number.NaN]) assert.equal(length(unknown), NONE, String(unknown));
  assert.equal(ending({ status: "ended", end_reason: "budget_reached" }), "se acabó el tiempo");
  assert.equal(ending({ status: "ended", end_reason: null }), NONE);
  assert.equal(ending({ status: "active", end_reason: null }), "en curso");
  assert.equal(ending({ status: "created", end_reason: null }), "empezando");
  // Every end reason the platform writes has its words (sessions.rs END_REASONS).
  assert.deepEqual(Object.keys(ENDINGS), ["child_ended", "idle", "budget_reached", "parent_ended", "device_offline", "not_working", "error", "provider_error"]);
  assert.deepEqual(Object.keys(NOTICES), ["session_summary", "attention", "session_stopped"]);
  assert.equal(age(10), "10 años");
  assert.equal(age(null), NONE);
});

test("dates in the team's own words", () => {
  assert.equal(day("2026-11-25T15:42:05Z"), "25 nov.");
  assert.equal(dayYear("2026-11-25T15:42:05Z"), "25 nov. 2026");
  assert.equal(dayTime("2026-11-25T15:42:05Z"), "25 nov., 10:42");
  for (const nothing of [null, undefined, "", "nunca"]) {
    assert.equal(day(nothing), "", String(nothing));
    assert.equal(dayTime(nothing), NONE, String(nothing));
  }
});
