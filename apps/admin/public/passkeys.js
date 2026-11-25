// «Passkeys»: the passkeys the signed-in team member enters the console with.
// A name, then the browser's own dialog makes one; the platform checks it and
// keeps only its public half. Each one shows its name and dates, and can be
// deleted. The browser's WebAuthn JSON methods do the encoding, so the page
// needs no library; where they are missing, it says so and offers nothing.

import { $, cell, dialogName, get, post, say, signOutButton } from "./common.js";
import { dayTime, dayYear } from "./labels.js";

const MAX_PASSKEYS = 10;
const MAX_NAME = 60;

const WORDS = {
  created: "Listo: ya puedes entrar con esta passkey.",
  no_name: "Ponle un nombre a la passkey.",
  long_name: "El nombre tiene hasta 60 letras, en una línea.",
  sign_in_again:
    "Por seguridad, para crear una passkey tienes que haber entrado hace poco. Sal y vuelve a entrar, y créala enseguida.",
  not_made: "No se creó la passkey.",
  already_here: "Este dispositivo ya tiene una passkey tuya.",
  failed: "No se pudo crear la passkey. Inténtalo otra vez.",
  not_deleted: "No se pudo borrar la passkey. Inténtalo otra vez.",
  not_loaded: "No se pudieron cargar tus passkeys. Recarga la página.",
};

const supported =
  typeof PublicKeyCredential === "function" &&
  typeof PublicKeyCredential.parseCreationOptionsFromJSON === "function" &&
  typeof PublicKeyCredential.prototype?.toJSON === "function";

let count = 0;
let busy = false;

/** «Crear passkey» works while the browser can, nothing else is going on, and there is room for one more. */
function ready() {
  $("create").disabled = busy || !supported || count >= MAX_PASSKEYS;
  $("full").hidden = count < MAX_PASSKEYS;
}

/** The words for what went wrong: the console's answer, or the browser's. */
function failure(error) {
  if (error?.message === "sign_in_again") return WORDS.sign_in_again;
  // A cancel, a timeout or a device that could not verify the person.
  if (error?.name === "NotAllowedError") return WORDS.not_made;
  // The device already holds one of this member's passkeys.
  if (error?.name === "InvalidStateError") return WORDS.already_here;
  return WORDS.failed;
}

function row(passkey) {
  const line = document.createElement("tr");
  const actions = document.createElement("td");
  const erase = document.createElement("button");
  erase.type = "button";
  erase.textContent = "Borrar";
  erase.addEventListener("click", () => remove(passkey));
  actions.append(erase);
  line.append(cell(passkey.label), cell(dayYear(passkey.created_at)), cell(dayTime(passkey.last_used_at)), actions);
  return line;
}

async function load() {
  try {
    const answer = await get("/api/passkeys");
    const passkeys = Array.isArray(answer.passkeys) ? answer.passkeys : [];
    $("passkeys").replaceChildren(...passkeys.map(row));
    count = passkeys.length;
    $("none").hidden = count > 0;
    ready();
  } catch (error) {
    if (error.message !== "signed_out") say(WORDS.not_loaded);
  }
}

/** «Borrar», once confirmed. The device keeps its copy until the person deletes it there too. */
async function remove(passkey) {
  const asked = `¿Borrar la passkey ${dialogName(passkey.label)}? Ya no podrás entrar con ella. Bórrala también de tu dispositivo o de tu gestor de contraseñas.`;
  if (!window.confirm(asked)) return;
  say("", "done");
  try {
    await post(`/api/passkeys/${encodeURIComponent(passkey.id)}/delete`, {});
    say("");
    await load();
  } catch (error) {
    if (error.message !== "signed_out") say(WORDS.not_deleted);
  }
}

/** «Crear passkey»: the name, then the platform's options, the browser's dialog, and the passkey sent back. */
async function create(event) {
  event.preventDefault();
  if (!supported || busy || count >= MAX_PASSKEYS) return;
  say("");
  say("", "done");
  const name = $("label").value.trim();
  if (!name) return say(WORDS.no_name);
  if ([...name].length > MAX_NAME || /\p{Cc}/u.test(name)) return say(WORDS.long_name);
  busy = true;
  ready();
  try {
    const { publicKey } = await post("/api/passkeys/options", {});
    const credential = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(publicKey) });
    await post("/api/passkeys/create", { label: name, credential: credential.toJSON() });
    $("label").value = "";
    say(WORDS.created, "done");
    await load();
  } catch (error) {
    if (error?.message !== "signed_out") say(failure(error));
  } finally {
    busy = false;
    ready();
  }
}

signOutButton();
$("unsupported").hidden = supported;
ready();
$("create-form").addEventListener("submit", create);
load();
