import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { TokenVerifier } from "livekit-server-sdk";

import { readSettings } from "../src/config.ts";
import { createPlayground } from "../src/server.ts";
import { COMPLETE } from "./fixtures.ts";

const settings = readSettings(COMPLETE);
const server = createPlayground(settings);
let base = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/playground`;
});
after(() => server.close());

const start = (body: unknown) =>
  fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("serves the page and its scripts with a strict policy", async () => {
  for (const path of [
    "/",
    "/app.js",
    "/signin.js",
    "/visuals.js",
    "/tokens.css",
    "/style.css",
    "/livekit-client.js",
    "/wobnimo.js",
    "/fonts/InterVariable.woff2",
    "/fonts/Inter-LICENSE.txt",
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    await response.arrayBuffer();
  }
  const policy = (await fetch(`${base}/`)).headers.get("content-security-policy") ?? "";
  assert.match(policy, /connect-src 'self' wss:\/\/livekit\.example\.org https:\/\/livekit\.example\.org/);
});

test("redirects the bare path and hides everything outside it", async () => {
  const bare = await fetch(base, { redirect: "manual" });
  assert.equal(bare.status, 308);
  assert.equal(bare.headers.get("location"), "/playground/");

  assert.equal((await fetch(base.replace("/playground", "/"))).status, 404);
  assert.equal((await fetch(`${base}/../etc/passwd`)).status, 404);
  assert.equal((await fetch(`${base}/api/session`)).status, 405);
});

test("refuses a wrong or missing code", async () => {
  for (const body of [{ code: "nope" }, {}, { code: 42 }]) {
    const response = await start(body);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "wrong_code" });
  }
  assert.equal((await start("not json")).status, 400);
  assert.equal((await start(JSON.stringify({ code: "x".repeat(5_000) }))).status, 400);
});

test("the right code gets a token for one room that asks for the tutor as an operator", async () => {
  const response = await start({ code: COMPLETE.PLAYGROUND_ACCESS_CODE, language: "en" });
  assert.equal(response.status, 200);
  const session = await response.json();

  assert.equal(session.serverUrl, "wss://livekit.example.org");
  assert.match(session.room, /^playground-[\w-]{12}$/);
  assert.equal(session.expiresInSeconds, 1200);

  const verifier = new TokenVerifier(COMPLETE.LIVEKIT_API_KEY, COMPLETE.LIVEKIT_API_SECRET);
  const claims = await verifier.verify(session.token);
  assert.equal(claims.video?.room, session.room);
  assert.equal(claims.video?.roomJoin, true);
  assert.deepEqual(claims.video?.canPublishSources, ["microphone", "camera"]);
  assert.ok(!claims.video?.roomAdmin && !claims.video?.roomCreate && !claims.video?.roomList);

  const [dispatch] = claims.roomConfig?.agents ?? [];
  assert.equal(dispatch?.agentName, "aule-tutor");
  assert.deepEqual(JSON.parse(dispatch?.metadata ?? "{}"), { audience: "operator", language: "en" });
});

test("an unknown language falls back to Spanish", async () => {
  const response = await start({ code: COMPLETE.PLAYGROUND_ACCESS_CODE, language: "fr" });
  const claims = await new TokenVerifier(
    COMPLETE.LIVEKIT_API_KEY,
    COMPLETE.LIVEKIT_API_SECRET,
  ).verify((await response.json()).token);

  assert.equal(JSON.parse(claims.roomConfig?.agents?.[0]?.metadata ?? "{}").language, "es");
});

test("too many wrong codes lock the endpoint, even for the right one", async () => {
  const locked = createPlayground(settings);
  await new Promise<void>((resolve) => locked.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(locked.address() as AddressInfo).port}/playground/api/session`;
  const post = (code: string) =>
    fetch(url, { method: "POST", body: JSON.stringify({ code }) }).then((r) => r.status);
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) assert.equal(await post("guess"), 401);
    assert.equal(await post("guess"), 429);
    assert.equal(await post(COMPLETE.PLAYGROUND_ACCESS_CODE), 429);
  } finally {
    locked.close();
  }
});

const ENGINE_SESSION = "0198c5a0-0000-7000-8000-00000000e001";
const OTHER_SESSION = "0198c5a0-0000-7000-8000-00000000e002";

test("with a platform, the session and the supervisor's view come from it", async () => {
  const seen: { path: string; auth: string | undefined; body: unknown }[] = [];
  const platform = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    seen.push({ path: request.url ?? "", auth: request.headers.authorization, body: text ? JSON.parse(text) : null });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v1/sessions") {
      response.statusCode = 201;
      return response.end(JSON.stringify({ session_id: "s-1", serverUrl: "wss://x", token: "jwt", room: "r" }));
    }
    if (request.url === `/v1/sessions/${ENGINE_SESSION}/step`) {
      return response.end(JSON.stringify({ stage: "Tamizaje", route: [], card: null, closed: false }));
    }
    if (request.url === `/v1/sessions/${ENGINE_SESSION}/answers`) {
      return response.end(JSON.stringify({ stage: "Tamizaje", route: [], card: null, closed: false }));
    }
    if (request.url === `/v1/sessions/${OTHER_SESSION}/step`) {
      response.statusCode = 409;
      return response.end(JSON.stringify({ error: { code: "conflict", message: "not run by the engine" } }));
    }
    if (request.url === "/v1/sessions/s-1/supervisor") {
      return response.end(JSON.stringify({ brief: { goal: "Review" }, guidance: [] }));
    }
    response.statusCode = 403;
    response.end(JSON.stringify({ error: { code: "forbidden", message: "no consent" } }));
  });
  await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
  const childId = "0198c5a0-0000-7000-8000-000000000001";
  const linked = createPlayground(
    readSettings({
      ...COMPLETE,
      AULE_PLATFORM_URL: `http://127.0.0.1:${(platform.address() as AddressInfo).port}/`,
      AULE_ADMIN_TOKEN: "admin-token",
      PLAYGROUND_CHILD_ID: childId,
    }),
  );
  await new Promise<void>((resolve) => linked.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(linked.address() as AddressInfo).port}/playground/api`;
  const post = (path: string, body: object) =>
    fetch(`${url}/${path}`, { method: "POST", body: JSON.stringify(body) });
  try {
    const code = COMPLETE.PLAYGROUND_ACCESS_CODE;
    const session = await post("session", { code, language: "en" });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).session_id, "s-1");
    assert.deepEqual(seen[0], {
      path: "/v1/sessions",
      auth: "Bearer admin-token",
      body: { audience: "operator", language: "en", child_id: childId },
    });

    const view = await post("supervisor", { code, session_id: "s-1" });
    assert.deepEqual(await view.json(), { brief: { goal: "Review" }, guidance: [] });
    assert.equal((await post("supervisor", { code: "wrong", session_id: "s-1" })).status, 401);

    // A session the engine runs: where it stands, and an answer written on the page.
    const step = await post("step", { code, session_id: ENGINE_SESSION });
    assert.deepEqual(await step.json(), { stage: "Tamizaje", route: [], card: null, closed: false });
    assert.equal((await post("step", { code: "wrong", session_id: ENGINE_SESSION })).status, 401);
    assert.equal((await post("step", { code, session_id: "not-an-id" })).status, 400);
    const none = await post("step", { code, session_id: OTHER_SESSION });
    assert.equal(none.status, 409, "the page stops asking about a session the engine does not run");
    assert.deepEqual(await none.json(), { error: "no_step" });
    assert.equal((await post("answer", { code, session_id: ENGINE_SESSION })).status, 400, "an answer needs words");
    const answered = await post("answer", { code, session_id: ENGINE_SESSION, answer: " 3/8 ", explanation: "tres de ocho" });
    assert.equal(answered.status, 200);
    assert.deepEqual(seen.at(-1), {
      path: `/v1/sessions/${ENGINE_SESSION}/answers`,
      auth: "Bearer admin-token",
      body: { answer: "3/8", explanation: "tres de ocho" },
    });

    const refused = await post("supervisor", { code, session_id: "other" });
    assert.equal(refused.status, 502);
    assert.deepEqual(await refused.json(), { error: "platform", message: "no consent" });
  } finally {
    linked.close();
    platform.close();
  }
});

test("without a platform there is no supervisor to ask about", async () => {
  const response = await fetch(`${base}/api/supervisor`, {
    method: "POST",
    body: JSON.stringify({ code: COMPLETE.PLAYGROUND_ACCESS_CODE, session_id: "s-1" }),
  });
  assert.equal(response.status, 404);
});

test("served at the root, the page and its health probe still answer", async () => {
  const root = createPlayground(readSettings({ ...COMPLETE, PLAYGROUND_BASE_PATH: "/" }));
  await new Promise<void>((resolve) => root.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(root.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${origin}/`)).status, 200);
    assert.equal((await fetch(`${origin}/healthz`)).status, 200);
    // What the compose healthcheck asks for when the base path is "/".
    assert.equal((await fetch(`${origin}//healthz`)).status, 200);
  } finally {
    root.close();
  }
});
