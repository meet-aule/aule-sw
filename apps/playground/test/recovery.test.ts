import assert from "node:assert/strict";
import { test } from "node:test";
import { RecoveryTickets, recoveryCookie, recoveryTicket, resumeToken } from "../src/recovery.ts";
import { readSettings } from "../src/config.ts";
import type { IncomingMessage } from "node:http";
import { TokenVerifier } from "livekit-server-sdk";
import { COMPLETE } from "./fixtures.ts";

const SESSION = {
  session_id: "01a1f5f4-ede7-7028-a524-9d8e2f36b92c", token: "original",
  serverUrl: "wss://example.org", room: "synthetic-room", agentName: "aule-tutor", expiresInSeconds: 600,
};
test("encrypted tickets survive restart, belong to one sign-in and keep the original deadline", () => {
  let now = 0;
  const settings = readSettings(COMPLETE);
  const store = new RecoveryTickets(settings, () => now);
  const ticket = store.remember("guardian", "student", SESSION);
  assert.match(ticket, /^v1\.[A-Za-z0-9_-]+$/);
  assert.ok(recoveryCookie(ticket, "/session", 900).length < 4096);
  assert.equal(store.get(ticket, "other"), null);
  now = 120_000;
  const restarted = new RecoveryTickets(settings, () => now);
  assert.equal(restarted.get(ticket, "guardian")?.expires, 600_000);
  assert.equal(restarted.get(ticket, "guardian")?.session.room, SESSION.room);
  now = 600_001;
  assert.ok(restarted.get(ticket, "guardian"), "retain lifecycle briefly to explain expiry");
  now = 900_000;
  assert.equal(restarted.get(ticket, "guardian"), null);
});
test("tickets hide routing, omit credentials and reject tampering, old formats and key or app changes", () => {
  const settings = readSettings(COMPLETE);
  const store = new RecoveryTickets(settings);
  const upstream = { ...SESSION, metadata: "private" };
  const ticket = store.remember("guardian", "student", upstream);
  const entry = store.get(ticket, "guardian")!;
  assert.equal("token" in entry.session, false);
  assert.equal("metadata" in entry.session, false);
  const bytes = Buffer.from(ticket.slice(3), "base64url");
  for (const text of ["guardian", "student", SESSION.room, SESSION.session_id, "original", "private"]) {
    assert.equal(bytes.includes(Buffer.from(text)), false);
  }
  assert.notEqual(store.remember("guardian", "student", SESSION), ticket, "each encryption has a fresh IV");
  for (const position of [0, 12, 28, bytes.length - 1]) {
    const changed = Buffer.from(bytes);
    changed[position] ^= 1;
    assert.equal(store.get(`v1.${changed.toString("base64url")}`, "guardian"), null);
  }
  for (const invalid of [null, "", "a".repeat(64), ticket.replace("v1.", "v2."), ticket.slice(0, -8), `v1.${"a".repeat(3001)}`]) {
    assert.equal(store.get(invalid, "guardian"), null);
  }
  for (const other of [
    { ...settings, livekitApiSecret: "rotated" },
    { ...settings, livekitApiKey: "another-key" },
    { ...settings, basePath: "/another-app" },
  ]) assert.equal(new RecoveryTickets(other).get(ticket, "guardian"), null);
});
test("invalid routing or deadlines cannot be recovered and large cookies are refused", () => {
  const store = new RecoveryTickets(readSettings(COMPLETE));
  for (const changed of [
    { session_id: "../another" }, { expiresInSeconds: NaN }, { expiresInSeconds: -1 },
    { serverUrl: "javascript:invalid" }, { room: "" },
  ]) {
    const ticket = store.remember("guardian", "student", { ...SESSION, ...changed });
    assert.equal(store.get(ticket, "guardian"), null);
  }
  assert.throws(() => store.remember("guardian", "student", { ...SESSION, room: "x".repeat(4000) }), /cookie limit/);
});
test("ticket cookie is scoped, HttpOnly, Secure and not available cross-site", () => {
  const ticket = new RecoveryTickets(readSettings(COMPLETE)).remember("guardian", "student", SESSION);
  const cookie = recoveryCookie(ticket, "/session", 61.9);
  assert.match(cookie, /Max-Age=61; Path=\/session\/; HttpOnly; Secure; SameSite=Strict$/);
  assert.equal(recoveryTicket({ headers: { cookie } } as IncomingMessage), ticket);
  assert.equal(recoveryTicket({ headers: { cookie: "aule_recovery=bad" } } as IncomingMessage), null);
});
test("resume token keeps the identity and room without redispatching a tutor or granting administration", async () => {
  const settings = readSettings(COMPLETE);
  const store = new RecoveryTickets(settings);
  const entry = store.get(store.remember("guardian", "student", SESSION), "guardian")!;
  const token = await resumeToken(settings, entry, 42);
  const claims = await new TokenVerifier(COMPLETE.LIVEKIT_API_KEY, COMPLETE.LIVEKIT_API_SECRET).verify(token);
  assert.equal(claims.sub, `child-${SESSION.session_id.replaceAll("-", "")}`);
  assert.equal(claims.video?.room, SESSION.room);
  assert.equal(claims.video?.roomAdmin, undefined);
  assert.equal(claims.roomConfig, undefined);
  assert.ok(Number(claims.exp) <= Math.floor(Date.now() / 1000) + 42);
});
