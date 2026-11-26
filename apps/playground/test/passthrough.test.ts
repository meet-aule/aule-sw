// The family app's way to the platform (src/passthrough.ts): only the routes
// the app calls, only with a guardian's bearer, and only Authorization and
// Content-Type go on. Each refusal is checked against what reached the platform.
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, beforeEach, test } from "node:test";

import { readSettings } from "../src/config.ts";
import { LIMITS, ROUTES } from "../src/passthrough.ts";
import { createPlayground } from "../src/server.ts";
import { COMPLETE } from "./fixtures.ts";

// A guardian's token, another family's the platform does not know, and the
// operator's, all in the shape the platform gives its tokens.
const TOKEN = "ab".repeat(32);
const STRANGER = "cd".repeat(32);
const ADMIN = "ef".repeat(32);
const FAMILY = "0193a1f0-0000-7000-8000-000000000001";
const CHILD = "0193a1f0-0000-7000-8000-000000000101";
const SESSION = "0193a1f0-0000-7000-8000-000000000201";
const NOTICE = "0193a1f0-0000-7000-8000-000000000301";
const MEMORY = "0193a1f0-0000-7000-8000-000000000401";
const DEVICE = "0193a1f0-0000-7000-8000-000000000501";

type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: string };
const seen: Seen[] = [];
// The platform takes a second to answer GET /v1/notices while this is set.
let slow = false;

// Stands in for the platform: it answers with what it was asked, and sets a
// cookie and a header of its own that must not reach the app.
const platform = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  seen.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
  if (slow && request.url === "/v1/notices") await delay(1_000);
  if (request.headers.authorization === `Bearer ${STRANGER}`) {
    response.writeHead(401, { "Content-Type": "application/json" });
    return response.end(JSON.stringify({ error: { code: "unauthorized", message: "missing or wrong credentials" } }));
  }
  if (request.url === "/v1/auth/signout") {
    response.writeHead(204, { "Set-Cookie": "platform=1" });
    return response.end();
  }
  response.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "platform=1", "X-Platform": "yes" });
  response.end(JSON.stringify({ method: request.method, url: request.url }));
});

let page: Server;
let quick: Server;
let base = "";
let quickBase = "";
const portOf = (server: Server) => (server.address() as AddressInfo).port;

before(async () => {
  await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
  const settings = readSettings({
    ...COMPLETE,
    AULE_PLATFORM_URL: `http://127.0.0.1:${portOf(platform)}`,
    AULE_ADMIN_TOKEN: ADMIN,
    // As in production: https://playground.meetaule.com/session/api/v1.
    PLAYGROUND_BASE_PATH: "/session",
  });
  page = createPlayground(settings);
  // The same, with limits short enough to wait for.
  quick = createPlayground(settings, undefined, { ...LIMITS, bodyMs: 200, platformMs: 200 });
  for (const server of [page, quick]) await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${portOf(page)}/session/api/v1`;
  quickBase = `http://127.0.0.1:${portOf(quick)}/session/api/v1`;
});
after(() => {
  page.close();
  quick.close();
  platform.close();
});
beforeEach(() => {
  seen.length = 0;
  slow = false;
});

type Call = { token?: string | null; body?: unknown; headers?: Record<string, string>; on?: string };
const call = (method: string, path: string, { token = TOKEN, body, headers = {}, on = base }: Call = {}) =>
  fetch(`${on}/${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

/**
 * A request written byte for byte, as fetch would not send it (an address it
 * would tidy, a body in pieces a while apart), to `server`. What came back, and
 * its status, or "closed" when the connection ended with no answer.
 */
function exchange(server: Server, head: string, pieces: string[] = [], pauseMs = 0) {
  return new Promise<{ status: number | "closed"; reply: string }>((resolve) => {
    let reply = "";
    const socket = connect(portOf(server), "127.0.0.1", async () => {
      socket.write(`${head}\r\nHost: playground\r\n\r\n`);
      for (const piece of pieces) {
        if (pauseMs) await delay(pauseMs);
        if (!socket.destroyed) socket.write(piece);
      }
    });
    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => socket.destroy());
    socket.on("data", (chunk: string) => {
      reply += chunk;
      // One answer is all a test waits for.
      if (/\r\n\r\n/.test(reply)) socket.end();
    });
    // A write after the server closed fails; what it answered is still in `reply`.
    socket.on("error", () => undefined);
    socket.on("close", () => resolve({ status: reply ? Number(reply.split(" ")[1]) : "closed", reply }));
  });
}
const raw = async (head: string, pieces: string[] = [], pauseMs = 0) => (await exchange(page, head, pieces, pauseMs)).status;

// Every call the app makes (lib/core/api/http_aule_api.dart and
// lib/features/device/data/http_device_api.dart), with a body where it sends one.
const APP_CALLS: [string, string, unknown?][] = [
  ["POST", "auth/start", { email: "ana@example.org", language: "es" }],
  ["POST", "auth/verify", { email: "ana@example.org", code: "123456", language: "es" }],
  ["GET", "auth/google"],
  ["POST", "auth/google", { credential: "a-google-id-token", language: "es" }],
  ["POST", "auth/signout"],
  ["GET", "me"],
  ["PUT", "me", { language: "en", notices_by_email: false }],
  ["DELETE", "me", { confirm_email: "ana@example.org" }],
  ["POST", `families/${FAMILY}/children`, { nickname: "Mati", interests: ["fútbol"] }],
  ["GET", `children/${CHILD}`],
  ["PUT", `children/${CHILD}`, { nickname: "Mati" }],
  ["DELETE", `children/${CHILD}`],
  ["POST", `children/${CHILD}/consents`, { purpose: "voice", granted: true, policy_version: "app-2026-11-v2", locale: "es-PE" }],
  ["GET", `children/${CHILD}/reviews`],
  ["GET", `children/${CHILD}/skills`],
  ["GET", `children/${CHILD}/sessions?limit=20`],
  ["GET", `children/${CHILD}/memories?limit=100`],
  ["DELETE", `children/${CHILD}/memories/${MEMORY}`],
  ["GET", "skills"],
  ["GET", `sessions/${SESSION}`],
  ["POST", `sessions/${SESSION}/end`],
  ["GET", "notices"],
  ["POST", `notices/${NOTICE}/read`],
  ["GET", "devices"],
  ["POST", "devices/claim", { code: "K7QM2X", child_id: CHILD }],
  ["PUT", `devices/${DEVICE}`, { child_id: CHILD }],
  ["DELETE", `devices/${DEVICE}`],
];

const UUIDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

test("the routes passed on are exactly the app's calls", () => {
  const calls = APP_CALLS.map(([method, path]) => `${method} ${path.split("?")[0]?.replace(UUIDS, "{id}")}`);
  assert.deepEqual(ROUTES.map((route) => `${route.method} ${route.path}`).sort(), calls.sort());
  // Signing in is all that goes on without a bearer.
  assert.deepEqual(
    ROUTES.filter((route) => route.open).map((route) => `${route.method} ${route.path}`),
    ["POST auth/start", "POST auth/verify", "GET auth/google", "POST auth/google"],
  );
});

test("each of the app's calls reaches the platform's /v1 as it was made, and its answer comes back", async () => {
  for (const [method, path, body] of APP_CALLS) {
    seen.length = 0;
    const response = await call(method, path, { body });
    const what = `${method} ${path}`;
    assert.equal(seen.length, 1, what);
    assert.equal(seen[0]!.method, method, what);
    assert.equal(seen[0]!.url, `/v1/${path}`, what);
    assert.equal(seen[0]!.headers.authorization, `Bearer ${TOKEN}`, what);
    assert.equal(seen[0]!.body, body === undefined ? "" : JSON.stringify(body), what);
    if (path === "auth/signout") {
      assert.equal(response.status, 204, what);
      assert.equal(await response.text(), "");
      continue;
    }
    assert.equal(response.status, 200, what);
    assert.equal(response.headers.get("content-type"), "application/json", what);
    assert.deepEqual(await response.json(), { method, url: `/v1/${path}` }, what);
  }
});

test("only the bearer and the body's type go on: no cookie, no address, nothing else the request carried", async () => {
  const response = await call("PUT", "me", {
    body: { language: "en" },
    headers: {
      Cookie: `aule_guardian=${STRANGER}; aule_source=feria`,
      "X-Forwarded-For": "203.0.113.7",
      "X-Real-IP": "203.0.113.8",
      "CF-Connecting-IP": "203.0.113.9",
      "X-Edge-Secret": "an-edge-secret",
      Origin: "https://evil.example",
      Referer: "https://evil.example/page",
      "User-Agent": "the-app/0.1.0",
      "Accept-Language": "es-PE",
      Accept: "application/json",
      "X-Custom": "a-marker",
    },
  });
  assert.equal(response.status, 200);
  const sent = seen[0]!.headers;
  assert.equal(sent.authorization, `Bearer ${TOKEN}`);
  assert.equal(sent["content-type"], "application/json");
  // The platform is told which build of the page asks, as on every other call.
  assert.match(sent["user-agent"] ?? "", /^aule-playground\//);
  for (const name of ["cookie", "x-forwarded-for", "x-real-ip", "cf-connecting-ip", "x-edge-secret", "origin", "referer", "x-custom"]) {
    assert.equal(sent[name], undefined, name);
  }
  const all = JSON.stringify(sent);
  for (const value of [STRANGER, "feria", "203.0.113", "an-edge-secret", "evil.example", "the-app", "es-PE", "a-marker"]) {
    assert.ok(!all.includes(value), value);
  }
  // And only the type comes back of the platform's own headers: no cookie of its own.
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("x-platform"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

const WRONG = { error: { code: "unauthorized", message: "missing or wrong credentials" } };

test("the operator's token is refused as a wrong one is, on every route, and reaches nothing", async (t) => {
  const logged = t.mock.method(console, "error", () => undefined);
  for (const [method, path, body] of [["GET", "me"], ["POST", "auth/start", { email: "ana@example.org" }], ["GET", `children/${CHILD}`], ["POST", `sessions/${SESSION}/end`]] as const) {
    const response = await call(method, path, { token: ADMIN, body });
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.deepEqual(await response.json(), WRONG, `${method} ${path}`);
  }
  // A token that is not one is answered the same.
  const malformed = await call("GET", "me", { token: "not-a-token" });
  assert.equal(malformed.status, 401);
  assert.deepEqual(await malformed.json(), WRONG);
  assert.equal(seen.length, 0);
  // It is out where it should not be, and the log says so, without it.
  assert.equal(logged.mock.callCount(), 4);
  for (const entry of logged.mock.calls) assert.ok(!JSON.stringify(entry.arguments).includes(ADMIN));
});

test("no bearer, no way in, but to sign in; and a cookie is no bearer", async () => {
  for (const [method, path] of [["GET", "me"], ["GET", `children/${CHILD}/sessions`], ["POST", `sessions/${SESSION}/end`], ["DELETE", "me"]]) {
    const response = await call(method!, path!, { token: null });
    assert.equal(response.status, 401, path);
    assert.deepEqual(await response.json(), WRONG);
  }
  const cookie = await call("GET", "me", { token: null, headers: { Cookie: `aule_guardian=${TOKEN}` } });
  assert.equal(cookie.status, 401, "the page's cookie does not sign the app in");
  assert.equal(seen.length, 0);

  // Signing in has no bearer to send, and none goes on.
  const start = await call("POST", "auth/start", { token: null, body: { email: "ana@example.org" } });
  assert.equal(start.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.headers.authorization, undefined);
  assert.equal(seen[0]!.url, "/v1/auth/start");
});

test("an Authorization that is not a session's bearer is refused, signing in too", async () => {
  for (const header of [
    `Basic ${Buffer.from(`ana:${TOKEN}`).toString("base64")}`,
    "Bearer",
    "Bearer ",
    `bearer ${TOKEN}`,
    `Bearer  ${TOKEN}`,
    `Bearer ${TOKEN} ${TOKEN}`,
    `Bearer ${TOKEN.toUpperCase()}`,
    `Bearer ${TOKEN.slice(1)}`,
    `Bearer ${TOKEN}0`,
    `Bearer ${TOKEN},Bearer ${STRANGER}`,
  ]) {
    for (const path of ["me", "auth/start"]) {
      const response = await call(path === "me" ? "GET" : "POST", path, {
        token: null,
        headers: { Authorization: header },
        ...(path === "me" ? {} : { body: { email: "ana@example.org" } }),
      });
      assert.equal(response.status, 401, `${header} on ${path}`);
    }
  }
  assert.equal(seen.length, 0);
});

test("whatever the app does not call is refused, even with a guardian's bearer, and reaches nothing", async () => {
  for (const [method, path, body] of [
    // Starting a session is the child's device's or the page's, never the app's.
    ["POST", "sessions", { child_id: CHILD, audience: "child" }],
    ["POST", "sessions", { audience: "operator" }],
    // The team's.
    ["GET", "admin/families"],
    ["GET", `admin/families/${FAMILY}`],
    ["GET", "admin/sessions/open"],
    ["POST", `admin/families/${FAMILY}/grant`, { days: 30 }],
    ["GET", "admin/passkeys"],
    ["POST", "auth/team/start", { email: "team@example.org" }],
    ["POST", "auth/team/verify", { email: "team@example.org", code: "123456" }],
    ["GET", "metrics/daily"],
    ["GET", "metrics/weekly"],
    // The agent's.
    ["GET", "agent/session"],
    ["POST", "agent/session/turns", { turns: [] }],
    ["POST", "agent/session/end", {}],
    // The devices' own, and the operator's for them.
    ["POST", "ota/", {}],
    ["POST", "ota/activate", {}],
    ["POST", "ota/session", {}],
    ["POST", "devices", { serial_number: "x" }],
    ["POST", "firmware", {}],
    ["GET", "healthz"],
    // The operator's, and what the app has no use for.
    ["POST", "families", { name: "x" }],
    ["PUT", "skills", { skills: [] }],
    ["GET", `sessions/${SESSION}/supervisor`],
    ["GET", `sessions/${SESSION}/step`],
    ["POST", `sessions/${SESSION}/answers`, { answer: "3" }],
    ["POST", `sessions/${SESSION}/join`, { mode: "listen" }],
    ["POST", `children/${CHILD}/attempts`, { attempts: [], source: "guardian" }],
    ["POST", `children/${CHILD}/corrections`, { skill_id: "x", level: 1 }],
    ["GET", "me/plan"],
    ["PUT", "push/tokens", { token: "x", platform: "android" }],
    ["GET", "auth/providers"],
    ["POST", "auth/github", { code: "x" }],
    ["POST", "auth/apple", { code: "x" }],
    // The app's routes with another method, or not quite their address.
    ["POST", "me", {}],
    ["PATCH", "me", {}],
    ["HEAD", "me"],
    ["OPTIONS", "me"],
    ["GET", "auth/start"],
    ["GET", "me/"],
    ["GET", "children"],
    ["GET", "children/not-an-id"],
    ["GET", `children/${CHILD}/sessions/facts`],
    ["GET", `children/${CHILD}x`],
    ["GET", `children/${CHILD}/memories/${MEMORY}`],
    ["DELETE", `children/${CHILD}/memories/not-an-id`],
    ["GET", `families/${FAMILY}/children`],
    ["GET", ""],
  ] as [string, string, unknown?][]) {
    const response = await call(method, path, { body });
    assert.equal(response.status, 404, `${method} ${path}`);
    if (method !== "HEAD") {
      assert.deepEqual(await response.json(), { error: { code: "not_found", message: "route not found" } }, `${method} ${path}`);
    }
  }
  assert.equal(seen.length, 0);
});

test("an address written to slip past the list goes nowhere", async () => {
  const bearer = `Authorization: Bearer ${TOKEN}`;
  for (const target of [
    "/session/api/v1/../v1/admin/families",
    "/session/api/v1/me/../admin/families",
    "/session/api/v1/%2e%2e/v1/agent/session",
    "/session/api/v1/children/%2e%2e/admin/families",
    `/session/api/v1/children/${CHILD}%2Fsessions`,
    `/session/api/v1/children/${CHILD}%2F..%2F..%2Fadmin%2Ffamilies`,
    "/session/api/v1/m%65",
    "/session/api/v1/%2Fhealthz",
    "/session/api/v1/..%2f..%2fhealthz",
    "/session/api/v1/me%00",
    "/session/api/v1/me;x=1",
    "/session/api/admin/families",
    "/api/v1/me",
  ]) {
    assert.equal(await raw(`GET ${target} HTTP/1.1\r\n${bearer}`), 404, target);
  }
  // A doubled slash is folded, as everywhere on the page: the same route, passed on as one.
  assert.equal(await raw(`GET /session/api/v1//me HTTP/1.1\r\n${bearer}`), 200);
  assert.deepEqual(seen.map((request) => request.url), ["/v1/me"]);
});

test("a query goes on only as the route takes it: a number, once", async () => {
  for (const [path, forwarded] of [
    [`children/${CHILD}/sessions?limit=20`, `/v1/children/${CHILD}/sessions?limit=20`],
    [`children/${CHILD}/sessions`, `/v1/children/${CHILD}/sessions`],
    [`children/${CHILD}/memories?limit=100`, `/v1/children/${CHILD}/memories?limit=100`],
    ["me?", "/v1/me"],
  ]) {
    seen.length = 0;
    assert.equal((await call("GET", path!)).status, 200, path);
    assert.equal(seen[0]?.url, forwarded, path);
  }
  seen.length = 0;
  for (const path of [
    `children/${CHILD}/memories?query=lo-que-dijo`,
    `children/${CHILD}/memories?limit=10&query=x`,
    `children/${CHILD}/sessions?limit=abc`,
    `children/${CHILD}/sessions?limit=-1`,
    `children/${CHILD}/sessions?limit=1000`,
    `children/${CHILD}/sessions?limit=20&limit=30`,
    `children/${CHILD}/sessions?before=x`,
    "me?limit=5",
    "notices?x=1",
  ]) {
    const response = await call("GET", path);
    assert.equal(response.status, 400, path);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "bad_request");
  }
  assert.equal(seen.length, 0);
});

test("a body goes on as it came, as JSON and up to its limit", async () => {
  // The largest body that goes on, byte for byte.
  const padding = "x".repeat(LIMITS.bodyBytes - JSON.stringify({ nickname: "Mati", notes: "" }).length);
  const largest = JSON.stringify({ nickname: "Mati", notes: padding });
  assert.equal(Buffer.byteLength(largest), LIMITS.bodyBytes);
  assert.equal((await call("PUT", `children/${CHILD}`, { body: largest })).status, 200);
  assert.equal(seen.at(-1)?.body, largest);

  seen.length = 0;
  // One byte more is refused, and the connection goes with what is left of it:
  // said up front, nothing of it is read...
  const put = `PUT /session/api/v1/children/${CHILD} HTTP/1.1\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json`;
  const declared = await exchange(page, `${put}\r\nContent-Length: ${LIMITS.bodyBytes + 1}`);
  assert.equal(declared.status, 413);
  assert.match(declared.reply, /\r\nConnection: close\r\n/i);
  assert.match(declared.reply, /"code":"too_large"/);
  // ...and sent in pieces, reading stops at the one that goes past.
  const piece = "x".repeat(LIMITS.bodyBytes / 4);
  const pieces = [...Array.from({ length: 4 }, () => `${piece.length.toString(16)}\r\n${piece}\r\n`), "1\r\nx\r\n"];
  const chunked = await exchange(page, `${put}\r\nTransfer-Encoding: chunked`, pieces, 20);
  assert.equal(chunked.status, 413);
  assert.match(chunked.reply, /\r\nConnection: close\r\n/i);

  // A body that is not said to be JSON is not passed on.
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonx"]) {
    const response = await call("POST", "auth/start", { token: null, body: '{"email":"ana@example.org"}', headers: { "Content-Type": type } });
    assert.equal(response.status, 400, type);
  }
  const untyped = await fetch(`${base}/auth/start`, { method: "POST", body: new Uint8Array(Buffer.from('{"email":"ana@example.org"}')) });
  assert.equal(untyped.status, 400, "no type at all");
  assert.equal(seen.length, 0);

  // JSON with its charset is JSON; it goes on as plain application/json.
  assert.equal((await call("POST", "auth/start", { token: null, body: { email: "ana@example.org" }, headers: { "Content-Type": "application/json; charset=utf-8" } })).status, 200);
  assert.equal(seen[0]?.headers["content-type"], "application/json");
  // A GET carries no body to the platform.
  seen.length = 0;
  await raw(`GET /session/api/v1/me HTTP/1.1\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 2`, ["{}"]);
  assert.equal(seen[0]?.body, "");
  assert.equal(seen[0]?.headers["content-type"], undefined);
});

test("the platform's answer comes back as it is, a refusal of its own included", async () => {
  const refused = await call("GET", "me", { token: STRANGER });
  assert.equal(refused.status, 401);
  assert.deepEqual(await refused.json(), WRONG);
  assert.equal(seen.length, 1, "a token of the right shape is the platform's to judge");
  assert.equal(seen[0]!.headers.authorization, `Bearer ${STRANGER}`);
});

test("a body sent too slowly loses the connection, and a platform too slow to answer gets a 503", async (t) => {
  const logged = t.mock.method(console, "error", () => undefined);
  // A few bytes of the hundred it said, then nothing: cut off once its time is up.
  const started = Date.now();
  const head = `PUT /session/api/v1/me HTTP/1.1\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 100`;
  const trickle = await exchange(quick, head, ['{"language"']);
  assert.equal(trickle.status, "closed");
  assert.ok(Date.now() - started < 2_000, "closed by the page, not by the test");
  assert.equal(seen.length, 0);

  slow = true;
  const late = await call("GET", "notices", { on: quickBase });
  assert.equal(late.status, 503);
  assert.deepEqual(await late.json(), { error: { code: "unavailable", message: "the platform did not answer; try again" } });
  assert.equal(seen.length, 1, "it was asked");
  // The log names the route's shape, nothing of the request.
  assert.deepEqual(
    logged.mock.calls.map((entry) => entry.arguments),
    [["app api: the platform did not answer GET /v1/notices"]],
  );
});

test("nothing of a request is logged on its way through", async (t) => {
  const lines: unknown[][] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    t.mock.method(console, level, (...args: unknown[]) => lines.push(args));
  }
  for (const [method, path, body] of APP_CALLS) await call(method, path, { body });
  await call("GET", "me", { token: STRANGER });
  await call("GET", "admin/families");
  await call("GET", "me", { token: null });
  await call("GET", `children/${CHILD}/memories?query=lo-que-dijo`);
  await exchange(page, `PUT /session/api/v1/me HTTP/1.1\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Length: ${LIMITS.bodyBytes + 1}`);
  assert.deepEqual(lines, []);
});

test("without a platform there is nothing to pass on", async () => {
  const alone = createPlayground(readSettings({ ...COMPLETE, PLAYGROUND_BASE_PATH: "/session" }));
  await new Promise<void>((resolve) => alone.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${portOf(alone)}/session/api/v1/me`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: { code: "not_found", message: "route not found" } });
  } finally {
    alone.close();
  }
});
