// What every page of the console shares: finding its elements, drawing a
// value as text, asking the console's API, and «Salir». A signed-out answer
// sends the page to the sign-in, a fixed address; nothing here takes an
// address from the request.

export const $ = (id) => document.getElementById(id);

/** A table cell that holds a value as text. */
export function cell(text, className) {
  const element = document.createElement("td");
  element.textContent = text ?? "";
  if (className) element.className = className;
  return element;
}

/** Says something in a message line, or hides it when there is nothing to say. */
export function say(text, id = "message") {
  $(id).textContent = text;
  $(id).hidden = !text;
}

// Signed out, or not on the team: the sign-in page, a fixed address.
function signedOut(response) {
  if (response.status !== 401 && response.status !== 403) return false;
  location.replace("/signin");
  return true;
}

/** What an API route answers. A failure is an error named signed_out, not_found or failed. */
export async function get(path) {
  const response = await fetch(path);
  if (signedOut(response)) throw new Error("signed_out");
  if (response.status === 404) throw new Error("not_found");
  if (!response.ok) throw new Error("failed");
  return response.json();
}

/** A write to the API, as JSON; the browser adds the page's Origin, which the console checks. */
export async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (signedOut(response)) throw new Error("signed_out");
  if (!response.ok) throw new Error("failed");
  return response.json();
}

/** A family's id as the platform writes it: only this goes into a link or an API path. */
export const FAMILY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A link to a family's page with its name as text, or the name alone when the id is not a family's. */
export function familyLink(id, name) {
  const text = name || "(sin nombre)";
  if (typeof id !== "string" || !FAMILY_ID.test(id)) return document.createTextNode(text);
  const link = document.createElement("a");
  link.href = `/family?id=${id}`;
  link.textContent = text;
  return link;
}

const grantPath = (id, action) => `/api/families/${encodeURIComponent(id)}/${action}`;

/**
 * A family's name as a dialog can hold it: one short line between quotes. A
 * family names itself at sign-up, so a line break, a control or direction
 * character, or a long run of words could otherwise make the dialog ask
 * something else.
 */
export function dialogName(name) {
  const line = String(name ?? "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const letters = [...line];
  const short = letters.length > 40 ? `${letters.slice(0, 40).join("").trimEnd()}…` : line;
  return `«${short || "sin nombre"}»`;
}

// Nobody can pay in the app yet, so the pilot's numbers count a plan granted
// after a family's trial as paid; the team is told so before granting one.
/** «Regalar plan»: asks for the days and why, grants it, then calls `done`. */
export async function grant(family, done) {
  const days = Number(
    window.prompt(
      `¿Cuántos días de plan regalar a ${dialogName(family.name)}?\n\nEn las cifras del piloto, un plan activado después de la prueba cuenta como pagado, aunque sea un regalo.`,
      "30",
    ),
  );
  if (!Number.isInteger(days) || days < 1) return;
  const note = window.prompt("¿Por qué? (opcional: pagó con Yape o Plin, beca, equipo…)", "") ?? "";
  try {
    await post(grantPath(family.id, "grant"), { days, note });
    say("");
    await done();
  } catch (error) {
    if (error.message !== "signed_out") say("No se pudo regalar el plan. Inténtalo otra vez.");
  }
}

/** «Quitar»: ends a granted plan once confirmed, then calls `done`. */
export async function ungrant(family, done) {
  if (!window.confirm(`¿Quitar el plan regalado a ${dialogName(family.name)}?`)) return;
  try {
    await post(grantPath(family.id, "ungrant"), {});
    say("");
    await done();
  } catch (error) {
    if (error.message !== "signed_out") say("No se pudo quitar el plan. Inténtalo otra vez.");
  }
}

/** A table row's «Regalar plan» and, on a granted plan, «Quitar». */
export function planButtons(family, standing, done) {
  const actions = document.createElement("td");
  const give = document.createElement("button");
  give.type = "button";
  give.textContent = "Regalar plan";
  give.addEventListener("click", () => grant(family, done));
  actions.append(give);
  if (standing?.plan === "granted") {
    const take = document.createElement("button");
    take.type = "button";
    take.className = "quiet";
    take.textContent = "Quitar";
    take.addEventListener("click", () => ungrant(family, done));
    actions.append(take);
  }
  return actions;
}

/** «Salir» in the header: the console's session ends, and its platform session with it. */
export function signOutButton() {
  const button = $("signout");
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await fetch("/api/signout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    } finally {
      location.replace("/signin");
    }
  });
}
