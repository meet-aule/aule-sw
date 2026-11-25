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
    // A query is never passed on: the console asks for what the panel shows.
    const response = await get(`${path}?days=90&weeks=500&q=%27`);
    assert.deepEqual(await answer(response), [200, expected], path);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(heardSince(from), [["GET", target, `Bearer ${token}`, null]], path);
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
  // Dot segments are folded away by the address itself: no such route.
  for (const id of ["..", "%2e%2e", "."]) {
    assert.deepEqual(await answer(await post(`/api/families/${id}/grant`, { days: 30 })), [404, { error: "not_found" }], id);
  }
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
