// The team's sign-in: an address, then the code that comes by mail, or a
// passkey, where the browser can use one. The page says the same whatever
// address is typed; the console sends a code only to one of the team's, and
// the platform checks the code or the passkey. Signed in, it goes to the
// panel, a fixed address: it takes no address to go back to.

const $ = (id) => document.getElementById(id);

const WORDS = {
  bad_email: "Escribe un correo válido.",
  bad_code: "El código tiene 6 números.",
  wrong_code: "El código no es correcto o ya venció.",
  too_many: "Demasiados intentos. Espera unos minutos.",
  passkey_failed: "No pudimos confirmar esa passkey. Entra con tu correo.",
  passkey_cancelled: "No se completó la passkey. Inténtalo otra vez o entra con tu correo.",
  failed: "No se pudo. Inténtalo otra vez.",
};

// The browser's own WebAuthn JSON methods, which the passkey needs: no library.
const passkeys =
  typeof PublicKeyCredential === "function" &&
  typeof PublicKeyCredential.parseRequestOptionsFromJSON === "function" &&
  typeof PublicKeyCredential.prototype?.toJSON === "function";

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

// «Entrar con passkey»: the console's options, the browser's own picker, and
// its answer back. No address is typed; the passkey says whose it is.
$("passkey-box").hidden = !passkeys;
$("passkey").addEventListener("click", async () => {
  say("");
  $("passkey").disabled = true;
  try {
    const { status, error, publicKey } = await post("/api/signin/passkey/start", {});
    if (status !== 200 || !publicKey) return say(wordsFor(error));
    const credential = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(publicKey) });
    const finished = await post("/api/signin/passkey/finish", { credential: credential.toJSON() });
    if (finished.status === 200) return location.replace("/");
    say(wordsFor(finished.error));
  } catch (error) {
    // A cancel, a timeout, or no passkey for this console on the device.
    say(error?.name === "NotAllowedError" ? WORDS.passkey_cancelled : WORDS.failed);
  } finally {
    $("passkey").disabled = false;
  }
});
