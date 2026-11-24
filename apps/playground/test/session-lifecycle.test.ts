import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { ParticipantInfo } from "livekit-server-sdk";
import { readSettings } from "../src/config.ts";
import { createPlayground } from "../src/server.ts";
import { COMPLETE } from "./fixtures.ts";

const TOKEN = "ab".repeat(32);
const ID = "01a1f5f4-ede7-7028-a524-9d8e2f36b92c";
const CHILD = "02a1f5f4-ede7-7028-a524-9d8e2f36b92c";
const started = { session_id: ID, serverUrl: "wss://example.org", token: "original", room: "synthetic", agentName: "aule-tutor", expiresInSeconds: 600 };
let lifecycle: Record<string, unknown>;
let authorization = 200;
let failure = false;
let members: ParticipantInfo[];
let creates = 0;
let endings = 0;
let deletions = 0;
let reads = 0;
const backend = createServer(async (request, response) => {
  for await (const _ of request) { /* drain synthetic body */ }
  response.setHeader("Content-Type", "application/json");
  if (request.headers.authorization !== `Bearer ${TOKEN}` || authorization !== 200) {
    response.writeHead(authorization !== 200 ? authorization : 401);
    return response.end('{"error":{"message":"unavailable"}}');
  }
  if (request.url === "/v1/sessions") { creates++; return response.end(JSON.stringify(started)); }
  if (request.url === `/v1/sessions/${ID}/end`) { endings++; return response.end("{}"); }
  if (request.url === `/v1/sessions/${ID}`) { reads++; return response.end(JSON.stringify(lifecycle)); }
  response.writeHead(404); response.end("{}");
});
let page: ReturnType<typeof createPlayground>;
let base = "";
let cookie = "";
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/${path}`, {
  method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, ...headers }, body: JSON.stringify(body),
});
const get = () => fetch(`${base}/api/session/recovery`, { headers: { Cookie: cookie } });
before(async () => {
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
  page = createPlayground(readSettings({ ...COMPLETE, AULE_PLATFORM_URL: url, AULE_ADMIN_TOKEN: "operator", AULE_FREE_ACCESS: "1" }), {
    async listParticipants() { if (failure) throw new Error("synthetic unavailable"); return members; },
    async deleteRoom() { deletions++; lifecycle.status = "ended"; },
  });
  await new Promise<void>(resolve => page.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(page.address() as AddressInfo).port}/playground`;
});
after(() => { page.close(); backend.close(); });
beforeEach(async () => {
  lifecycle = { status: "active", can_resume: true, remaining_seconds: 450, end_reason: null, language: "es" };
  authorization = 200; failure = false; creates = 0; endings = 0; deletions = 0; reads = 0;
  members = [new ParticipantInfo({ kind: 4, identity: "tutor" })];
  cookie = `aule_guardian=${TOKEN}`;
  // A fresh browser has no previous ticket. Free access keeps each fixture independent.
  const response = await post("session", { student_id: CHILD, language: "es" });
  assert.equal(response.status, 200, await response.text());
  cookie += "; " + response.headers.get("set-cookie")!.split(";")[0];
});

test("reload resumes one room with its remaining deadline without creating another session", async () => {
  const response = await get();
  assert.equal(response.headers.get("cache-control"), "no-store");
  const offered = await response.json();
  assert.equal(offered.available, true);
  assert.equal(offered.token, undefined);
  assert.equal(offered.student_id, CHILD);
  const resumed = await post("session/resume", { session_id: ID, student_id: CHILD });
  assert.equal(resumed.status, 200);
  const session = await resumed.json();
  assert.equal(session.session_id, ID);
  assert.equal(session.room, started.room);
  assert.equal(session.expiresInSeconds, 450);
  assert.notEqual(session.token, started.token);
  assert.equal(creates, 1);
  assert.equal((await post("session", { student_id: CHILD })).status, 409);
});

test("wrong account, revoked access and wrong profile never receive a room token", async () => {
  assert.equal((await post("session/resume", { session_id: ID, student_id: "another" })).status, 409);
  const another = cookie.replace(TOKEN, "cd".repeat(32));
  assert.equal((await (await fetch(`${base}/api/session/recovery`, { headers: { Cookie: another } })).json()).available, false);
  assert.equal((await (await get()).json()).available, true, "another owner cannot destroy the original ticket");
  lifecycle.can_resume = false;
  assert.equal((await (await post("session/resume", { session_id: ID, student_id: CHILD })).json()).token, undefined);
  authorization = 404;
  assert.equal((await (await get()).json()).available, false);
});

test("a missing tutor cannot be redispatched and a temporary API failure can be retried", async () => {
  failure = true;
  assert.equal((await get()).status, 503);
  failure = false;
  assert.equal((await (await get()).json()).available, true);
  members = [];
  assert.equal((await (await post("session/resume", { session_id: ID, student_id: CHILD })).json()).token, undefined);
  lifecycle = { ...lifecycle, status: "ended", can_resume: false, end_reason: "provider_error" };
  assert.equal((await (await get()).json()).end_reason, "provider_error", "cleanup reason remains readable after room deletion");
  assert.equal(creates, 1);
});

test("an old tab or a different origin cannot close the newer session", async () => {
  assert.equal((await post("session/end", { session_id: "older" })).status, 409);
  assert.equal((await post("session/end", { session_id: ID }, { Origin: "https://other.example.org" })).status, 403);
  assert.equal(endings, 0);
  assert.equal((await post("session/end", { session_id: ID })).status, 200);
  assert.equal(endings, 1); assert.equal(deletions, 1);
  assert.equal((await (await get()).json()).available, false);
});

test("a participant in another tab cannot be replaced by resume", async () => {
  members.push(new ParticipantInfo({ kind: 0, identity: "child" }));
  assert.equal((await post("session/resume", { session_id: ID, student_id: CHILD })).status, 409);
});

test("a session its tutor never started closes at once and gives its day's session back; a started one keeps it", async () => {
  const url = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
  const capped = createPlayground(readSettings({ ...COMPLETE, AULE_PLATFORM_URL: url, AULE_ADMIN_TOKEN: "operator", PLAYGROUND_DAILY_SESSIONS: "1" }), {
    async listParticipants() { return members; },
    async deleteRoom() { deletions++; lifecycle.status = "ended"; },
  });
  await new Promise<void>(resolve => capped.listen(0, "127.0.0.1", resolve));
  const at = `http://127.0.0.1:${(capped.address() as AddressInfo).port}/playground/api`;
  let jar = `aule_guardian=${TOKEN}`;
  const send = async (path: string, body: unknown) => {
    const response = await fetch(`${at}/${path}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: jar }, body: JSON.stringify(body) });
    const ticket = response.headers.get("set-cookie");
    if (ticket?.startsWith("aule_recovery=")) jar = `aule_guardian=${TOKEN}; ${ticket.split(";")[0]}`;
    return response;
  };
  try {
    // Aule never arrived: the platform still has the session as created, never started.
    lifecycle.status = "created";
    assert.equal((await send("session", { student_id: CHILD })).status, 200);
    reads = 0;
    endings = 0;
    assert.equal((await send("session/end", { session_id: ID })).status, 200);
    assert.equal(endings, 1);
    assert.equal(reads, 1, "nothing to flush: no waiting for the tutor to close it");
    // So the family can try again today, with the one session the day has.
    lifecycle.status = "active";
    assert.equal((await send("session", { student_id: CHILD })).status, 200);
    // A session the tutor started is the day's, ended or not.
    assert.equal((await send("session/end", { session_id: ID })).status, 200);
    assert.equal(endings, 2);
    const again = await send("session", { student_id: CHILD });
    assert.equal(again.status, 429);
    assert.deepEqual(await again.json(), { error: "daily_limit" });
  } finally {
    capped.close();
  }
});
