// «Passkeys»: the passkeys the signed-in team member enters the console with.
// A name, then the browser's own dialog makes one; the platform checks it and
// keeps only its public half. Each one shows its name and dates, and can be
// deleted. The browser's WebAuthn JSON methods do the encoding, so the page
// needs no library; where they are missing, it says so and offers nothing.

import { $, cell, dialogName, get, post, say, signOutButton } from "./common.js";
import { credentialJSON } from "./credential.js";
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
  blocked: "Este navegador no permitió crear la passkey aquí.",
  unreadable:
    "Tu gestor de contraseñas no pudo completar la passkey. Si la guardó, bórrala allí y prueba con el llavero del navegador.",
  failed: "No se pudo crear la passkey. Inténtalo otra vez.",
  left_behind: "Si tu dispositivo o tu gestor de contraseñas guardó una passkey de Aule que no está en esta lista, bórrala allí.",
  not_deleted: "No se pudo borrar la passkey. Inténtalo otra vez.",
  not_loaded: "No se pudieron cargar tus passkeys. Recarga la página.",
};

// The browser's own parser for the platform's options; the credential's JSON
// has a way around a password manager that cannot write it (credential.js).
const supported = typeof PublicKeyCredential === "function" && typeof PublicKeyCredential.parseCreationOptionsFromJSON === "function";

let count = 0;
let busy = false;

/** «Crear passkey» works while the browser can, nothing else is going on, and there is room for one more. */
function ready() {
  $("create").disabled = busy || !supported || count >= MAX_PASSKEYS;
  $("full").hidden = count < MAX_PASSKEYS;
}

/** The words for what went wrong, the console's answer or the browser's; `made` says whether the browser had made the passkey by then. */
function failure(error, made) {
  if (error?.message === "unreadable") return WORDS.unreadable;
  // A cancel, a timeout or a device that could not verify the person.
  if (error?.name === "NotAllowedError") return WORDS.not_made;
  // The device already holds one of this member's passkeys.
  if (error?.name === "InvalidStateError") return WORDS.already_here;
  // This browser will not make one here, however often it is asked.
  if (error?.name === "SecurityError") return WORDS.blocked;
  const said = error?.message === "sign_in_again" ? WORDS.sign_in_again : WORDS.failed;
  // The device may now keep a passkey the console never kept.
  return made ? `${said} ${WORDS.left_behind}` : said;
}

/** Whether the console surely did not keep the passkey: it refused it, or it never got it. */
const notKept = (error) => ["sign_in_again", "signed_out", "unreadable"].includes(error?.message) || error?.status === 400;

/**
 * Asks the browser to forget a passkey it has just made and the console did
 * not keep, where it can (signalUnknownCredential): otherwise the device
 * offers one that opens nothing. The words say to delete it in any case.
 */
function forget({ rpId, credential }) {
  try {
    if (typeof PublicKeyCredential.signalUnknownCredential !== "function" || typeof rpId !== "string") return;
    PublicKeyCredential.signalUnknownCredential({ rpId, credentialId: credential.id }).catch(() => {});
  } catch {
    // Nothing more the page can do.
  }
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
  // The passkey the browser made, once it has: from then on a failure may leave it on the device.
  let made = null;
  try {
    const { publicKey } = await post("/api/passkeys/options", {});
    const credential = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(publicKey) });
    made = { rpId: publicKey.rp?.id, credential };
    await post("/api/passkeys/create", { label: name, credential: credentialJSON(credential) });
    $("label").value = "";
    say(WORDS.created, "done");
    await load();
  } catch (error) {
    if (made && notKept(error)) forget(made);
    if (error?.message === "signed_out") return;
    say(failure(error, made !== null));
    // Whether it was kept after all, the list says.
    if (made) await load();
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
