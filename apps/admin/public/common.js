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
