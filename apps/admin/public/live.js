// «En vivo»: who is in a session now, and the one line that says whether a
// deploy can go. It asks again every 15 seconds while the tab is in view, and
// at once when it comes back into view. A failed or late answer never leaves
// an older «se puede desplegar» standing, and neither does an old one: a line
// older than 20 seconds gives way to «Comprobando…» while the next is asked.

import { $, cell, familyLink, get, say, signOutButton } from "./common.js";
import { NONE, STATUSES, clockSeconds, label, mode, since, verdict, way } from "./labels.js";

const EVERY_MS = 15_000;
// Past this, the line on screen no longer says whether a deploy can go now.
const FRESH_MS = 20_000;
let timer;
// When the line on screen was drawn, and the time it says it was.
let shownAt = Number.NEGATIVE_INFINITY;
let updated = "";
// Only the answer to the latest request is drawn: an earlier one that comes
// late is dropped.
let asked = 0;

function row(session, now) {
  const line = document.createElement("tr");
  if (session.overdue) line.className = "overdue";
  const state = label(STATUSES, session.status) + (session.overdue ? " · ¿colgada?" : "");
  // A family's name links to its page; the team's own tests have no family.
  const family = document.createElement("td");
  family.append(
    session.family_id
      ? familyLink(session.family_id, session.family)
      : document.createTextNode(session.audience === "operator" ? "prueba del equipo" : NONE),
  );
  line.append(
    family,
    cell(session.child ?? NONE),
    cell(since(session.created_at, now)),
    cell(state),
    cell(mode(session.engine)),
    cell(way(session.via)),
  );
  return line;
}

function show(live) {
  const line = verdict(live);
  $("verdict").textContent = line.text;
  $("verdict").className = line.safe ? "verdict" : "verdict danger";
  $("verdict").hidden = false;
  const now = Date.now();
  const sessions = Array.isArray(live.sessions) ? live.sessions : [];
  $("sessions").replaceChildren(...sessions.map((session) => row(session, now)));
  $("more").hidden = live.more !== true;
  updated = `Actualizado a las ${clockSeconds(new Date())}`;
  $("updated").textContent = updated;
  shownAt = Date.now();
}

async function refresh() {
  const mine = ++asked;
  // Back in view after a while, or after an answer that never came: the old
  // line goes until the new one is drawn.
  if (Date.now() - shownAt > FRESH_MS) {
    $("verdict").hidden = true;
    $("updated").textContent = "Comprobando…";
  }
  try {
    const live = await get("/api/sessions/open");
    if (mine !== asked) return;
    say("");
    show(live);
  } catch (error) {
    if (mine !== asked) return;
    if (error.message === "signed_out") {
      clearInterval(timer);
      return;
    }
    $("verdict").hidden = true;
    $("updated").textContent = updated;
    say("No se pudo saber quién está en una sesión. Vuelve a intentarlo con «Actualizar».");
  }
}

const inView = () => document.visibilityState === "visible";

signOutButton();
$("refresh").addEventListener("click", refresh);
document.addEventListener("visibilitychange", () => {
  if (inView()) refresh();
});
timer = setInterval(() => {
  if (inView()) refresh();
}, EVERY_MS);
refresh();
