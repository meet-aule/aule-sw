// A family's page: its adults, its children with what each kind of consent
// says now, its plan with the trial and every plan it has had, its sessions
// and the notices it was sent. Never what was said: the platform does not
// send it. The family is the one in the page's address, checked to be a
// family's id before anything is asked.

import { $, FAMILY_ID, cell, get, grant, say, signOutButton, ungrant } from "./common.js";
import {
  CONSENTS,
  LANGUAGES,
  NONE,
  NOTICES,
  PLANS,
  age,
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
  trialText,
  way,
} from "./labels.js";

const PAGE = 20;
const id = new URLSearchParams(location.search).get("id") ?? "";

const line = (...cells) => {
  const row = document.createElement("tr");
  row.append(...cells);
  return row;
};

/** A list a page at a time: its rows drawn by `draw`, and its «Más» button while there are more. */
function paged(path, list, body, button, draw) {
  let next = null;
  let asking = false;
  async function more(first = false) {
    if (asking) return;
    asking = true;
    $(button).disabled = true;
    try {
      const params = new URLSearchParams({ limit: String(PAGE) });
      if (!first && next) params.set("before", next);
      const answer = await get(`${path}?${params}`);
      const rows = Array.isArray(answer[list]) ? answer[list].map(draw) : [];
      if (first) $(body).replaceChildren(...rows);
      else $(body).append(...rows);
      next = typeof answer.next === "string" ? answer.next : null;
      $(button).hidden = next === null;
    } catch (error) {
      if (error.message !== "signed_out") say("No se pudo cargar todo. Recarga la página.");
    } finally {
      asking = false;
      $(button).disabled = false;
    }
  }
  $(button).addEventListener("click", () => more());
  return more;
}

function show(family) {
  $("family-name").textContent = family.name;
  const facts = [family.source ? `Enlace: ${family.source}` : "Sin enlace", `Se registró el ${dayYear(family.created_at)}`];
  $("family-facts").textContent = facts.join(" · ");
  $("guardians").replaceChildren(
    ...(family.guardians ?? []).map((guardian) =>
      line(cell(guardian.name), cell(guardian.email), cell(label(LANGUAGES, guardian.language)), cell(noticesBy(guardian)), cell(day(guardian.created_at))),
    ),
  );
  $("children").replaceChildren(
    ...(family.children ?? []).map((child) =>
      line(
        cell(child.nickname),
        cell(age(child.age)),
        cell(child.grade ?? NONE),
        ...Object.keys(CONSENTS).map((purpose) => cell(consentText(child.consent?.[purpose]))),
        cell(day(child.created_at)),
      ),
    ),
  );
  $("plan").textContent = planText(family.standing);
  $("trial").textContent = trialText(family.trial);
  $("ungrant").hidden = family.standing?.plan !== "granted";
  $("plans").replaceChildren(
    ...(family.plans ?? []).map((plan) =>
      line(cell(label(PLANS, plan.plan)), cell(day(plan.starts_at)), cell(day(plan.ends_at)), cell(planDays(plan)), cell(plan.note ?? NONE), cell(grantedBy(plan))),
    ),
  );
  const sessions = family.sessions ?? {};
  const started = sessions.started === 1 ? "1 sesión empezada" : `${sessions.started ?? 0} sesiones empezadas`;
  const last = sessions.last_started_at ? `; la última el ${dayTime(sessions.last_started_at)}` : "";
  const open = sessions.open > 0 ? `; ${sessions.open} abierta${sessions.open === 1 ? "" : "s"} ahora` : "";
  $("sessions-summary").textContent = `${started}${last}${open}.`;
  $("family").hidden = false;
}

let family = null;

/** The family's page, drawn; false when there is none to draw. */
async function load() {
  try {
    const answer = await get(`/api/families/${id}`);
    show(answer);
    family = { id, name: answer.name };
    return true;
  } catch (error) {
    if (error.message === "not_found") say("Esa familia ya no existe.");
    else if (error.message !== "signed_out") say("No se pudo cargar la familia. Recarga la página.");
    return false;
  }
}

signOutButton();
if (!FAMILY_ID.test(id)) {
  say("Esa familia no existe.");
} else {
  const sessions = paged(`/api/families/${id}/sessions`, "sessions", "sessions", "more-sessions", (session) =>
    line(cell(dayTime(session.created_at)), cell(session.child), cell(length(session.seconds)), cell(ending(session)), cell(mode(session.engine)), cell(way(session.via))),
  );
  const notices = paged(`/api/families/${id}/notices`, "notices", "notices", "more-notices", (notice) =>
    line(cell(dayTime(notice.created_at)), cell(label(NOTICES, notice.kind)), cell(notice.child ?? NONE), cell(dayTime(notice.read_at)), cell(dayTime(notice.emailed_at)), cell(dayTime(notice.pushed_at))),
  );
  // Granting and ending a plan here works as on «Familias»; the page then shows the plan as it is.
  $("grant").addEventListener("click", () => family && grant(family, load));
  $("ungrant").addEventListener("click", () => family && ungrant(family, load));
  load().then((found) => found && Promise.all([sessions(true), notices(true)]));
}
