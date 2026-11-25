// The panel's data: each route one platform call, exactly as the playground's
// panel made it, with the team member's own token; nothing from the request
// passed on as it came, and the platform's refusals told in the console's words.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { FAMILY, FakePlatform, OPEN_SESSIONS, signIn, startConsole, write } from "./fake-platform.ts";

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
