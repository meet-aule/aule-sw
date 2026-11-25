// The sign-in page (public/signin.html, signin.js) run in a fake document,
// for «Entrar con passkey»: shown only where the browser can, the console's
// options through the browser's own picker, and what each outcome says.
// test/signin.test.ts is the console's side of the same sign-in.
import assert from "node:assert/strict";
import { test } from "node:test";

import { open } from "./dom.mjs";

const OPTIONS = { challenge: "YmFyYmF6", rpId: "admin.example.org", allowCredentials: [], userVerification: "required" };
const USED = { id: "AQIDBA", rawId: "AQIDBA", type: "public-key", response: { userHandle: "dXNlcg" } };
/** A browser whose picker gives a passkey's answer, or throws what the test gives. */
const browser = (failure) => ({
  create: async () => {
    throw new Error("the sign-in makes no passkey");
  },
  get: async () => {
    if (failure) throw failure;
    return { toJSON: () => USED };
  },
});
const answering =
  (finish = { status: 200, body: { signed_in: true } }, start = { status: 200, body: { publicKey: OPTIONS } }) =>
  (path) =>
    path === "/api/signin/passkey/start" ? start : path === "/api/signin/passkey/finish" ? finish : { status: 404, body: { error: "not_found" } };
const asked = (page) => page.asked.map(({ method, path, body }) => `${method} ${path} ${body}`);

test("a browser without the JSON methods is offered the code alone", async () => {
  const page = await open("signin.html", "signin.js", { credentials: null, answer: answering() });
  assert.equal(page.$("passkey-box").hidden, true);
  assert.equal(page.$("email-form").hidden, false);
  assert.deepEqual(page.asked, [], "nothing is asked before a click");
});

test("«Entrar con passkey» asks for the options, opens the browser's picker, sends its answer, and goes to the panel", async () => {
  const page = await open("signin.html", "signin.js", { credentials: browser(), answer: answering() });
  assert.equal(page.$("passkey-box").hidden, false);
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

test("a cancelled picker, a passkey the console refuses, the limits and a failure each say so, and the button comes back", async () => {
  for (const [what, failure, finish, start, said] of [
    ["a cancel", new DOMException("cancelled", "NotAllowedError"), undefined, undefined, "No se completó la passkey. Inténtalo otra vez o entra con tu correo."],
    ["a refusal", null, { status: 403, body: { error: "passkey_failed" } }, undefined, "No pudimos confirmar esa passkey. Entra con tu correo."],
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
