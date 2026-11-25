// The panel's data: each route one platform call, exactly as the playground's
// panel made it, with the team member's own token; nothing from the request
// passed on as it came, and the platform's refusals told in the console's words.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  CEREMONY,
  CEREMONY_COOKIE,
  CLEARED_CEREMONY,
  CREATED,
  CREATED_SENT,
  CREATE_OPTIONS,
  FAMILY,
  FakePlatform,
  OPEN_SESSIONS,
  PASSKEY,
  PASSKEY_ID,
  logged,
  signIn,
  startConsole,
  write,
} from "./fake-platform.ts";

const platform = await new FakePlatform().listen();
let base = "";
let close = () => {};
let cookie = "";
let token = "";

before(async () => {
  ({ base, close } = await startConsole(platform, { platformTimeoutMs: 300 }));
  cookie = await signIn(base);
  token = [...platform.tokens].at(-1)!;
});
after(() => {
  close();
  platform.close();
});

const get = (path: string) => fetch(`${base}${path}`, { headers: { Cookie: cookie } });
const post = (path: string, body: unknown) => write(base, path, body, { cookie });
const answer = async (response: Response) => [response.status, await response.json()];
/** What the platform heard since `from`: method, path, token and body. */
const heardSince = (from: number) =>
  platform.heard.slice(from).map((heard) => [heard.method, heard.path, heard.headers.authorization, heard.body]);

test("each read is the one platform call it stands for, made with the team member's token", async () => {
  for (const [path, target, expected] of [
    ["/api/families", "/v1/admin/families", { families: [{ id: FAMILY, name: "Quispe" }] }],
    ["/api/metrics/daily", "/v1/metrics/daily?days=14", { days: [] }],
    ["/api/metrics/weekly", "/v1/metrics/weekly?weeks=12", { timezone_offset_minutes: -300, weeks: 12, cohorts: [{ week: "2026-11-23", source: "cesar", families: 2 }] }],
    ["/api/sessions/open", "/v1/admin/sessions/open", OPEN_SESSIONS],
  ] as const) {
    const from = platform.heard.length;
    // A query a route does not take is never passed on: the console asks for what the page shows.
    const response = await get(`${path}?days=90&weeks=500&x=%27`);
    assert.deepEqual(await answer(response), [200, expected], path);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(heardSince(from), [["GET", target, `Bearer ${token}`, null]], path);
  }
});

const CURSOR = `1795619045123456_${FAMILY}`;

test("the families' search, link, plan and page reach the platform checked, written again, and alone", async () => {
  for (const [asked, sent] of [
    ["", ""],
    ["?limit=1", "?limit=1"],
    // Empty values are no values, as a form sends them; unknown names are left behind.
    ["?q=&source=&status=&before=&limit=&days=90&x=%27", ""],
    [`?limit=100&before=${CURSOR}&status=trial&source=cesar&q=%20ana%40x.org%20`, `?q=ana%40x.org&source=cesar&status=trial&before=${CURSOR}&limit=100`],
    ["?q=a+b%26c%3D%23", "?q=a+b%26c%3D%23"],
    ["?q=%3Cscript%3E%27", "?q=%3Cscript%3E%27"],
    [`?q=${"ñ".repeat(100)}`, `?q=${encodeURIComponent("ñ".repeat(100))}`],
    ["?status=free&status=trial", "?status=free"],
  ] as const) {
    const from = platform.heard.length;
    assert.deepEqual(await answer(await get(`/api/families${asked}`)), [200, { families: [{ id: FAMILY, name: "Quispe" }] }], asked);
    assert.deepEqual(heardSince(from), [["GET", `/v1/admin/families${sent}`, `Bearer ${token}`, null]], asked);
  }
});

test("a search, a link, a plan, a cursor or a page size that is none never reaches the platform", async () => {
  const from = platform.heard.length;
  for (const asked of [
    `?q=${"a".repeat(101)}`,
    "?q=ana%0Aluis",
    "?q=ana%00",
    "?source=Cesar",
    "?source=%3Cb%3E",
    `?source=${"a".repeat(25)}`,
    "?status=gratis",
    "?status=TRIAL",
    "?before=ayer",
    `?before=${CURSOR.toUpperCase()}`,
    `?before=-1_${FAMILY}`,
    "?limit=0",
    "?limit=101",
    "?limit=1.5",
    "?limit=-1",
    "?limit=07",
    "?limit=muchas",
  ]) {
    assert.deepEqual(await answer(await get(`/api/families${asked}`)), [400, { error: "bad_request" }], asked);
  }
  assert.deepEqual(heardSince(from), []);
});

test("a family's page, sessions and notices are the platform's, for a family's id only, a page at a time", async () => {
  const from = platform.heard.length;
  const page = `/v1/admin/families/${FAMILY}`;
  for (const [asked, sent] of [
    [`/api/families/${FAMILY}?limit=5&q=x`, page],
    [`/api/families/${FAMILY}/sessions`, `${page}/sessions`],
    [`/api/families/${FAMILY}/sessions?limit=50&before=${CURSOR}&x=1`, `${page}/sessions?before=${CURSOR}&limit=50`],
    [`/api/families/${FAMILY}/notices?limit=20`, `${page}/notices?limit=20`],
  ] as const) {
    assert.equal((await get(asked)).status, 200, asked);
    assert.deepEqual(heardSince(platform.heard.length - 1), [["GET", sent, `Bearer ${token}`, null]], asked);
  }
  assert.equal(platform.heard.length - from, 4);
  const none = platform.heard.length;
  for (const asked of [
    "/api/families/x",
    `/api/families/${FAMILY.toUpperCase()}`,
    `/api/families/${FAMILY}0/sessions`,
    "/api/families/%2e%2e%2fmetrics/notices",
    `/api/families/${FAMILY}/sessions?limit=51`,
    `/api/families/${FAMILY}/notices?before=ayer`,
    `/api/families/${FAMILY}/notices?limit=0`,
  ]) {
    assert.deepEqual(await answer(await get(asked)), [400, { error: "bad_request" }], asked);
  }
  assert.deepEqual(heardSince(none), []);
  // A family that is not there is told in the console's words.
  const gone = "01a1f5f4-ede7-7028-a524-9d8e2f36b92e";
  for (const list of ["", "/sessions", "/notices"]) {
    assert.deepEqual(await answer(await get(`/api/families/${gone}${list}`)), [404, { error: "not_found" }], list);
  }
  // Only read, and only with a session.
  for (const path of [`/api/families/${FAMILY}`, `/api/families/${FAMILY}/sessions`, `/api/families/${FAMILY}/notices`]) {
    assert.deepEqual(await answer(await fetch(`${base}${path}`)), [401, { error: "signed_out" }], path);
    const posted = await post(path, {});
    assert.equal(posted.status, 405, path);
    assert.equal(posted.headers.get("allow"), "GET", path);
    await posted.arrayBuffer();
  }
});

test("a plan is granted with whole days and a trimmed note, and ended, as the old panel did", async () => {
  const from = platform.heard.length;
  assert.deepEqual(await answer(await post(`/api/families/${FAMILY}/grant`, { days: 30, note: " piloto ", extra: 1, family_id: "x" })), [201, { plan: "granted" }]);
  assert.deepEqual(await answer(await post(`/api/families/${FAMILY}/grant`, { days: 7 })), [201, { plan: "granted" }]);
  assert.deepEqual(await answer(await post(`/api/families/${FAMILY}/grant`, { days: 1, note: "   " })), [201, { plan: "granted" }]);
  assert.deepEqual(await answer(await post(`/api/families/${FAMILY}/ungrant`, { note: "ignored" })), [200, { plan: "trial" }]);
  const grant = `/v1/admin/families/${FAMILY}/grant`;
  assert.deepEqual(heardSince(from), [
    ["POST", grant, `Bearer ${token}`, { days: 30, note: "piloto" }],
    ["POST", grant, `Bearer ${token}`, { days: 7 }],
    ["POST", grant, `Bearer ${token}`, { days: 1 }],
    ["DELETE", grant, `Bearer ${token}`, null],
  ]);
});

test("a note is cut to 500 characters, never inside one", async () => {
  const from = platform.heard.length;
  const smile = String.fromCodePoint(0x1f642);
  await post(`/api/families/${FAMILY}/grant`, { days: 30, note: `${"a".repeat(499)}${smile}${smile}tail` });
  const sent = platform.heard[from]?.body as { note: string };
  assert.equal([...sent.note].length, 500);
  assert.ok(sent.note.endsWith(smile), "the last character is whole");
});

test("an id that is not a family's, or days out of bounds, never reach the platform", async () => {
  const from = platform.heard.length;
  for (const id of ["x", FAMILY.toUpperCase(), `${FAMILY}0`, `${FAMILY.slice(0, 35)}g`, "%20", "a%2Fb"]) {
    for (const action of ["grant", "ungrant"]) {
      assert.deepEqual(await answer(await post(`/api/families/${id}/${action}`, { days: 30 })), [400, { error: "bad_request" }], `${id} ${action}`);
    }
  }
  // Dot segments are folded away by the address itself: no such route, or a family's page, which is only read.
  for (const id of ["..", "%2e%2e"]) {
    assert.deepEqual(await answer(await post(`/api/families/${id}/grant`, { days: 30 })), [404, { error: "not_found" }], id);
  }
  assert.deepEqual(await answer(await post("/api/families/./grant", { days: 30 })), [405, { error: "method_not_allowed" }]);
  for (const days of ["30", 0, -1, 367, 1.5, null, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(await answer(await post(`/api/families/${FAMILY}/grant`, { days })), [400, { error: "bad_request" }], String(days));
  }
  assert.deepEqual(await answer(await post(`/api/families/${FAMILY}/grant`, { note: "no days" })), [400, { error: "bad_request" }]);
  assert.deepEqual(heardSince(from), []);
  assert.deepEqual(await answer(await post(`/api/families/${FAMILY}/grant`, { days: 366 })), [201, { plan: "granted" }], "a year is allowed");
});

test("the platform's refusals are told in the console's words, never in the platform's", async () => {
  const unknown = "01a1f5f4-ede7-7028-a524-9d8e2f36b92e";
  assert.deepEqual(await answer(await post(`/api/families/${unknown}/grant`, { days: 30 })), [404, { error: "not_found" }]);
  for (const [status, expected] of [
    [400, [400, { error: "bad_request" }]],
    [404, [404, { error: "not_found" }]],
    [409, [502, { error: "platform" }]],
    [500, [502, { error: "platform" }]],
    [502, [502, { error: "platform" }]],
    [503, [502, { error: "platform" }]],
  ] as const) {
    platform.once("GET /v1/admin/families", { status, body: { error: { code: "x", message: "internal detail: table families" } } });
    const response = await get("/api/families");
    const text = await response.text();
    assert.deepEqual([response.status, JSON.parse(text)], expected, String(status));
    assert.doesNotMatch(text, /detail|table/);
  }
  // A platform that does not answer in time is a failure too, and says nothing more.
  platform.once("GET /v1/metrics/daily?days=14", { status: 200, body: { days: [] }, waitMs: 1_000 });
  assert.deepEqual(await answer(await get("/api/metrics/daily")), [502, { error: "platform" }]);
  // An answer that is not JSON at all is no answer.
  platform.once("POST /v1/admin/families/" + FAMILY + "/grant", { status: 500 });
  assert.deepEqual(await answer(await post(`/api/families/${FAMILY}/grant`, { days: 30 })), [502, { error: "platform" }]);
  // A bare 404 is a route an older platform does not have, not a family that is gone.
  for (const list of ["", "/sessions", "/notices"]) {
    platform.once(`GET /v1/admin/families/${FAMILY}${list}${list ? "?limit=20" : ""}`, { status: 404 });
    const asked = `/api/families/${FAMILY}${list}${list ? "?limit=20" : ""}`;
    assert.deepEqual(await answer(await get(asked)), [502, { error: "platform" }], asked);
  }
  platform.once("GET /v1/admin/sessions/open", { status: 404 });
  assert.deepEqual(await answer(await get("/api/sessions/open")), [502, { error: "platform" }]);
  assert.equal((await get("/api/families")).status, 200, "the session is still there");
});

test("every data route needs a session, and a write the console's own Origin", async () => {
  for (const path of ["/api/build", "/api/families", "/api/metrics/daily", "/api/metrics/weekly", "/api/sessions/open"]) {
    assert.deepEqual(await answer(await fetch(`${base}${path}`)), [401, { error: "signed_out" }], path);
  }
  for (const action of ["grant", "ungrant"]) {
    const path = `/api/families/${FAMILY}/${action}`;
    assert.deepEqual(await answer(await write(base, path, { days: 30 })), [401, { error: "signed_out" }], path);
    assert.deepEqual(await answer(await write(base, path, { days: 30 }, { cookie, origin: null })), [403, { error: "wrong_origin" }], path);
    assert.deepEqual(await answer(await write(base, path, { days: 30 }, { cookie, site: "cross-site" })), [403, { error: "wrong_origin" }], path);
    assert.deepEqual(await answer(await write(base, path, { days: 30 }, { cookie, type: "text/plain" })), [415, { error: "unsupported_media_type" }], path);
  }
});

// «Passkeys»: the member's own, each route one platform call with their token.
const withCeremony = () => `${cookie}; __Host-aule_admin_passkey=${CEREMONY}`;

test("the member's passkeys are the platform's list, asked with their own token", async () => {
  platform.passkeys = [PASSKEY];
  try {
    const from = platform.heard.length;
    assert.deepEqual(await answer(await get("/api/passkeys?mine=0")), [200, { passkeys: [PASSKEY] }]);
    assert.deepEqual(heardSince(from), [["GET", "/v1/admin/passkeys", `Bearer ${token}`, null]]);
  } finally {
    platform.passkeys = [];
  }
});

test("a passkey's options put the ceremony in its own cookie, and give the page the options alone", async () => {
  const from = platform.heard.length;
  const response = await post("/api/passkeys/options", { ceremony: "f".repeat(64), extra: 1 });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { publicKey: CREATE_OPTIONS });
  assert.deepEqual(response.headers.getSetCookie(), [CEREMONY_COOKIE]);
  assert.deepEqual(heardSince(from), [["POST", "/v1/admin/passkeys/options", `Bearer ${token}`, null]]);
});

test("a sign-in too old to add a passkey is told as sign_in_again, and the session stays", async () => {
  platform.staleSignIn = true;
  try {
    assert.deepEqual(await answer(await post("/api/passkeys/options", {})), [409, { error: "sign_in_again" }]);
  } finally {
    platform.staleSignIn = false;
  }
  assert.equal((await get("/api/passkeys")).status, 200, "still signed in");
  // An answer of another shape is a failure: the page gets nothing the console did not check.
  for (const body of [
    { ceremony: "x", options: { publicKey: CREATE_OPTIONS } },
    { ceremony: CEREMONY.toUpperCase(), options: { publicKey: CREATE_OPTIONS } },
    { ceremony: CEREMONY, options: { publicKey: "x" } },
    { ceremony: CEREMONY },
    {},
  ]) {
    platform.once("POST /v1/admin/passkeys/options", { status: 200, body });
    const response = await post("/api/passkeys/options", {});
    assert.deepEqual(await answer(response), [502, { error: "platform" }], JSON.stringify(body));
    assert.deepEqual(response.headers.getSetCookie(), []);
  }
});

test("a passkey is made with the ceremony from its cookie and a name, its credential built again", async () => {
  const from = platform.heard.length;
  const body = { label: "  MacBook de Ana ", credential: CREATED, ceremony: "f".repeat(64), extra: 1 };
  const response = await write(base, "/api/passkeys/create", body, { cookie: withCeremony() });
  assert.deepEqual(await answer(response), [201, { ...PASSKEY, label: "MacBook de Ana" }]);
  assert.deepEqual(response.headers.getSetCookie(), [CLEARED_CEREMONY]);
  // The ceremony is the cookie's, never the body's; the credential has the fields the platform reads.
  assert.deepEqual(heardSince(from), [
    ["POST", "/v1/admin/passkeys", `Bearer ${token}`, { ceremony: CEREMONY, label: "MacBook de Ana", credential: CREATED_SENT }],
  ]);
  // A browser that says nothing of credProps or transports is passed on as it says it.
  const quiet = { ...CREATED, response: { ...CREATED.response, transports: undefined }, clientExtensionResults: {} };
  const said = platform.heard.length;
  assert.equal((await write(base, "/api/passkeys/create", { label: "Mac", credential: quiet }, { cookie: withCeremony() })).status, 201);
  const sent = (platform.heard[said]?.body as { credential: Record<string, unknown> }).credential;
  assert.deepEqual(sent.clientExtensionResults, {});
  assert.deepEqual(Object.keys(sent.response as object), ["clientDataJSON", "attestationObject"]);
});

test("a passkey without its ceremony, a name or a credential the console can read never reaches the platform", async () => {
  const none = platform.heard.length;
  const response = (extra: Record<string, unknown>) => ({ ...CREATED.response, ...extra });
  for (const [what, body, cookies] of [
    ["no ceremony", { label: "Mac", credential: CREATED }, cookie],
    ["a ceremony of another shape", { label: "Mac", credential: CREATED }, `${cookie}; __Host-aule_admin_passkey=${CEREMONY.toUpperCase()}`],
    ["the ceremony in the body only", { label: "Mac", credential: CREATED, ceremony: CEREMONY }, cookie],
    ["no name", { label: "   ", credential: CREATED }, withCeremony()],
    ["a name too long", { label: "ñ".repeat(61), credential: CREATED }, withCeremony()],
    ["a name of two lines", { label: "Mac\nBook", credential: CREATED }, withCeremony()],
    ["a name that is no text", { label: 42, credential: CREATED }, withCeremony()],
    ["no credential", { label: "Mac" }, withCeremony()],
    ["an id that is not its rawId", { label: "Mac", credential: { ...CREATED, rawId: "AQIDBQ" } }, withCeremony()],
    ["another type", { label: "Mac", credential: { ...CREATED, type: "password" } }, withCeremony()],
    ["an id too long", { label: "Mac", credential: { ...CREATED, id: "a".repeat(1_369), rawId: "a".repeat(1_369) } }, withCeremony()],
    ["a field that is not base64url", { label: "Mac", credential: { ...CREATED, response: response({ clientDataJSON: "e30=" }) } }, withCeremony()],
    ["no attestation", { label: "Mac", credential: { ...CREATED, response: response({ attestationObject: undefined }) } }, withCeremony()],
    ["transports that are no list", { label: "Mac", credential: { ...CREATED, response: response({ transports: "usb" }) } }, withCeremony()],
    ["credProps.rk that is no yes or no", { label: "Mac", credential: { ...CREATED, clientExtensionResults: { credProps: { rk: "true" } } } }, withCeremony()],
  ] as const) {
    const refused = await write(base, "/api/passkeys/create", body, { cookie: cookies });
    assert.deepEqual(await answer(refused), [400, { error: "bad_request" }], what);
    assert.deepEqual(refused.headers.getSetCookie(), [CLEARED_CEREMONY], what);
  }
  assert.deepEqual(heardSince(none), []);
  // The platform's refusal is told in the console's words, and the cookie goes too.
  platform.once("POST /v1/admin/passkeys", { status: 400, body: { error: { code: "bad_request", message: "that passkey could not be confirmed" } } });
  const refused = await write(base, "/api/passkeys/create", { label: "Mac", credential: CREATED }, { cookie: withCeremony() });
  assert.deepEqual(await answer(refused), [400, { error: "bad_request" }]);
  assert.deepEqual(refused.headers.getSetCookie(), [CLEARED_CEREMONY]);
});

test("a passkey is deleted by its id alone, and one that is not the member's is not found", async () => {
  const from = platform.heard.length;
  assert.deepEqual(await answer(await post(`/api/passkeys/${PASSKEY_ID}/delete`, { id: FAMILY })), [200, {}]);
  assert.deepEqual(heardSince(from), [["DELETE", `/v1/admin/passkeys/${PASSKEY_ID}`, `Bearer ${token}`, null]]);
  assert.deepEqual(await answer(await post(`/api/passkeys/${FAMILY}/delete`, {})), [404, { error: "not_found" }]);
  const none = platform.heard.length;
  for (const id of ["x", PASSKEY_ID.toUpperCase(), `${PASSKEY_ID}0`, "a%2Fb", "options", "create"]) {
    assert.deepEqual(await answer(await post(`/api/passkeys/${id}/delete`, {})), [400, { error: "bad_request" }], id);
  }
  assert.deepEqual(heardSince(none), []);
});

test("the passkey routes need a session and the write rules, and someone off the team is signed out", async () => {
  for (const path of ["/api/passkeys/options", "/api/passkeys/create", `/api/passkeys/${PASSKEY_ID}/delete`]) {
    assert.deepEqual(await answer(await write(base, path, {})), [401, { error: "signed_out" }], path);
    assert.deepEqual(await answer(await write(base, path, {}, { cookie, origin: null })), [403, { error: "wrong_origin" }], path);
    assert.deepEqual(await answer(await write(base, path, {}, { cookie, site: "cross-site" })), [403, { error: "wrong_origin" }], path);
    assert.deepEqual(await answer(await write(base, path, {}, { cookie, type: "text/plain" })), [415, { error: "unsupported_media_type" }], path);
  }
  assert.deepEqual(await answer(await fetch(`${base}/api/passkeys`)), [401, { error: "signed_out" }]);
  // Taken off the team at the platform: the console's session ends, and its platform session with it.
  const own = await signIn(base);
  const ownToken = [...platform.tokens].at(-1)!;
  platform.refuseStaff(ownToken);
  assert.deepEqual(await answer(await write(base, "/api/passkeys/options", {}, { cookie: own })), [403, { error: "not_team" }]);
  assert.deepEqual(await answer(await fetch(`${base}/api/passkeys`, { headers: { Cookie: own } })), [401, { error: "signed_out" }]);
});

test("the log says a passkey was made or deleted, and nothing of it", async () => {
  const lines = await logged(async () => {
    await write(base, "/api/passkeys/create", { label: "MacBook de Ana", credential: CREATED }, { cookie: withCeremony() });
    await post(`/api/passkeys/${PASSKEY_ID}/delete`, {});
  });
  assert.deepEqual(lines, ["aule-admin: passkey_created", "aule-admin: passkey_deleted"]);
});
