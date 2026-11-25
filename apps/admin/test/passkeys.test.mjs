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
const OPTIONS = {
  challenge: "Zm9vYmFy",
  rp: { id: "admin.example.org", name: "Aule" },
  user: { id: "dXNlcg", name: "team@example.org", displayName: "team@example.org" },
};
const MADE = { id: "AQIDBA", rawId: "AQIDBA", type: "public-key" };
/** What the page asks the browser to forget: the passkey it made, for the console's RP id. */
const FORGET = ["signal", { rpId: "admin.example.org", credentialId: "AQIDBA" }];
/** A browser whose dialog makes a passkey (`made`, or one whose toJSON() gives MADE), or throws what the test gives. */
const browser = (failure, made) => ({
  create: async () => {
    if (failure) throw failure;
    return made ?? { id: MADE.id, toJSON: () => MADE };
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

const AGAIN = "Por seguridad, para crear una passkey tienes que haber entrado hace poco. Sal y vuelve a entrar, y créala enseguida.";
const FAILED = "No se pudo crear la passkey. Inténtalo otra vez.";
/** What is added once the browser has made a passkey the console may not have kept. */
const LEFT = "Si tu dispositivo o tu gestor de contraseñas guardó una passkey de Aule que no está en esta lista, bórrala allí.";

test("a sign-in too old, a cancelled dialog, a device that has one, a browser that will not, and a failure each say so", async () => {
  for (const [what, failure, options, made, said, signals] of [
    ["an old sign-in", null, { status: 409, body: { error: "sign_in_again" } }, null, AGAIN, []],
    ["a cancel", new DOMException("cancelled", "NotAllowedError"), null, null, "No se creó la passkey.", []],
    ["an excluded device", new DOMException("there already", "InvalidStateError"), null, null, "Este dispositivo ya tiene una passkey tuya.", []],
    ["a browser that will not here", new DOMException("not here", "SecurityError"), null, null, "Este navegador no permitió crear la passkey aquí.", []],
    ["a failure before the dialog", null, { status: 502, body: { error: "platform" } }, null, FAILED, []],
    // Once the browser has made it: the console's refusal, or a sign-in grown too old,
    // and the browser is asked to forget it; a failure may have kept it, so it is not.
    ["a refusal", null, null, { status: 400, body: { error: "bad_request" } }, `${FAILED} ${LEFT}`, [FORGET]],
    ["a sign-in too old by the end", null, null, { status: 409, body: { error: "sign_in_again" } }, `${AGAIN} ${LEFT}`, [FORGET]],
    ["a failure after the dialog", null, null, { status: 502, body: { error: "platform" } }, `${FAILED} ${LEFT}`, []],
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
    assert.deepEqual(page.passkeys.filter(([asked]) => asked === "signal"), signals, what);
  }
});

test("a password manager's passkey whose toJSON() fails is sent all the same, written by hand", async () => {
  const buffer = (...values) => new Uint8Array(values).buffer;
  const made = {
    id: "AQIDBA",
    rawId: buffer(1, 2, 3, 4),
    type: "public-key",
    response: { clientDataJSON: buffer(123, 125), attestationObject: buffer(0xa1, 0x63), getTransports: () => ["internal"] },
    getClientExtensionResults: () => ({ credProps: { rk: true } }),
    toJSON() {
      throw new TypeError("Illegal invocation");
    },
  };
  const page = await open("passkeys.html", "passkeys.js", {
    credentials: browser(null, made),
    answer: console_({
      "GET /api/passkeys": { status: 200, body: { passkeys: [] } },
      "POST /api/passkeys/options": { status: 200, body: { publicKey: OPTIONS } },
      "POST /api/passkeys/create": { status: 201, body: passkey() },
    }),
  });
  page.$("label").value = "Mac";
  await page.$("create-form").fire("submit");
  const credential = {
    id: "AQIDBA",
    rawId: "AQIDBA",
    type: "public-key",
    response: { clientDataJSON: "e30", attestationObject: "oWM", transports: ["internal"] },
    clientExtensionResults: { credProps: { rk: true } },
  };
  assert.ok(asked(page).includes(`POST /api/passkeys/create ${JSON.stringify({ label: "Mac", credential })}`), asked(page).join("\n"));
  assert.equal(page.$("done").textContent, "Listo: ya puedes entrar con esta passkey.");
});

test("a passkey the page cannot read at all is not sent: the browser is asked to forget it, and the page says what to do", async () => {
  const sealed = {
    id: "AQIDBA",
    get rawId() {
      throw new TypeError("Illegal invocation");
    },
    toJSON() {
      throw new TypeError("Illegal invocation");
    },
  };
  const page = await open("passkeys.html", "passkeys.js", {
    credentials: browser(null, sealed),
    answer: console_({
      "GET /api/passkeys": { status: 200, body: { passkeys: [] } },
      "POST /api/passkeys/options": { status: 200, body: { publicKey: OPTIONS } },
    }),
  });
  page.$("label").value = "Mac";
  await page.$("create-form").fire("submit");
  assert.equal(
    page.$("message").textContent,
    "Tu gestor de contraseñas no pudo completar la passkey. Si la guardó, bórrala allí y prueba con el llavero del navegador.",
  );
  assert.ok(!asked(page).some((line) => line.startsWith("POST /api/passkeys/create")), "nothing is sent");
  assert.deepEqual(page.passkeys.filter(([what]) => what === "signal"), [FORGET]);
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
