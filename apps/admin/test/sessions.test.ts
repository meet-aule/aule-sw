// The console's own sessions: an opaque cookie for the browser, the platform
// token kept in the console, and the platform session ended whenever the
// console's ends.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

import { MAX_SESSIONS } from "../src/sessions.ts";
import {
  COMMIT,
  FakePlatform,
  HOUR,
  MINUTE,
  PUBLIC_URL,
  TEAM,
  clock,
  logged,
  signIn,
  startConsole,
  until,
  write,
} from "./fake-platform.ts";

const platform = await new FakePlatform().listen();
after(() => platform.close());

const families = (base: string, cookie?: string) => fetch(`${base}/api/families`, { headers: cookie ? { Cookie: cookie } : {} });
/** The platform token behind the newest sign-in. */
const newest = () => [...platform.tokens].at(-1)!;

test("a signed-in call carries the team member's own platform token, and nothing else gets through", async () => {
  const { base, close } = await startConsole(platform);
  try {
    const cookie = await signIn(base);
    const token = newest();
    platform.heard.length = 0;
    const response = await families(base, cookie);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { families: [{ id: "01a1f5f4-ede7-7028-a524-9d8e2f36b92d", name: "Quispe" }] });
    assert.deepEqual(
      platform.heard.map((heard) => [heard.method, heard.path, heard.headers.authorization]),
      [["GET", "/v1/admin/families", `Bearer ${token}`]],
    );

    // A platform token pasted into the cookie, an id the console never made, or none: signed out.
    for (const pasted of [`__Host-aule_admin=${token}`, `__Host-aule_admin=${"A".repeat(43)}`, `aule_guardian=${token}`, "__Host-aule_admin=", ""]) {
      const refused = await families(base, pasted || undefined);
      assert.deepEqual([refused.status, await refused.json()], [401, { error: "signed_out" }], pasted);
    }
    assert.equal(platform.heard.length, 1, "none of them reached the platform");
  } finally {
    close();
  }
});

test("a session ends 12 hours after sign-in, or after 2 hours without a request, and its platform session with it", async () => {
  const time = clock();
  const { base, close, server } = await startConsole(platform, { now: time.now });
  try {
    const busy = await signIn(base);
    const busyToken = newest();
    const idle = await signIn(base);
    const idleToken = newest();
    // The busy one is used every 100 minutes; the idle one is not.
    for (let used = 0; used < 7; used += 1) {
      time.pass(100 * MINUTE);
      assert.equal((await families(base, busy)).status, 200, `after ${(used + 1) * 100} minutes`);
    }
    assert.equal((await families(base, idle)).status, 401, "2 hours without a request");
    time.pass(HOUR);
    assert.equal((await families(base, busy)).status, 401, "12 hours from sign-in, however busy");
    await server.sessions.settled();
    assert.deepEqual(platform.signedOut().slice(-2), [idleToken, busyToken]);
    assert.equal(server.sessions.size, 0);
  } finally {
    close();
  }
});

test("the minute's sweep ends what is over even when nobody asks again", async () => {
  const time = clock();
  const { base, close, server } = await startConsole(platform, { now: time.now });
  try {
    await signIn(base);
    const token = newest();
    time.pass(2 * HOUR);
    server.sessions.sweep();
    await server.sessions.settled();
    assert.equal(server.sessions.size, 0);
    assert.equal(platform.signedOut().at(-1), token);
  } finally {
    close();
  }
});

test("signing out ends the platform session, clears the cookie, and the next call is refused", async () => {
  const { base, close } = await startConsole(platform);
  try {
    const cookie = await signIn(base);
    const token = newest();
    assert.deepEqual(await (await write(base, "/api/signout", {}, { origin: null, cookie })).json(), { error: "wrong_origin" });
    assert.equal((await families(base, cookie)).status, 200, "a sign-out from elsewhere did nothing");

    const out = await write(base, "/api/signout", {}, { cookie });
    assert.deepEqual([out.status, await out.json()], [200, { signed_in: false }]);
    assert.deepEqual(out.headers.getSetCookie(), ["__Host-aule_admin=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict"]);
    assert.equal(platform.signedOut().at(-1), token);
    assert.ok(!platform.tokens.has(token));
    assert.equal((await families(base, cookie)).status, 401);

    // Without a session it still answers, and still clears the cookie.
    const again = await write(base, "/api/signout", {});
    assert.equal(again.status, 200);
    assert.match(again.headers.getSetCookie()[0] ?? "", /Max-Age=0/);
  } finally {
    close();
  }
});

test("the cookie goes whatever the platform answers to the sign-out", async () => {
  const { base, close } = await startConsole(platform);
  try {
    const cookie = await signIn(base);
    platform.once("POST /v1/auth/signout", { status: 500, body: { error: { code: "internal", message: "internal error" } } });
    const out = await write(base, "/api/signout", {}, { cookie });
    assert.equal(out.status, 200);
    assert.match(out.headers.getSetCookie()[0] ?? "", /^__Host-aule_admin=; /);
    assert.equal((await families(base, cookie)).status, 401);
  } finally {
    close();
  }
});

test("a platform that no longer knows the token drops the session; one that refuses the team drops and ends it", async () => {
  const { base, close, server } = await startConsole(platform);
  try {
    const forgotten = await signIn(base);
    platform.tokens.delete(newest());
    const before = platform.signedOut().length;
    const refused = await families(base, forgotten);
    assert.deepEqual([refused.status, await refused.json()], [401, { error: "signed_out" }]);
    assert.equal((await families(base, forgotten)).status, 401);
    await server.sessions.settled();
    assert.equal(platform.signedOut().length, before, "nothing left to end at the platform");

    const removed = await signIn(base);
    const token = newest();
    platform.refuseStaff(token);
    const forbidden = await families(base, removed);
    assert.deepEqual([forbidden.status, await forbidden.json()], [403, { error: "not_team" }]);
    await server.sessions.settled();
    assert.equal(platform.signedOut().at(-1), token);
    assert.equal((await families(base, removed)).status, 401);
  } finally {
    close();
  }
});

test(`the ${MAX_SESSIONS + 1}st session ends the oldest, and stopping ends them all`, async () => {
  const time = clock();
  const { base, close, server } = await startConsole(platform, { now: time.now });
  try {
    const cookies: string[] = [];
    const tokens: string[] = [];
    for (let made = 0; made < MAX_SESSIONS + 1; made += 1) {
      // A new sign-in window now and then, so the limits stay out of it.
      if (made % 3 === 0) time.pass(15 * MINUTE);
      cookies.push(await signIn(base));
      tokens.push(newest());
    }
    await server.sessions.settled();
    assert.equal(server.sessions.size, MAX_SESSIONS);
    assert.equal(platform.signedOut().at(-1), tokens[0]);
    assert.equal((await families(base, cookies[0])).status, 401);
    assert.equal((await families(base, cookies[1])).status, 200);

    const before = platform.signedOut().length;
    await server.revokeAll();
    assert.equal(server.sessions.size, 0);
    assert.deepEqual(new Set(platform.signedOut().slice(before)), new Set(tokens.slice(1)));
    for (const cookie of cookies) assert.equal((await families(base, cookie)).status, 401);
  } finally {
    close();
  }
});

test("SIGTERM ends the platform sessions the console holds before the process exits", async () => {
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
  const child = spawn(process.execPath, [new URL("../src/server.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH,
      ADMIN_PORT: String(port),
      ADMIN_PUBLIC_URL: PUBLIC_URL,
      AULE_PLATFORM_URL: platform.url,
      AULE_ADMIN_EMAILS: TEAM,
      AULE_COMMIT: COMMIT,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  try {
    await until(() => out.includes("on http://"), "the console to start");
    const base = `http://127.0.0.1:${port}`;
    await signIn(base);
    const first = newest();
    await signIn(base);
    const second = newest();
    child.kill("SIGTERM");
    assert.equal(await exited, 0);
    assert.ok(platform.signedOut().includes(first) && platform.signedOut().includes(second));
    for (const line of out.trim().split("\n")) assert.doesNotMatch(line, /@|[0-9a-f]{64}/, line);
  } finally {
    child.kill();
  }
});

test("the log of a session's life holds no address, no token and no cookie", async () => {
  const time = clock();
  const lines = await logged(async () => {
    const { base, close, server } = await startConsole(platform, { now: time.now });
    try {
      const cookie = await signIn(base);
      await families(base, cookie);
      platform.once("GET /v1/admin/families", { status: 502, body: { error: { code: "x", message: `${TEAM} said no` } } });
      await families(base, cookie);
      await write(base, "/api/signout", {}, { cookie });
      await signIn(base);
      time.pass(13 * HOUR);
      server.sessions.sweep();
      platform.once("POST /v1/auth/signout", { status: 500 });
      await signIn(base);
      await server.revokeAll();
      await server.sessions.settled();
    } finally {
      close();
    }
  });
  for (const event of ["signed_in", "signed_out", "session_ended expired=true", "session_ended stopping=true", "platform_error status=502", "revoke_failed status=500"]) {
    assert.ok(lines.some((line) => line.includes(event)), event);
  }
  for (const line of lines) assert.doesNotMatch(line, /@|[0-9a-f]{64}|[A-Za-z0-9_-]{43}|aule_admin/, line);
});
