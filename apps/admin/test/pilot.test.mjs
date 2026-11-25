// The pilot's four numbers as the team's panel adds them up (public/pilot.js),
// from lines shaped like the platform's GET /v1/metrics/weekly.
import assert from "node:assert/strict";
import { test } from "node:test";

import { bySource, byWeek, childFigures, outOf, share, weekLabel, zoneLabel } from "../public/pilot.js";

const line = (week, source, families, started, week1_over, repeated, week4_over, week4, paying) => ({
  week,
  source,
  families,
  started,
  week1_over,
  repeated,
  week4_over,
  week4,
  paying,
});

const COHORTS = [
  line("2026-11-23", "pucp", 1, 0, 0, 0, 0, 0, 0),
  line("2026-11-23", null, 2, 1, 0, 0, 0, 0, 0),
  line("2026-11-23", "cesar", 3, 2, 1, 1, 0, 0, 0),
  line("2026-10-26", "cesar", 4, 3, 4, 2, 3, 2, 1),
  line("2026-11-02", null, 1, 1, 1, 1, 0, 0, 0),
];

test("each week adds up its links, newest first, with the links by name and the families without one last", () => {
  const weeks = byWeek(COHORTS);
  assert.deepEqual(
    weeks.map((week) => week.week),
    ["2026-11-23", "2026-11-02", "2026-10-26"],
  );
  assert.deepEqual(weeks[0].total, { families: 6, started: 3, week1_over: 1, repeated: 1, week4_over: 0, week4: 0, paying: 0 });
  assert.deepEqual(
    weeks[0].sources.map((one) => [one.source, one.families]),
    [
      ["cesar", 3],
      ["pucp", 1],
      [null, 2],
    ],
  );
  assert.deepEqual(weeks[2].total, { families: 4, started: 3, week1_over: 4, repeated: 2, week4_over: 3, week4: 2, paying: 1 });
});

test("a week whose families all came without a link has no lines under its total", () => {
  const [, november] = byWeek(COHORTS);
  assert.deepEqual(november.sources, []);
  assert.equal(november.total.families, 1);
});

test("each link adds up over the weeks, the one with most families first, and the families without one last", () => {
  assert.deepEqual(
    bySource(COHORTS).map((one) => [one.source, one.families, one.started, one.week1_over, one.repeated, one.week4_over, one.week4, one.paying]),
    [
      ["cesar", 7, 5, 5, 3, 3, 2, 1],
      ["pucp", 1, 0, 0, 0, 0, 0, 0],
      [null, 3, 2, 1, 1, 0, 0, 0],
    ],
  );
});

test("a line that is not what the platform sends counts as nothing", () => {
  assert.deepEqual(byWeek(null), []);
  assert.deepEqual(byWeek([{ source: "cesar", families: 2 }]), [], "no week");
  const [week] = byWeek([{ week: "2026-11-23", source: 7, families: "2", started: 1.5, paying: 1 }]);
  assert.deepEqual(week.total, { families: 0, started: 0, week1_over: 0, repeated: 0, week4_over: 0, week4: 0, paying: 1 });
  assert.deepEqual(week.sources, [], "a source that is not text is no link");
  assert.deepEqual(bySource(undefined), []);
});

test("a count reads with its share of the families, and a number that takes time out of those whose time is over", () => {
  assert.equal(share(3, 4), "3 (75 %)");
  assert.equal(share(1, 3), "1 (33 %)");
  assert.equal(share(0, 0), "0");
  assert.equal(outOf(2, 4), "2 de 4 (50 %)");
  assert.equal(outOf(0, 3), "0 de 3 (0 %)");
  assert.equal(outOf(0, 0), "—", "no family has got that far yet");
});

test("a week is named by its Monday, the same day wherever the panel is opened", () => {
  assert.match(weekLabel("2026-11-23"), /^Semana del 23 nov/);
  assert.match(weekLabel("2026-03-02"), /^Semana del 2 mar/);
  assert.equal(weekLabel("not a day"), "not a day");
});

test("the weeks are Peru's unless the platform counts them in another zone", () => {
  assert.equal(zoneLabel(-300), "en hora de Perú");
  assert.equal(zoneLabel(undefined), "en hora de Perú");
  assert.equal(zoneLabel(0), "en hora UTC+0");
  assert.equal(zoneLabel(-180), "en hora UTC−3");
  assert.equal(zoneLabel(330), "en hora UTC+5.5");
});

test("the children back within a week read out of those whose week is over, with all of them so far beside it", () => {
  const weekly = {
    children: { with_a_session: 3, week1_over: 2, back_in_week1: 1, back_so_far: 1 },
    talk: { median_child_turns_per_minute: 0.75, sessions: 2 },
  };
  assert.deepEqual(childFigures(weekly), [
    ["niños que volvieron en 7 días (hasta hoy: 1 de 3)", "1 de 2 (50 %)"],
    ["turnos del niño por minuto (mediana), en 2 sesiones", "0,8"],
  ]);
});

test("while no child's week is over the share is a dash, and so is a median the platform could not work out", () => {
  const early = {
    children: { with_a_session: 5, week1_over: 0, back_in_week1: 0, back_so_far: 2 },
    talk: { median_child_turns_per_minute: null, sessions: 0 },
  };
  assert.deepEqual(childFigures(early), [
    ["niños que volvieron en 7 días (hasta hoy: 2 de 5)", "—"],
    ["turnos del niño por minuto (mediana)", "—"],
  ]);
  // An answer from before these figures, or a broken one, counts as nothing.
  for (const answer of [{}, null, undefined, { children: { week1_over: "2", back_in_week1: -1 }, talk: { median_child_turns_per_minute: "0.9" } }]) {
    assert.deepEqual(childFigures(answer), [
      ["niños que volvieron en 7 días (hasta hoy: 0 de 0)", "—"],
      ["turnos del niño por minuto (mediana)", "—"],
    ], JSON.stringify(answer));
  }
});

test("one session is said in the singular", () => {
  assert.deepEqual(childFigures({ talk: { median_child_turns_per_minute: 1.2, sessions: 1 } })[1], ["turnos del niño por minuto (mediana), en 1 sesión", "1,2"]);
  assert.equal(childFigures({ talk: { median_child_turns_per_minute: 1.2, sessions: 2 } })[1][0], "turnos del niño por minuto (mediana), en 2 sesiones");
});

test("the median is written with Peru's decimal comma and one decimal", () => {
  const median = (value) => childFigures({ talk: { median_child_turns_per_minute: value, sessions: 8 } })[1][1];
  assert.equal(median(0.9), "0,9");
  assert.equal(median(1), "1,0");
  assert.equal(median(12.34), "12,3");
  assert.equal(median(0), "0,0");
  assert.equal(median(Number.NaN), "—");
  assert.equal(median(-1), "—");
});
