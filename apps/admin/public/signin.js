// The team's sign-in: an address, then the code that comes by mail, or a
// passkey, where the browser can use one. The page says the same whatever
// address is typed; the console sends a code only to one of the team's, and
// the platform checks the code or the passkey. Signed in, it goes to the
// panel, a fixed address: it takes no address to go back to.

import { credentialJSON } from "./credential.js";

const $ = (id) => document.getElementById(id);

const WORDS = {
  bad_email: "Escribe un correo válido.",
  bad_code: "El código tiene 6 números.",
  wrong_code: "El código no es correcto o ya venció.",
  too_many: "Demasiados intentos. Espera unos minutos.",
  passkey_failed: "No pudimos confirmar esa passkey. Entra con tu correo.",
  failed: "No se pudo. Inténtalo otra vez.",
};

// What the browser's own failure with a passkey means here.
const PASSKEY_WORDS = {
  // A cancel, a timeout, or no passkey for this console on the device.
  cancelled: "No se completó el ingreso con passkey. Si no tienes una aquí, entra con tu correo.",
  // This browser will not use one here, however often it is asked.
  blocked: "Este navegador no permitió usar la passkey aquí. Entra con tu correo.",
  // A password manager's credential the page or the console could not read.
  unreadable: "Tu gestor de contraseñas no pudo completar la passkey. Prueba con el llavero del navegador o entra con tu correo.",
};

const LEAD_WITH_PASSKEY = "Entra con tu passkey o con un código que te enviamos a tu correo del equipo.";

// The browser's own parser for the platform's options, which the passkey
// needs: no library. The answer's JSON has a way around a password manager
// that cannot write it (credential.js).
const passkeys = typeof PublicKeyCredential === "function" && typeof PublicKeyCredential.parseRequestOptionsFromJSON === "function";

let email = "";

// The words for an error the console answered with; any other is a failure.
const wordsFor = (error) => (Object.hasOwn(WORDS, error) ? WORDS[error] : WORDS.failed);

function say(text) {
  $("message").textContent = text;
  $("message").hidden = !text;
}

/** The status and the error code of a write, and a passkey's options; never anything else from the answer. */
async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const answer = await response.json().catch(() => ({}));
  const publicKey = typeof answer.publicKey === "object" && answer.publicKey !== null ? answer.publicKey : null;
  return { status: response.status, error: typeof answer.error === "string" ? answer.error : "", publicKey };
}

function busy(form, on) {
  for (const button of form.querySelectorAll("button")) button.disabled = on;
}

function showStep(step) {
  $("email-form").hidden = step !== "email";
  $("code-form").hidden = step !== "code";
  say("");
  $(step).focus();
}

$("email-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const typed = $("email").value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typed)) return say(WORDS.bad_email);
  busy($("email-form"), true);
  try {
    const { status, error } = await post("/api/signin/start", { email: typed });
    if (status === 202) {
      email = typed;
      $("code").value = "";
      return showStep("code");
    }
    say(wordsFor(error));
  } catch {
    say(WORDS.failed);
  } finally {
    busy($("email-form"), false);
  }
});

$("code-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = $("code").value.trim();
  if (!/^\d{6}$/.test(code)) return say(WORDS.bad_code);
  busy($("code-form"), true);
  try {
    const { status, error } = await post("/api/signin/verify", { email, code });
    if (status === 200) return location.replace("/");
    say(wordsFor(error));
  } catch {
    say(WORDS.failed);
  } finally {
    busy($("code-form"), false);
  }
});

$("again").addEventListener("click", () => showStep("email"));

/** The words for the browser's own failure with a passkey, or the page's; any other is a failure. */
function passkeyTrouble(error) {
  if (error?.name === "NotAllowedError") return PASSKEY_WORDS.cancelled;
  if (error?.name === "SecurityError") return PASSKEY_WORDS.blocked;
  if (error?.message === "unreadable") return PASSKEY_WORDS.unreadable;
  return WORDS.failed;
}

// «Entrar con passkey»: the console's options, the browser's own picker, and
// its answer back. No address is typed; the passkey says whose it is.
$("passkey-box").hidden = !passkeys;
if (passkeys) $("lead").textContent = LEAD_WITH_PASSKEY;
$("passkey").addEventListener("click", async () => {
  say("");
  $("passkey").disabled = true;
  try {
    const { status, error, publicKey } = await post("/api/signin/passkey/start", {});
    if (status !== 200 || !publicKey) return say(wordsFor(error));
    const credential = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(publicKey) });
    const finished = await post("/api/signin/passkey/finish", { credential: credentialJSON(credential) });
    if (finished.status === 200) return location.replace("/");
    // A 400 is an answer the console could not read: trying again gives the same.
    say(finished.status === 400 ? PASSKEY_WORDS.unreadable : wordsFor(finished.error));
  } catch (error) {
    say(passkeyTrouble(error));
  } finally {
    $("passkey").disabled = false;
  }
});
