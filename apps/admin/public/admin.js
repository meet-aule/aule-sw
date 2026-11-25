// The team's overview: how Aule is used and what it costs, how many families
// there are, and the pilot's four numbers. The families themselves, with
// their plans, are on «Familias». The console signs the team in; the platform
// decides who is on the team on every call.

import { $, cell, get, say, signOutButton } from "./common.js";
import { byWeek, bySource, childFigures, outOf, share, weekLabel, zoneLabel } from "./pilot.js";

// How many families there are, from the families list's count.
let familiesTotal = null;

const money = (value) => (typeof value === "number" ? value.toFixed(2) : "");

function figure(label, value) {
  const box = document.createElement("div");
  box.className = "figure";
  const strong = document.createElement("strong");
  strong.textContent = value;
  box.append(strong, label);
  return box;
}

function showOverview(metrics) {
  const days = metrics.days ?? [];
  const total = (pick) => days.reduce((sum, row) => sum + (pick(row) ?? 0), 0);
  $("figures").replaceChildren(
    figure("sesiones", total((row) => row.sessions?.started)),
    figure("minutos medidos", Math.round(total((row) => row.cost_usd?.minutes))),
    figure("USD en servicios", money(total((row) => row.cost_usd?.total))),
    figure("familias", Number.isInteger(familiesTotal) ? familiesTotal : "—"),
  );
  $("days").replaceChildren(
    ...days.map((row) => {
      const line = document.createElement("tr");
      line.append(
        cell(row.day),
        cell(row.sessions?.started ?? 0),
        cell(row.sessions?.students ?? 0),
        cell(row.cost_usd?.minutes ?? ""),
        cell(money(row.cost_usd?.total)),
        cell(money(row.cost_usd?.per_hour)),
      );
      return line;
    }),
  );
  $("overview").hidden = false;
}

// The pilot: a line per week with its total, and under it a line per link
// when its families came by more than one; then each link over all the weeks.
const NO_LINK = "sin enlace";

function pilotCells(line) {
  return [
    cell(line.families),
    cell(share(line.started, line.families)),
    cell(outOf(line.repeated, line.week1_over)),
    cell(outOf(line.week4, line.week4_over)),
    cell(outOf(line.paying, line.week1_over)),
  ];
}

function showPilot(weekly) {
  const cohorts = weekly.cohorts ?? [];
  $("pilot-zone").textContent = zoneLabel(weekly.timezone_offset_minutes);
  // The children back within a week, and how much a child talks in a session.
  $("pilot-figures").replaceChildren(...childFigures(weekly).map(([label, value]) => figure(label, value)));
  $("weeks").replaceChildren(
    ...byWeek(cohorts).flatMap((week) => {
      // A week whose families all came the same way names it on its own line.
      const [only, ...others] = week.sources;
      const split = others.length > 0;
      const total = document.createElement("tr");
      total.className = "week";
      const name = split ? "todos" : only ? (only.source ?? NO_LINK) : NO_LINK;
      total.append(cell(weekLabel(week.week)), cell(name, "code"), ...pilotCells(week.total));
      const lines = split ? week.sources : [];
      return [
        total,
        ...lines.map((line) => {
          const row = document.createElement("tr");
          row.append(cell(""), cell(line.source ?? NO_LINK, "code"), ...pilotCells(line));
          return row;
        }),
      ];
    }),
  );
  $("sources").replaceChildren(
    ...bySource(cohorts).map((line) => {
      const row = document.createElement("tr");
      row.append(cell(line.source ?? NO_LINK, "code"), ...pilotCells(line));
      return row;
    }),
  );
  pilotSays(cohorts.length ? "" : "Todavía no hay familias en estas semanas.");
  $("pilot").hidden = false;
}

function pilotSays(text) {
  $("pilot-message").textContent = text;
  $("pilot-message").hidden = !text;
}

// Which builds answer: the console's and the platform's, as their logs name them.
function showBuild(build) {
  const named = (name, part) => `${name} ${part?.version ?? "?"} (${(part?.commit ?? "?").slice(0, 7)})`;
  $("build").textContent = `${named("aule-admin", build.admin)} · ${named("aule-platform", build.platform)}`;
  $("build").hidden = false;
}

async function load() {
  try {
    // One family is enough to be told how many there are.
    const [list, metrics] = await Promise.all([get("/api/families?limit=1"), get("/api/metrics/daily")]);
    familiesTotal = list.total;
    showOverview(metrics);
  } catch (error) {
    if (error.message !== "signed_out") say("No se pudo cargar el panel. Recarga la página.");
    return;
  }
  // The pilot's numbers come on their own: without them the rest still shows.
  get("/api/metrics/weekly").then(showPilot, (error) => {
    if (error.message === "signed_out") return;
    pilotSays("No se pudieron cargar las cifras del piloto. Recarga la página.");
    $("pilot").hidden = false;
  });
  // The panel works without this line: a failure leaves it out.
  get("/api/build").then(showBuild, () => {});
}

signOutButton();
load();
