import assert from "node:assert/strict";
import { test } from "node:test";
import { RecoveryStore, recoveryCookie, recoveryTicket, resumeToken } from "../src/recovery.ts";
import { readSettings } from "../src/config.ts";
import type { IncomingMessage } from "node:http";
import { TokenVerifier } from "livekit-server-sdk";
import { COMPLETE } from "./fixtures.ts";

const SESSION = {
  session_id: "01a1f5f4-ede7-7028-a524-9d8e2f36b92c", token: "original",
  serverUrl: "wss://example.org", room: "synthetic-room", agentName: "aule-tutor", expiresInSeconds: 600,
};
test("opaque recovery tickets belong to one sign-in, expire and are bounded", () => {
  let now = 0;
  const store = new RecoveryStore(() => now);
  const ticket = store.remember("guardian", "student", SESSION);
  assert.match(ticket, /^[0-9a-f]{64}$/);
  assert.equal(store.get(ticket, "other"), null);
  assert.equal(store.get(ticket, "guardian")?.expires, 600_000);
  now = 600_001;
  assert.ok(store.get(ticket, "guardian"), "retain lifecycle briefly to explain expiry");
  now = 900_000;
  assert.equal(store.get(ticket, "guardian"), null);
  const first = store.remember("guardian", "student", SESSION);
  for (let i = 0; i < 512; i++) store.remember("guardian", "student", SESSION);
  assert.equal(store.get(first, "guardian"), null);
});
test("ticket cookie is scoped, HttpOnly, Secure and not available cross-site", () => {
  const cookie = recoveryCookie("a".repeat(64), "/session", 61.9);
  assert.match(cookie, /Max-Age=61; Path=\/session\/; HttpOnly; Secure; SameSite=Strict$/);
  assert.equal(recoveryTicket({ headers: { cookie } } as IncomingMessage), "a".repeat(64));
  assert.equal(recoveryTicket({ headers: { cookie: "aule_recovery=bad" } } as IncomingMessage), null);
});
test("resume token keeps the identity and room without redispatching a tutor or granting administration", async () => {
  const settings = readSettings(COMPLETE);
  const store = new RecoveryStore();
  const entry = store.get(store.remember("guardian", "student", SESSION), "guardian")!;
  const token = await resumeToken(settings, entry, 42);
  const claims = await new TokenVerifier(COMPLETE.LIVEKIT_API_KEY, COMPLETE.LIVEKIT_API_SECRET).verify(token);
  assert.equal(claims.sub, `child-${SESSION.session_id.replaceAll("-", "")}`);
  assert.equal(claims.video?.room, SESSION.room);
  assert.equal(claims.video?.roomAdmin, undefined);
  assert.equal(claims.roomConfig, undefined);
  assert.ok(Number(claims.exp) <= Math.floor(Date.now() / 1000) + 42);
});
