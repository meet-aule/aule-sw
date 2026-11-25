import assert from "node:assert/strict";
import { connect, type AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, test } from "node:test";

import { VERSION } from "../src/build.ts";
import { CONTENT_SECURITY_POLICY } from "../src/headers.ts";
import type { Platform } from "../src/platform.ts";
import { answersWithoutEdge } from "../src/server.ts";
import { COMMIT, EDGE_SECRET, FakePlatform, TEAM, fromWorker, signIn, startConsole, write } from "./fake-platform.ts";

const platform = await new FakePlatform().listen();
let base = "";
let server: Server;
let close = () => {};
// Every answer in this file is checked for a Location: the console never redirects.
const answers: Response[] = [];

before(async () => {
  ({ server, base, close } = await startConsole(platform));
});
after(() => {
  close();
  platform.close();
  for (const response of answers) assert.equal(response.headers.get("location"), null, response.url);
  assert.ok(answers.length > 20);
});

async function ask(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${base}${path}`, { redirect: "manual", ...init });
  answers.push(response);
  return response;
}

// A request with the target exactly as written (fetch would tidy it first),
// and the status it gets. A server that threw never answers, hence the timeout.
const raw = (to: Server, target: string, method = "GET") =>
  new Promise<{ status: number; text: string }>((resolve, reject) => {
    const socket = connect((to.address() as AddressInfo).port, "127.0.0.1", () =>
      socket.write(`${method} ${target} HTTP/1.1\r\nHost: admin\r\nConnection: close\r\n\r\n`),
    );
    let reply = "";
    socket.setEncoding("utf8");
    socket.setTimeout(2_000, () => socket.destroy(new Error(`no answer to ${target}`)));
    socket.on("data", (chunk: string) => (reply += chunk));
    socket.on("end", () => resolve({ status: Number(reply.split(" ")[1]), text: reply }));
    socket.on("error", reject);
  });

test("the health probe answers without a sign-in, with the build", async () => {
  const response = await ask("/healthz");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true, version: VERSION, commit: COMMIT });
  const head = await ask("/healthz", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("an odd address is answered, and the server stays up", async () => {
  // "//" and the like once read as a host with no name and ended the playground's process.
  for (const [target, expected] of [
    ["//healthz", 200],
    ["//", 200],
    ["///", 200],
    ["/\\", 200],
    ["//?a=1", 200],
    ["//a:b", 404],
    ["//%09/example.com", 404],
    ["//evil.example/", 404],
  ] as const) {
    const { status, text } = await raw(server, target);
    assert.equal(status, expected, target);
    assert.doesNotMatch(text, /\r\nlocation:/i, target);
  }
  // A full address that is no address at all.
  assert.equal((await raw(server, "http://x:99999/")).status, 400);
  assert.equal((await ask("/healthz")).status, 200);
});

test("robots are told to stay out of everything", async () => {
  const response = await ask("/robots.txt");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await response.text(), "User-agent: *\nDisallow: /\n");
});

test("an unknown path is a 404 and a known one asked the wrong way a 405, never a redirect", async () => {
  for (const path of [
    "/admin",
    "/signin/",
    "/index.html",
    "/family.html",
    "/families/",
    "/passkeys.html",
    "/api",
    "/api/admin/families",
    "/api/families/x/y",
    "/api/passkeys/x",
    "/fonts/sans-italic.woff2",
    "/../etc/passwd",
  ]) {
    const response = await ask(path, { headers: { Accept: "text/html" } });
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: "not_found" }, path);
  }
  for (const [method, path, allow] of [
    ["POST", "/", "GET, HEAD"],
    ["PUT", "/style.css", "GET, HEAD"],
    ["DELETE", "/api/families", "GET"],
    ["HEAD", "/api/build", "GET"],
    ["GET", "/api/signin/start", "POST"],
    ["GET", "/api/signin/passkey/start", "POST"],
    ["GET", "/api/signin/passkey/finish", "POST"],
    ["GET", "/api/signout", "POST"],
    ["GET", `/api/families/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}/grant`, "POST"],
    ["POST", `/api/families/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}/sessions`, "GET"],
    ["DELETE", "/api/sessions/open", "GET"],
    ["POST", "/api/passkeys", "GET"],
    ["GET", "/api/passkeys/options", "POST"],
    ["GET", "/api/passkeys/create", "POST"],
    ["DELETE", `/api/passkeys/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}/delete`, "POST"],
    ["POST", "/passkeys", "GET, HEAD"],
    ["POST", "/families", "GET, HEAD"],
    ["POST", "/healthz", "GET, HEAD"],
  ]) {
    const response = await ask(path!, { method });
    assert.equal(response.status, 405, `${method} ${path}`);
    assert.equal(response.headers.get("allow"), allow, `${method} ${path}`);
    await response.arrayBuffer();
  }
});

test("OPTIONS is refused, with no CORS headers at all", async () => {
  for (const path of ["/api/families", "/api/signin/start", "/"]) {
    const response = await ask(path, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
    });
    assert.equal(response.status, 405, path);
    assert.deepEqual([...response.headers.keys()].filter((name) => name.startsWith("access-control-")), [], path);
    await response.arrayBuffer();
  }
});

test("a HEAD carries no body", async () => {
  for (const path of ["/", "/signin", "/style.css", "/robots.txt"]) {
    const response = await ask(path, { method: "HEAD" });
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), "", path);
  }
});

test("a passkey the browser made may take 16 KB, and every other write still 4 KB", async () => {
  // Past the body's rules, a request with no session is a 401: the body was taken.
  const sized = async (path: string, bytes: number) => {
    const response = await write(base, path, { label: "Mac", credential: { id: "a".repeat(bytes) } });
    answers.push(response);
    await response.arrayBuffer();
    return response.status;
  };
  assert.equal(await sized("/api/passkeys/create", 10_000), 401);
  assert.equal(await sized("/api/passkeys/create", 16_384), 400);
  // A passkey's answer at the sign-in, every field as long as the console takes it (about 12 KB):
  // past the body's rules, it is refused for want of a ceremony. Longer, the body is refused.
  const longest = { id: "a".repeat(1_368), rawId: "a".repeat(1_368), type: "public-key" };
  const response = { authenticatorData: "a".repeat(4_096), clientDataJSON: "a".repeat(4_096), signature: "a".repeat(1_024), userHandle: "a".repeat(88) };
  const signing = async (credential: unknown) => {
    const answered = await write(base, "/api/signin/passkey/finish", { credential });
    answers.push(answered);
    return [answered.status, await answered.json()];
  };
  assert.deepEqual(await signing({ ...longest, response }), [403, { error: "passkey_failed" }]);
  assert.deepEqual(await signing({ ...longest, response, padding: "a".repeat(5_000) }), [400, { error: "bad_request" }]);
  assert.equal(await sized("/api/signin/passkey/start", 4_096), 400);
  for (const path of ["/api/passkeys/options", `/api/passkeys/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}/delete`, "/api/families/x/grant"]) {
    assert.equal(await sized(path, 4_096), 400, path);
    assert.equal(await sized(path, 3_000), 401, path);
  }
});

test("a body over 4 KB is refused before anything reads it", async () => {
  const big = await write(base, "/api/signin/start", { email: `${"a".repeat(4_100)}@example.org` });
  answers.push(big);
  assert.equal(big.status, 400);
  assert.deepEqual(await big.json(), { error: "bad_request" });
  for (const raw of ["[]", "null", '"text"', "{", ""]) {
    const response = await write(base, "/api/signin/start", undefined, { raw });
    answers.push(response);
    assert.equal(response.status, 400, raw);
    await response.arrayBuffer();
  }
});

test("a handler that throws is a 500 that keeps its words, and the next request is answered", async () => {
  const failing: Platform = {
    sendCode: async () => {},
    verifyCode: async () => "a".repeat(64),
    passkeyOptions: async () => ({ ceremony: "a".repeat(64), publicKey: {} }),
    passkeySignIn: async () => "a".repeat(64),
    signOut: async () => {},
    build: async () => {
      throw new TypeError("a bug, with a detail that must stay here");
    },
    teamCall: async () => {
      throw new Error("another bug");
    },
  };
  const broken = await startConsole(platform, { platform: failing });
  try {
    const cookie = await signIn(broken.base);
    for (const path of ["/api/build", "/api/families"]) {
      const response = await fetch(`${broken.base}${path}`, { headers: { Cookie: cookie } });
      answers.push(response);
      assert.equal(response.status, 500, path);
      assert.deepEqual(await response.json(), { error: "internal" }, path);
    }
    const health = await fetch(`${broken.base}/healthz`);
    answers.push(health);
    assert.equal(health.status, 200);
  } finally {
    broken.close();
  }
});

test("behind the Worker, only what it forwards is answered: anyone else gets the same 404 at every address", async () => {
  const gated = await startConsole(platform, {}, { ADMIN_EDGE_SECRET: EDGE_SECRET });
  try {
    const others: Record<string, string>[] = [
      {},
      { "X-Edge-Secret": "x".repeat(EDGE_SECRET.length) },
      { "X-Edge-Secret": `${EDGE_SECRET}x` },
      { "X-Edge-Secret": EDGE_SECRET.slice(1) },
    ];
    for (const headers of others) {
      for (const path of ["/", "/signin", "/families", "/style.css", "/admin.js", "/robots.txt", "/api/families", "/api/build", "/nothing"]) {
        const response = await fetch(`${gated.base}${path}`, { headers, redirect: "manual" });
        answers.push(response);
        assert.deepEqual([response.status, await response.json()], [404, { error: "not_found" }], `${path} ${JSON.stringify(headers)}`);
        assert.equal(response.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);
      }
      const posted = await write(gated.base, "/api/signin/start", { email: TEAM }, { headers });
      answers.push(posted);
      assert.deepEqual([posted.status, await posted.json()], [404, { error: "not_found" }]);
    }
    // The container's health check and the watch ask from this machine, and need no secret.
    const health = await fetch(`${gated.base}/healthz`);
    answers.push(health);
    assert.deepEqual(await health.json(), { ok: true, version: VERSION, commit: COMMIT });
    // Through the Worker, everything answers as it does with no secret set.
    const worker = fromWorker("203.0.113.5");
    for (const path of ["/", "/signin", "/healthz", "/robots.txt"]) {
      const response = await fetch(`${gated.base}${path}`, { headers: worker, redirect: "manual" });
      answers.push(response);
      assert.equal(response.status, 200, path);
      await response.arrayBuffer();
    }
    const cookie = await signIn(gated.base, TEAM, worker);
    const families = await fetch(`${gated.base}/api/families`, { headers: { ...worker, Cookie: cookie } });
    answers.push(families);
    assert.equal(families.status, 200);
    const without = await fetch(`${gated.base}/api/families`, { headers: { Cookie: cookie } });
    answers.push(without);
    assert.equal(without.status, 404, "a session's cookie is no way in without the Worker");
  } finally {
    gated.close();
  }
});

test("without the secret, only the health probe of this machine is answered", () => {
  for (const address of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) assert.ok(answersWithoutEdge("/healthz", address), address);
  for (const address of ["203.0.113.5", "::ffff:203.0.113.5", "2001:db8::1", "10.0.0.1", "", undefined]) {
    assert.ok(!answersWithoutEdge("/healthz", address), String(address));
  }
  for (const path of ["/", "/signin", "/robots.txt", "/api/families", "/healthz/"]) assert.ok(!answersWithoutEdge(path, "127.0.0.1"), path);
});
