// The team's panel: how Aule is used and what it costs, every family with its
// plan, and a plan granted for free. The platform decides who is on the team.

const $ = (id) => document.getElementById(id);
const PLANS = { trial: "Prueba", paid: "Pagado", granted: "Regalado", none: "Sin plan", team: "Equipo", free: "Gratis ilimitado" };

let families = [];

function say(text) {
  $("message").textContent = text;
  $("message").hidden = !text;
}

async function get(path) {
  const response = await fetch(path);
  if (response.status === 401 || response.status === 403) throw new Error("not_team");
  if (!response.ok) throw new Error("failed");
  return response.json();
}

async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("failed");
  return response.json();
}

function cell(text) {
  const element = document.createElement("td");
  element.textContent = text ?? "";
  return element;
}

const day = (iso) => (iso ? new Date(iso).toLocaleDateString("es-PE", { day: "numeric", month: "short" }) : "");
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
    figure("familias", families.length),
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

function planText(standing) {
  if (!standing) return "";
  const name = PLANS[standing.plan] ?? standing.plan;
  const until = standing.ends_at ? ` hasta ${day(standing.ends_at)}` : "";
  const left =
    standing.left == null || standing.plan === "none" ? "" : ` · quedan ${standing.left} de ${standing.allowed}`;
  return `${name}${until}${left}`;
}

async function grant(family) {
  const days = Number(window.prompt(`¿Cuántos días de plan regalar a ${family.name}?`, "30"));
  if (!Number.isInteger(days) || days < 1) return;
  const note = window.prompt("¿Por qué? (opcional: piloto, beca, equipo…)", "") ?? "";
  try {
    await post("api/admin/grant", { family_id: family.id, days, note });
    say("");
    await load();
  } catch {
    say("No se pudo regalar el plan. Inténtalo otra vez.");
  }
}

async function ungrant(family) {
  if (!window.confirm(`¿Quitar el plan regalado a ${family.name}?`)) return;
  try {
    await post("api/admin/ungrant", { family_id: family.id });
    say("");
    await load();
  } catch {
    say("No se pudo quitar el plan. Inténtalo otra vez.");
  }
}

function showFamilies() {
  const wanted = $("filter").value.trim().toLowerCase();
  const shown = families.filter(
    (family) => !wanted || `${family.name} ${family.emails ?? ""}`.toLowerCase().includes(wanted),
  );
  $("families").replaceChildren(
    ...shown.map((family) => {
      const line = document.createElement("tr");
      const actions = document.createElement("td");
      const give = document.createElement("button");
      give.type = "button";
      give.textContent = "Regalar plan";
      give.addEventListener("click", () => grant(family));
      actions.append(give);
      if (family.standing?.plan === "granted") {
        const take = document.createElement("button");
        take.type = "button";
        take.className = "quiet";
        take.textContent = "Quitar";
        take.addEventListener("click", () => ungrant(family));
        actions.append(take);
      }
      line.append(
        cell(family.name),
        cell(family.emails),
        cell(family.children),
        cell(planText(family.standing)),
        cell(family.sessions_7d),
        cell(family.sessions_30d),
        cell(family.minutes_30d),
        cell(day(family.last_session)),
        actions,
      );
      return line;
    }),
  );
  $("families-section").hidden = false;
}

async function load() {
  try {
    const [list, metrics] = await Promise.all([get("api/admin/families"), get("api/admin/metrics")]);
    families = list.families ?? [];
    showFamilies();
    showOverview(metrics);
  } catch (error) {
    say(
      error.message === "not_team"
        ? "Este panel es para el equipo de Aule. Entra con tu cuenta del equipo en la página de Aule."
        : "No se pudo cargar el panel. Recarga la página.",
    );
  }
}

$("filter").addEventListener("input", showFamilies);
load();
