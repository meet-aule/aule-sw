// The sign-in page (public/signin.html, signin.js) run in a fake document,
// for «Entrar con passkey»: shown only where the browser can, the console's
// options through the browser's own picker, and what each outcome says.
// test/signin.test.ts is the console's side of the same sign-in.
import assert from "node:assert/strict";
import { test } from "node:test";

import { open } from "./dom.mjs";

const OPTIONS = { challenge: "YmFyYmF6", rpId: "admin.example.org", allowCredentials: [], userVerification: "required" };
const USED = { id: "AQIDBA", rawId: "AQIDBA", type: "public-key", response: { userHandle: "dXNlcg" } };
/** A browser whose picker gives a passkey's answer (`used`, or one whose toJSON() gives USED), or throws what the test gives. */
const browser = (failure, used) => ({
  create: async () => {
    throw new Error("the sign-in makes no passkey");
  },
  get: async () => {
    if (failure) throw failure;
    return used ?? { toJSON: () => USED };
  },
});
const UNREADABLE = "Tu gestor de contraseñas no pudo completar la passkey. Prueba con el llavero del navegador o entra con tu correo.";
const answering =
  (finish = { status: 200, body: { signed_in: true } }, start = { status: 200, body: { publicKey: OPTIONS } }) =>
  (path) =>
    path === "/api/signin/passkey/start" ? start : path === "/api/signin/passkey/finish" ? finish : { status: 404, body: { error: "not_found" } };
const asked = (page) => page.asked.map(({ method, path, body }) => `${method} ${path} ${body}`);

test("a browser without the JSON methods is offered the code alone", async () => {
  const page = await open("signin.html", "signin.js", { credentials: null, answer: answering() });
  assert.equal(page.$("passkey-box").hidden, true);
  assert.equal(page.$("email-form").hidden, false);
  assert.equal(page.$("lead").textContent, "", "the page's own lead, about the code, stays");
  assert.deepEqual(page.asked, [], "nothing is asked before a click");
});

test("«Entrar con passkey» asks for the options, opens the browser's picker, sends its answer, and goes to the panel", async () => {
  const page = await open("signin.html", "signin.js", { credentials: browser(), answer: answering() });
  assert.equal(page.$("passkey-box").hidden, false);
  // Where a passkey can be used, the lead says both ways in.
  assert.equal(page.$("lead").textContent, "Entra con tu passkey o con un código que te enviamos a tu correo del equipo.");
  assert.deepEqual(page.asked, [], "nothing is asked before a click");
  await page.$("passkey").fire("click");
  assert.deepEqual(asked(page), [
    "POST /api/signin/passkey/start {}",
    `POST /api/signin/passkey/finish ${JSON.stringify({ credential: USED })}`,
  ]);
  // The browser's own parser got the options, with no autofill asked for.
  assert.deepEqual(page.passkeys, [["get", { publicKey: { parsed: OPTIONS } }]]);
  assert.deepEqual(page.moves, ["/"]);
  assert.equal(page.$("message").hidden, true);
});

test("a cancelled picker, a browser that will not, a passkey the console refuses or cannot read, the limits and a failure each say so, and the button comes back", async () => {
  for (const [what, failure, finish, start, said] of [
    ["a cancel", new DOMException("cancelled", "NotAllowedError"), undefined, undefined, "No se completó el ingreso con passkey. Si no tienes una aquí, entra con tu correo."],
    ["a browser that will not here", new DOMException("not here", "SecurityError"), undefined, undefined, "Este navegador no permitió usar la passkey aquí. Entra con tu correo."],
    ["a refusal", null, { status: 403, body: { error: "passkey_failed" } }, undefined, "No pudimos confirmar esa passkey. Entra con tu correo."],
    ["an answer the console cannot read", null, { status: 400, body: { error: "bad_request" } }, undefined, UNREADABLE],
    ["too many at the start", null, undefined, { status: 429, body: { error: "too_many" } }, "Demasiados intentos. Espera unos minutos."],
    ["too many at the end", null, { status: 429, body: { error: "too_many" } }, undefined, "Demasiados intentos. Espera unos minutos."],
    ["a failing platform", null, undefined, { status: 502, body: { error: "platform" } }, "No se pudo. Inténtalo otra vez."],
    ["something else", new TypeError("odd"), undefined, undefined, "No se pudo. Inténtalo otra vez."],
  ]) {
    const page = await open("signin.html", "signin.js", { credentials: browser(failure), answer: answering(finish, start) });
    await page.$("passkey").fire("click");
    assert.equal(page.$("message").textContent, said, what);
    assert.equal(page.$("message").hidden, false, what);
    assert.deepEqual(page.moves, [], what);
    assert.equal(page.$("passkey").disabled, false, what);
  }
});

test("a password manager's answer whose toJSON() fails is sent all the same, written by hand, and one it cannot read says so", async () => {
  const buffer = (...values) => new Uint8Array(values).buffer;
  const broken = {
    rawId: buffer(1, 2, 3, 4),
    response: { clientDataJSON: buffer(123, 125), authenticatorData: buffer(1), signature: buffer(2, 3), userHandle: buffer(4, 5, 6) },
    getClientExtensionResults: () => ({}),
    toJSON() {
      throw new TypeError("Illegal invocation");
    },
  };
  const page = await open("signin.html", "signin.js", { credentials: browser(null, broken), answer: answering() });
  await page.$("passkey").fire("click");
  const credential = {
    id: "AQIDBA",
    rawId: "AQIDBA",
    type: "public-key",
    response: { clientDataJSON: "e30", authenticatorData: "AQ", signature: "AgM", userHandle: "BAUG" },
    clientExtensionResults: {},
  };
  assert.deepEqual(asked(page)[1], `POST /api/signin/passkey/finish ${JSON.stringify({ credential })}`);
  assert.deepEqual(page.moves, ["/"]);

  const sealed = {
    get rawId() {
      throw new TypeError("Illegal invocation");
    },
    toJSON() {
      throw new TypeError("Illegal invocation");
    },
  };
  const stuck = await open("signin.html", "signin.js", { credentials: browser(null, sealed), answer: answering() });
  await stuck.$("passkey").fire("click");
  assert.equal(stuck.$("message").textContent, UNREADABLE);
  assert.deepEqual(asked(stuck), ["POST /api/signin/passkey/start {}"], "nothing is sent");
  assert.equal(stuck.$("passkey").disabled, false);
});
