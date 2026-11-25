// «Familias»: every family with its plan and the link it came from, found by
// a guardian's address or the family's name, and filtered by link and by plan,
// a page at a time. The filters live in the page's address, so a reload or
// Back keeps them; each value read from it is checked as the console checks
// it, and one that is no good is left out.

import { $, cell, familyLink, get, planButtons, say, signOutButton } from "./common.js";
import { PLANS, day, planText } from "./labels.js";

// As many as the console lets a page ask for.
const PAGE = 100;
const MAX_SEARCH = 100;
const SOURCE = /^[a-z][a-z0-9-]{0,23}$/;

let next = null;
let shown = 0;
// The filters the rows on screen were asked with: «Más familias» goes on with
// them, whatever has been typed since.
let current = { q: "", source: "", status: "" };
// Only the answer to the latest request is drawn.
let asked = 0;

const goodSearch = (text) => [...text].length <= MAX_SEARCH && !/\p{Cc}/u.test(text);

/** The filters the page's address holds, each kept only when it is one. */
function fromAddress() {
  const query = new URLSearchParams(location.search);
  const q = (query.get("q") ?? "").trim();
  const source = query.get("source") ?? "";
  const status = query.get("status") ?? "";
  return {
    q: goodSearch(q) ? q : "",
    source: SOURCE.test(source) ? source : "",
    status: Object.hasOwn(PLANS, status) ? status : "",
  };
}

const chosen = () => ({ q: $("q").value.trim(), source: $("source").value, status: $("status").value });

/** A query with the values that are set, written by URLSearchParams. */
function query(values) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) if (value) params.set(name, String(value));
  return params.toString();
}

/** One option per link, the most used first, keeping the chosen one even when no family has it any more. */
function showSources(sources, wanted) {
  const options = [["", "Todos los enlaces"]];
  for (const { source, families } of Array.isArray(sources) ? sources : []) {
    if (typeof source === "string" && SOURCE.test(source)) options.push([source, `${source} (${families})`]);
  }
  if (wanted && !options.some(([value]) => value === wanted)) options.push([wanted, wanted]);
  $("source").replaceChildren(
    ...options.map(([value, text]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      return option;
    }),
  );
  $("source").value = wanted;
}

function row(family) {
  const line = document.createElement("tr");
  const name = document.createElement("td");
  name.append(familyLink(family.id, family.name));
  const plan = cell(planText(family.standing));
  // After «Regalar plan» or «Quitar», this row alone shows the family's plan
  // as it is now: the other rows, the pages already loaded and the filters
  // stay as they were.
  const replan = async () => {
    try {
      const now = await get(`/api/families/${encodeURIComponent(family.id)}`);
      plan.textContent = planText(now.standing);
      actions.replaceChildren(...planButtons(family, now.standing, replan).childNodes);
    } catch (error) {
      if (error.message !== "signed_out") say("No se pudo mostrar el plan nuevo de la familia. Recarga la página.");
    }
  };
  const actions = planButtons(family, family.standing, replan);
  line.append(
    name,
    cell(family.source ?? "", "code"),
    cell(family.emails),
    cell(family.children),
    plan,
    cell(family.sessions_7d),
    cell(family.sessions_30d),
    cell(family.minutes_30d),
    cell(day(family.last_session)),
    actions,
  );
  return line;
}

function countText(total) {
  if (Number.isInteger(total)) {
    const found = total === 1 ? "1 familia" : `${total} familias`;
    return shown < total ? `${found} · se muestran ${shown}` : found;
  }
  // With a plan asked for, the platform looks at the families a page at a time.
  const listed = shown === 1 ? "1 familia" : `${shown} familias`;
  return next ? `${listed} con ese plan hasta ahora` : `${listed} con ese plan`;
}

/** The first page for the filters chosen, or the next one with `more`. */
async function load(more = false) {
  const values = more ? current : chosen();
  if (!more) {
    const written = query(values);
    history.replaceState(null, "", written ? `/families?${written}` : "/families");
  }
  const mine = ++asked;
  try {
    const answer = await get(`/api/families?${query({ ...values, limit: PAGE, before: more ? next : "" })}`);
    if (mine !== asked) return;
    current = values;
    const families = Array.isArray(answer.families) ? answer.families : [];
    if (more) $("families").append(...families.map(row));
    else $("families").replaceChildren(...families.map(row));
    shown = (more ? shown : 0) + families.length;
    next = typeof answer.next === "string" ? answer.next : null;
    showSources(answer.sources, values.source);
    $("count").textContent = countText(answer.total);
    // A search by plan can come back short and still have more to look at.
    $("more").textContent = values.status && families.length < PAGE ? "Seguir buscando" : "Más familias";
    $("more").hidden = next === null;
    say("");
  } catch (error) {
    if (mine !== asked || error.message === "signed_out") return;
    say("No se pudieron cargar las familias. Inténtalo otra vez.");
  }
}

const start = fromAddress();
$("q").value = start.q;
$("status").value = start.status;
showSources([], start.source);

signOutButton();
$("filters").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!goodSearch($("q").value.trim())) return say("La búsqueda tiene hasta 100 letras, en una línea.");
  return load();
});
$("source").addEventListener("change", () => load());
$("status").addEventListener("change", () => load());
$("more").addEventListener("click", () => load(true));
load();
