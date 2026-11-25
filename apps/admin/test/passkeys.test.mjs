// «Passkeys» (public/passkeys.html, passkeys.js) run in a fake document with
// a stand-in for the browser's WebAuthn: the list drawn as text, «Crear
// passkey» from the name to the passkey sent back, what each failure says, a
// browser that cannot, the most a member may have, and «Borrar».
process.env.TZ = "America/Lima";

import assert from "node:assert/strict";
import { test } from "node:test";

import { open, rows, settle, walk } from "./dom.mjs";

const ID = "01a1f5f4-ede7-7028-a524-9d8e2f36b9f0";
const passkey = (more) => ({ id: ID, label: "MacBook de Ana", created_at: "2026-11-20T15:00:00Z", last_used_at: "2026-11-24T21:10:00Z", ...more });
const OPTIONS = { challenge: "Zm9vYmFy", user: { id: "dXNlcg", name: "team@example.org", displayName: "team@example.org" } };
const MADE = { id: "AQIDBA", rawId: "AQIDBA", type: "public-key" };
/** A browser whose dialog makes a passkey, or throws what the test gives. */
const browser = (failure) => ({
  create: async () => {
    if (failure) throw failure;
    return { toJSON: () => MADE };
  },
  get: async () => {
    throw new Error("the page signs nobody in");
  },
});
/** The console's answers, by `METHOD path`: one answer, or a list given one at a time. */
function console_(answers) {
  return (path, init = {}) => {
    const key = `${init.method ?? "GET"} ${path}`;
    const answer = answers[key];
    if (Array.isArray(answer)) return answer.length > 1 ? answer.shift() : answer[0];
    return answer ?? { status: 404, body: { error: "not_found" } };
  };
}
const asked = (page) => page.asked.map(({ method, path, body }) => `${method} ${path}${body ? ` ${body}` : ""}`);
const buttons = (page) => [...walk(page.$("passkeys"))].filter((element) => element.tagName === "BUTTON");

test("each passkey is a line of its name and dates, drawn as text, in Lima's time", async () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const page = await open("passkeys.html", "passkeys.js", {
    credentials: browser(),
    answer: console_({ "GET /api/passkeys": { status: 200, body: { passkeys: [passkey(), passkey({ id: "x", label: hostile, last_used_at: null })] } } }),
  });
  assert.deepEqual(rows(page.$("passkeys")), [
    ["MacBook de Ana", "20 nov. 2026", "24 nov., 16:10", "Borrar"],
    [hostile, "20 nov. 2026", "—", "Borrar"],
  ]);
  const made = new Set([...walk(page.$("passkeys"))].map((element) => element.tagName));
  assert.deepEqual([...made].sort(), ["BUTTON", "TBODY", "TD", "TR"]);
  assert.equal(page.$("none").hidden, true);
  assert.equal(page.$("unsupported").hidden, true);
  assert.equal(page.$("create").disabled, false);
  assert.deepEqual(asked(page), ["GET /api/passkeys"]);
});

test("with none yet, the page says so", async () => {
  const page = await open("passkeys.html", "passkeys.js", { credentials: browser(), answer: console_({ "GET /api/passkeys": { status: 200, body: { passkeys: [] } } }) });
  assert.equal(page.$("none").hidden, false);
  assert.deepEqual(rows(page.$("passkeys")), []);
});

test("«Crear passkey» takes a name, then the options, the browser's dialog and the passkey back, and lists it", async () => {
  const page = await open("passkeys.html", "passkeys.js", {
    credentials: browser(),
    answer: console_({
      "GET /api/passkeys": [{ status: 200, body: { passkeys: [] } }, { status: 200, body: { passkeys: [passkey()] } }],
      "POST /api/passkeys/options": { status: 200, body: { publicKey: OPTIONS } },
      "POST /api/passkeys/create": { status: 201, body: passkey({ last_used_at: null }) },
    }),
  });
  // A name first: nothing is asked without one, or with one too long.
  for (const [typed, said] of [
    ["   ", "Ponle un nombre a la passkey."],
    ["a".repeat(61), "El nombre tiene hasta 60 letras, en una línea."],
  ]) {
    page.$("label").value = typed;
    await page.$("create-form").fire("submit");
    assert.equal(page.$("message").textContent, said);
    assert.deepEqual(page.passkeys, []);
  }
  page.$("label").value = "  MacBook de Ana ";
  await page.$("create-form").fire("submit");
  assert.deepEqual(asked(page), [
    "GET /api/passkeys",
    "POST /api/passkeys/options {}",
    `POST /api/passkeys/create ${JSON.stringify({ label: "MacBook de Ana", credential: MADE })}`,
    "GET /api/passkeys",
  ]);
  // The browser got the platform's options through its own parser.
  assert.deepEqual(page.passkeys, [["create", { publicKey: { parsed: OPTIONS } }]]);
  assert.equal(page.$("done").textContent, "Listo: ya puedes entrar con esta passkey.");
  assert.equal(page.$("done").hidden, false);
  assert.equal(page.$("message").hidden, true);
  assert.equal(page.$("label").value, "");
  assert.deepEqual(rows(page.$("passkeys")), [["MacBook de Ana", "20 nov. 2026", "24 nov., 16:10", "Borrar"]]);
  assert.equal(page.$("create").disabled, false);
});

test("a sign-in too old, a cancelled dialog, a device that has one, and a failure each say so", async () => {
  for (const [what, failure, options, made, said] of [
    ["an old sign-in", null, { status: 409, body: { error: "sign_in_again" } }, null, "Por seguridad, para crear una passkey tienes que haber entrado hace poco. Sal y vuelve a entrar, y créala enseguida."],
    ["a cancel", new DOMException("cancelled", "NotAllowedError"), null, null, "No se creó la passkey."],
    ["an excluded device", new DOMException("there already", "InvalidStateError"), null, null, "Este dispositivo ya tiene una passkey tuya."],
    ["a refusal", null, null, { status: 400, body: { error: "bad_request" } }, "No se pudo crear la passkey. Inténtalo otra vez."],
    ["a failure", null, { status: 502, body: { error: "platform" } }, null, "No se pudo crear la passkey. Inténtalo otra vez."],
  ]) {
    const page = await open("passkeys.html", "passkeys.js", {
      credentials: browser(failure),
      answer: console_({
        "GET /api/passkeys": { status: 200, body: { passkeys: [] } },
        "POST /api/passkeys/options": options ?? { status: 200, body: { publicKey: OPTIONS } },
        "POST /api/passkeys/create": made ?? { status: 201, body: passkey() },
      }),
    });
    page.$("label").value = "Mac";
    await page.$("create-form").fire("submit");
    assert.equal(page.$("message").textContent, said, what);
    assert.equal(page.$("done").hidden, true, what);
    assert.equal(page.$("create").disabled, false, `${what}: the button comes back`);
    assert.equal(page.$("label").value, "Mac", `${what}: the name stays for another try`);
  }
});

test("a browser that cannot make passkeys is told so, and offers nothing", async () => {
  const page = await open("passkeys.html", "passkeys.js", { credentials: null, answer: console_({ "GET /api/passkeys": { status: 200, body: { passkeys: [passkey()] } } }) });
  assert.equal(page.$("unsupported").hidden, false);
  assert.equal(page.$("create").disabled, true);
  page.$("label").value = "Mac";
  await page.$("create-form").fire("submit");
  assert.deepEqual(asked(page), ["GET /api/passkeys"], "nothing is asked");
  // The list and «Borrar» still work.
  assert.deepEqual(rows(page.$("passkeys")).length, 1);
});

test("with ten passkeys «Crear passkey» is off, and the page says why", async () => {
  const ten = Array.from({ length: 10 }, (_, n) => passkey({ id: `${ID.slice(0, -1)}${n}`, label: `Llave ${n}` }));
  const page = await open("passkeys.html", "passkeys.js", { credentials: browser(), answer: console_({ "GET /api/passkeys": { status: 200, body: { passkeys: ten } } }) });
  assert.equal(page.$("create").disabled, true);
  assert.equal(page.$("full").hidden, false);
  page.$("label").value = "Otra";
  await page.$("create-form").fire("submit");
  assert.deepEqual(asked(page), ["GET /api/passkeys"]);
});

test("«Borrar» asks first, naming the passkey in one short line, then deletes it and lists the rest", async () => {
  const page = await open("passkeys.html", "passkeys.js", {
    credentials: browser(),
    confirms: [false, true],
    answer: console_({
      "GET /api/passkeys": [{ status: 200, body: { passkeys: [passkey({ label: "Mac\nde «Ana»‮" })] } }, { status: 200, body: { passkeys: [] } }],
      [`POST /api/passkeys/${ID}/delete`]: { status: 200, body: {} },
    }),
  });
  const [erase] = buttons(page);
  await erase.fire("click");
  assert.deepEqual(asked(page), ["GET /api/passkeys"], "nothing without a yes");
  await erase.fire("click");
  await settle();
  assert.deepEqual(page.dialogs, Array(2).fill(
    "¿Borrar la passkey «Mac de «Ana»»? Ya no podrás entrar con ella. Bórrala también de tu dispositivo o de tu gestor de contraseñas.",
  ));
  assert.deepEqual(asked(page).slice(1), [`POST /api/passkeys/${ID}/delete {}`, "GET /api/passkeys"]);
  assert.deepEqual(rows(page.$("passkeys")), []);
  assert.equal(page.$("none").hidden, false);
});

test("signed out, the page goes to the sign-in", async () => {
  const page = await open("passkeys.html", "passkeys.js", { credentials: browser(), answer: console_({ "GET /api/passkeys": { status: 401, body: { error: "signed_out" } } }) });
  assert.deepEqual(page.moves, ["/signin"]);
  assert.equal(page.$("message").hidden, true);
});
