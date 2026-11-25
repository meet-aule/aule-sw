// The team's sign-in: a code by mail for the team's addresses only, the same
// answer for everyone else, limits per client that tell nothing and that no
// stranger can use to lock the team out, and nothing in the log.
import assert from "node:assert/strict";
import { connect } from "node:net";
import { after, test } from "node:test";

import {
  CODE,
  EDGE_SECRET,
  FakePlatform,
  HOUR,
  MINUTE,
  NO_ACCOUNT,
  PUBLIC_URL,
  STRANGER,
  TEAM,
  WRONG_CODE,
  clock,
  cookieFrom,
  fromWorker,
  logged,
  startConsole,
  until,
  write,
} from "./fake-platform.ts";

const platform = await new FakePlatform().listen();
after(() => platform.close());

const start = (base: string, email: string, headers?: Record<string, string>) => write(base, "/api/signin/start", { email }, { headers });
const verify = (base: string, email: string, code: string, cookie?: string, headers?: Record<string, string>) =>
  write(base, "/api/signin/verify", { email, code }, { ...(cookie ? { cookie } : {}), headers });
const answer = async (response: Response) => [response.status, await response.json()];
const statusOf = async (response: Promise<Response>) => {
  const settled = await response;
  await settled.arrayBuffer();
  return settled.status;
};

/** The headers of an answer, less the date it was sent. */
const headersOf = (response: Response) => [...response.headers].filter(([name]) => name !== "date");

// What the log may never hold: an address, a code, a platform token, a session id or a client's address.
const SECRETS = [/@/, new RegExp(CODE), new RegExp(WRONG_CODE), /[0-9a-f]{64}/, /[A-Za-z0-9_-]{43}/, /aule_admin/, /203\.0\.113/, /2001:db8/];

/** A console behind its Worker, where the client address the Worker passes on counts. */
const behindWorker = (options: Parameters<typeof startConsole>[1] = {}) => startConsole(platform, options, { ADMIN_EDGE_SECRET: EDGE_SECRET });
const A = fromWorker("203.0.113.10");
const B = fromWorker("203.0.113.20");

test("a code is asked for the same way for the team and for anyone else, and sent only to the team", async () => {
  const { base, close } = await startConsole(platform);
  try {
    platform.heard.length = 0;
    const team = await start(base, TEAM);
    const stranger = await start(base, STRANGER);
    assert.equal(team.status, 202);
    assert.equal(stranger.status, 202);
    assert.deepEqual(headersOf(team), headersOf(stranger));
    assert.equal(await team.text(), await stranger.text());
    assert.equal(await (await start(base, "Team@Example.org ")).text(), JSON.stringify({ sent: true }));

    await until(() => platform.to("/v1/auth/team/start").length === 2, "the codes to be asked for");
    const asked = platform.to("/v1/auth/team/start");
    // The platform's route for the team's own codes, never a family's: it sends only to its own list of the team.
    assert.deepEqual(
      asked.map((heard) => heard.body),
      [{ email: TEAM }, { email: TEAM }],
    );
    for (const heard of asked) assert.equal(heard.headers.authorization, undefined, "a sign-in call carries no token");
    assert.equal(platform.heard.length, 2, "nothing at all for a stranger");
  } finally {
    close();
  }
});

test("the answer does not wait for the platform's mail", async () => {
  const { base, close } = await startConsole(platform);
  platform.startWaitMs = 2_000;
  try {
    const began = performance.now();
    const response = await start(base, TEAM);
    assert.equal(response.status, 202);
    assert.ok(performance.now() - began < 1_000, "answered before the platform did");
  } finally {
    platform.startWaitMs = 0;
    close();
  }
});

test("a malformed address or code is a 400, and a stranger's code a 403 with no platform call, never before the floor", async () => {
  const { base, close } = await startConsole(platform, { verifyFloorMs: 300 });
  try {
    for (const email of ["", "ana", "ana@example", "an a@example.org", 42]) {
      assert.deepEqual(await answer(await write(base, "/api/signin/start", { email })), [400, { error: "bad_email" }], String(email));
    }
    for (const [email, code] of [[TEAM, "12345"], [TEAM, "1234567"], [TEAM, "12a456"], ["ana", CODE], [TEAM, 123456]]) {
      assert.deepEqual(await answer(await write(base, "/api/signin/verify", { email, code })), [400, { error: "bad_request" }]);
    }
    platform.heard.length = 0;
    const began = performance.now();
    assert.deepEqual(await answer(await verify(base, STRANGER, CODE)), [403, { error: "wrong_code" }]);
    assert.ok(performance.now() - began >= 290, "not before the floor");
    assert.equal(platform.heard.length, 0);
  } finally {
    close();
  }
});

test("a wrong code, a team address with no account and a failing platform get the same 403, and so does a right code before the floor", async () => {
  const { base, close } = await startConsole(platform, { verifyFloorMs: 200 });
  try {
    const wrong = await verify(base, TEAM, WRONG_CODE);
    const noAccount = await verify(base, NO_ACCOUNT, CODE);
    platform.once("POST /v1/auth/team/verify", { status: 500, body: { error: { code: "internal", message: "internal error" } } });
    const failing = await verify(base, TEAM, CODE);
    platform.once("POST /v1/auth/team/verify", { status: 503, body: { error: { code: "unavailable", message: "x" } }, waitMs: 50 });
    const slow = await verify(base, TEAM, CODE);
    for (const response of [noAccount, failing, slow]) {
      assert.equal(response.status, wrong.status);
      assert.deepEqual(headersOf(response), headersOf(wrong));
      assert.equal(await response.text(), JSON.stringify({ error: "wrong_code" }));
    }
    const began = performance.now();
    const right = await verify(base, TEAM, CODE);
    assert.equal(right.status, 200);
    assert.ok(performance.now() - began >= 190, "a success waits for the floor too");
    // The console never asks the platform to make an account.
    for (const heard of platform.heard) {
      const body = (heard.body ?? {}) as Record<string, unknown>;
      assert.ok(!("name" in body) && !("source" in body), `${heard.method} ${heard.path}`);
    }
  } finally {
    close();
  }
});

test("the floor counts from when the code's body is in, so sending it slowly tells nothing", async () => {
  const { base, close } = await startConsole(platform, { verifyFloorMs: 300 });
  try {
    const port = Number(new URL(base).port);
    const body = JSON.stringify({ email: TEAM, code: WRONG_CODE });
    // The headers now, the body 400 ms later: past the floor, had it counted from the headers.
    const waited = await new Promise<number>((resolve, reject) => {
      let sentAt = 0;
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          `POST /api/signin/verify HTTP/1.1\r\nHost: admin\r\nOrigin: ${PUBLIC_URL}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n`,
        );
        setTimeout(() => {
          sentAt = performance.now();
          socket.write(body);
        }, 400);
      });
      socket.once("data", () => resolve(performance.now() - sentAt));
      socket.on("error", reject);
      socket.setTimeout(3_000, () => socket.destroy(new Error("no answer")));
    });
    assert.ok(waited >= 280, `answered ${Math.round(waited)} ms after the body`);
  } finally {
    close();
  }
});

test("signed in, the cookie is the console's own, never the platform's token", async () => {
  const { base, close } = await startConsole(platform);
  try {
    platform.heard.length = 0;
    platform.tokens.clear();
    const response = await verify(base, TEAM, CODE);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text, JSON.stringify({ signed_in: true }));
    const cookies = response.headers.getSetCookie();
    assert.equal(cookies.length, 1);
    assert.match(cookies[0]!, /^__Host-aule_admin=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict$/);
    const token = platform.tokens.values().next().value as string;
    assert.ok(token && !cookies[0]!.includes(token) && !text.includes(token), "the platform's token stays in the console");
    // One call: the platform's route for the team's codes checks its own list of the team.
    assert.deepEqual(
      platform.heard.map((heard) => `${heard.method} ${heard.path}`),
      ["POST /v1/auth/team/verify"],
    );
    assert.deepEqual(platform.heard[0]!.body, { email: TEAM, code: CODE });
  } finally {
    close();
    platform.tokens.clear();
  }
});

test("someone the platform does not count as the team is told the code was wrong, and no session is made", async () => {
  const { base, close, server } = await startConsole(platform);
  platform.teamAtPlatform = false;
  try {
    platform.tokens.clear();
    const response = await verify(base, TEAM, CODE);
    assert.deepEqual(await answer(response), [403, { error: "wrong_code" }]);
    assert.deepEqual(response.headers.getSetCookie(), []);
    assert.equal(platform.tokens.size, 0);
    assert.equal(server.sessions.size, 0);
  } finally {
    platform.teamAtPlatform = true;
    close();
  }
});

test("a browser that signs in again ends its earlier session first", async () => {
  const { base, close, server } = await startConsole(platform);
  try {
    platform.tokens.clear();
    const first = cookieFrom(await verify(base, TEAM, CODE));
    const [earlier] = platform.tokens;
    platform.heard.length = 0;
    const second = await verify(base, TEAM, CODE, first);
    assert.equal(second.status, 200);
    await server.sessions.settled();
    assert.deepEqual(platform.signedOut(), [earlier]);
    assert.equal(server.sessions.size, 1);
    assert.equal((await fetch(`${base}/api/families`, { headers: { Cookie: first } })).status, 401);
  } finally {
    close();
  }
});

test("3 code requests an hour per address and client and 10 per client, the same for the team and anyone else, and nobody else's", async () => {
  const time = clock();
  const { base, close } = await behindWorker({ now: time.now });
  try {
    for (const email of [TEAM, STRANGER]) {
      for (let request = 0; request < 3; request += 1) assert.equal(await statusOf(start(base, email, A)), 202, email);
      assert.deepEqual(await answer(await start(base, email, A)), [429, { error: "too_many" }], email);
    }
    // Another client asks for the team's address as if nothing had happened.
    assert.equal(await statusOf(start(base, TEAM, B)), 202, "a stranger's requests hold back nobody else");
    // Ten in all from one client, whatever the addresses.
    for (let request = 0; request < 4; request += 1) assert.equal(await statusOf(start(base, `p${request}@example.org`, A)), 202);
    assert.equal(await statusOf(start(base, "p9@example.org", A)), 429, "the client's eleventh");
    time.pass(HOUR);
    assert.equal(await statusOf(start(base, TEAM, A)), 202, "the window moves on");
  } finally {
    close();
  }
});

test("wrong codes: 5 an hour and 10 a day per address and client, 10 an hour and 20 a day per client; a stranger's never lock the team out", async () => {
  const time = clock();
  const { base, close } = await behindWorker({ now: time.now });
  try {
    for (const email of [TEAM, STRANGER]) {
      for (let attempt = 0; attempt < 5; attempt += 1) assert.equal(await statusOf(verify(base, email, WRONG_CODE, undefined, A)), 403, email);
      assert.deepEqual(await answer(await verify(base, email, CODE, undefined, A)), [429, { error: "too_many" }], `${email}: even the right code`);
    }
    // The team member, on their own connection, gets in at once.
    assert.equal(await statusOf(verify(base, TEAM, CODE, undefined, B)), 200, "the stranger's tries lock nobody else out");
    // Ten wrong ones an hour from one client, whatever the addresses.
    assert.equal(await statusOf(verify(base, "otra@example.org", WRONG_CODE, undefined, A)), 429, "the client's eleventh in the hour");

    // An hour later the client may try again, up to ten a day for an address and twenty for the client.
    time.pass(HOUR);
    for (let attempt = 0; attempt < 5; attempt += 1) assert.equal(await statusOf(verify(base, STRANGER, WRONG_CODE, undefined, A)), 403);
    time.pass(HOUR);
    assert.equal(await statusOf(verify(base, STRANGER, WRONG_CODE, undefined, A)), 429, "10 in a day for the address");
    for (let attempt = 0; attempt < 5; attempt += 1) assert.equal(await statusOf(verify(base, `q${attempt}@example.org`, WRONG_CODE, undefined, A)), 403);
    assert.equal(await statusOf(verify(base, "q9@example.org", WRONG_CODE, undefined, A)), 429, "20 in a day for the client");
    time.pass(22 * HOUR);
    assert.equal(await statusOf(verify(base, STRANGER, WRONG_CODE, undefined, A)), 403, "a day later it counts again");

    // A success clears the address's count and the client's.
    for (let attempt = 0; attempt < 4; attempt += 1) assert.equal(await statusOf(verify(base, TEAM, WRONG_CODE, undefined, B)), 403);
    assert.equal(await statusOf(verify(base, TEAM, CODE, undefined, B)), 200);
    for (let attempt = 0; attempt < 5; attempt += 1) assert.equal(await statusOf(verify(base, TEAM, WRONG_CODE, undefined, B)), 403);
    assert.equal(await statusOf(verify(base, TEAM, CODE, undefined, B)), 429);
  } finally {
    close();
  }
});

test("wrong codes sent together count before the platform is asked: no more than 5 of them reach it", async () => {
  const { base, close } = await behindWorker();
  try {
    platform.heard.length = 0;
    const statuses = await Promise.all(Array.from({ length: 30 }, () => statusOf(verify(base, TEAM, WRONG_CODE, undefined, A))));
    assert.equal(statuses.filter((status) => status === 403).length, 5);
    assert.equal(statuses.filter((status) => status === 429).length, 25);
    assert.equal(platform.to("/v1/auth/team/verify").length, 5);
  } finally {
    close();
  }
});

test("the client is the Worker's word only with its secret, and an IPv6 client is its /64", async () => {
  // With no secret set (this machine), a forwarded address is ignored: every request here is one client.
  const local = await startConsole(platform);
  try {
    for (let request = 0; request < 3; request += 1) assert.equal(await statusOf(start(local.base, TEAM, fromWorker(`198.51.100.${request}`))), 202);
    assert.equal(await statusOf(start(local.base, TEAM, fromWorker("198.51.100.99"))), 429);
  } finally {
    local.close();
  }
  const { base, close } = await behindWorker();
  try {
    for (const client of ["2001:db8:1:2::1", "2001:db8:1:2:ffff::9", "2001:0db8:0001:0002::42"]) {
      assert.equal(await statusOf(start(base, TEAM, fromWorker(client))), 202, client);
    }
    assert.equal(await statusOf(start(base, TEAM, fromWorker("2001:db8:1:2:abcd::1"))), 429, "the same /64");
    assert.equal(await statusOf(start(base, TEAM, fromWorker("2001:db8:1:3::1"))), 202, "another /64");
  } finally {
    close();
  }
});

test("600 sign-in requests a minute in all, from anyone; a full counter forgets the oldest client and refuses nobody new", async () => {
  const time = clock();
  const busy = await behindWorker({ now: time.now });
  try {
    // Each from a client of its own, fifty at a time: more at once than a listening socket queues.
    const statuses: number[] = [];
    for (let batch = 0; batch < 600; batch += 50) {
      const requests = Array.from({ length: 50 }, (_, offset) => {
        const n = batch + offset;
        const client = fromWorker(`10.${Math.floor(n / 250)}.${n % 250}.1`);
        const email = `person${n}@example.org`;
        return statusOf(n % 2 ? start(busy.base, email, client) : verify(busy.base, email, WRONG_CODE, undefined, client));
      });
      statuses.push(...(await Promise.all(requests)));
    }
    assert.ok(statuses.every((status) => status === 202 || status === 403), "all 600 answered");
    assert.deepEqual(await answer(await start(busy.base, "late@example.org", B)), [429, { error: "too_many" }]);
    time.pass(MINUTE);
    assert.equal(await statusOf(start(busy.base, "late@example.org", B)), 202);
  } finally {
    busy.close();
  }
  const small = await behindWorker({ now: time.now, limitKeys: 3 });
  try {
    for (let request = 0; request < 3; request += 1) assert.equal(await statusOf(start(small.base, TEAM, A)), 202);
    assert.equal(await statusOf(start(small.base, TEAM, A)), 429);
    for (const client of ["203.0.113.30", "203.0.113.31", "203.0.113.32"]) {
      assert.equal(await statusOf(start(small.base, STRANGER, fromWorker(client))), 202, `${client}: room is made`);
    }
    assert.equal(await statusOf(start(small.base, TEAM, A)), 202, "the oldest was forgotten");
  } finally {
    small.close();
  }
});

test("a write must come from the console's own pages, as JSON", async () => {
  const { base, close } = await startConsole(platform);
  try {
    for (const path of ["/api/signin/start", "/api/signin/verify", "/api/signout"]) {
      const body = { email: TEAM, code: CODE };
      assert.deepEqual(await answer(await write(base, path, body, { origin: null })), [403, { error: "wrong_origin" }], `${path}: no Origin`);
      for (const origin of ["https://evil.example", "https://admin.example.org.evil.example", "http://admin.example.org", "null"]) {
        assert.deepEqual(await answer(await write(base, path, body, { origin })), [403, { error: "wrong_origin" }], `${path}: ${origin}`);
      }
      for (const site of ["cross-site", "same-site", "none"]) {
        assert.deepEqual(await answer(await write(base, path, body, { site })), [403, { error: "wrong_origin" }], `${path}: ${site}`);
      }
      for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
        const refused = await write(base, path, body, { type });
        assert.deepEqual(await answer(refused), [415, { error: "unsupported_media_type" }], `${path}: ${type}`);
      }
    }
    assert.equal((await write(base, "/api/signin/start", { email: TEAM }, { site: "same-origin" })).status, 202);
    assert.equal((await write(base, "/api/signin/start", { email: TEAM }, { type: "application/json; charset=utf-8" })).status, 202);
  } finally {
    close();
  }
});

test("the log holds no address, no code, no token, no cookie and no client", async () => {
  const time = clock();
  const lines = await logged(async (seen) => {
    const { base, close, server } = await behindWorker({ now: time.now });
    platform.heard.length = 0;
    try {
      await start(base, TEAM, A);
      await start(base, STRANGER, A);
      await verify(base, TEAM, WRONG_CODE, undefined, A);
      await verify(base, NO_ACCOUNT, CODE, undefined, fromWorker("2001:db8::7"));
      platform.once("POST /v1/auth/team/start", { status: 503, body: { error: { code: "unavailable", message: `could not mail ${TEAM}` } } });
      await start(base, TEAM, B);
      platform.once("POST /v1/auth/team/verify", { status: 500, body: { error: { code: "internal", message: `${TEAM} ${CODE}` } } });
      await verify(base, TEAM, CODE, undefined, B);
      const cookie = cookieFrom(await verify(base, TEAM, CODE, undefined, B));
      await write(base, "/api/signout", {}, { cookie, headers: B });
      // The code's mail is asked for after the answer, and logged when the platform answers.
      const said = (event: string) => seen.some((line) => line.includes(event));
      await until(() => said("code_requested") && said("code_not_sent"), "the codes' lines");
      await server.sessions.settled();
    } finally {
      close();
    }
  });
  for (const event of ["code_requested", "code_not_sent status=503", "platform_error status=500", "signed_in", "signed_out"]) {
    assert.ok(lines.some((line) => line.includes(event)), event);
  }
  for (const line of lines) {
    assert.match(line, /^aule-admin: [a-z_]+( [a-z_]+=(true|false|-?[\d.]+))*$/, line);
    for (const secret of SECRETS) assert.doesNotMatch(line, secret, line);
  }
});
