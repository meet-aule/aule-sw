// A link like /session/?src=cesar: the page keeps its code in a cookie until
// someone signs in, and the sign-in hands it to the platform, which writes it
// on the family it creates.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer, type IncomingMessage } from "node:http";
import { after, before, test } from "node:test";

import { readSettings } from "../src/config.ts";
import { createPlayground } from "../src/server.ts";
import { sourceCode, sourceCookie, sourceOf } from "../src/signin.ts";
import { COMPLETE } from "./fixtures.ts";

const TOKEN = "5a".repeat(32);
const PAGE = "https://page.example.org";
const CALLBACK = `${PAGE}/playground/api/signin/github/callback`;

// Stands in for the platform: every way in works for the right code.
const asked: { path: string; body: Record<string, unknown> }[] = [];
const platform = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  const body = text ? JSON.parse(text) : {};
  const path = request.url ?? "";
  const answer = (status: number, value: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  };
  if (path === "/v1/auth/providers") {
    return answer(200, { google: "client-1", github: "gh-1", meta: null, apple: null, email: true });
  }
  if (["/v1/auth/google", "/v1/auth/verify", "/v1/auth/github"].includes(path)) {
    asked.push({ path, body });
    const good = body.credential === "good" || body.code === "123456" || body.code === "good";
    if (!good) return answer(403, { error: { message: "refused" } });
    return answer(200, { token: TOKEN, expires_in_days: 30, new_account: true });
  }
  if (path === "/v1/me") return answer(200, { guardian: { name: "Ana" }, family_id: "f", children: [] });
  if (path === "/v1/me/plan") return answer(200, { plan: "trial", ends_at: null, used: 0, allowed: 1, left: 1, team: false });
  answer(404, { error: { message: "no such path" } });
});

let base = "";
let server: ReturnType<typeof createPlayground>;

before(async () => {
  await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;
  server = createPlayground(
    readSettings({ ...COMPLETE, AULE_PLATFORM_URL: url, AULE_ADMIN_TOKEN: "admin", PLAYGROUND_PUBLIC_URL: PAGE }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/playground`;
});
after(() => {
  server.close();
  platform.close();
});

const KEPT = "aule_source=cesar; Max-Age=2592000; Path=/playground/; HttpOnly; Secure; SameSite=None";
const CLEARED = "aule_source=; Max-Age=0; Path=/playground/; HttpOnly; Secure; SameSite=None";

async function opened(path: string, headers: Record<string, string> = {}): Promise<string[]> {
  const response = await fetch(`${base}${path}`, { headers, redirect: "manual" });
  await response.arrayBuffer();
  return response.headers.getSetCookie();
}

const post = (path: string, body: unknown, cookie?: string) =>
  fetch(`${base}/api/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });

test("the page and the family guide keep a short lower-case link code until sign-in", async () => {
  for (const path of ["/?src=cesar", "/guia?src=cesar", "/guide?src=cesar", "/?utm=x&src=cesar"]) {
    assert.deepEqual(await opened(path), [KEPT], path);
  }
  // The bare path keeps the query on its way to the page.
  const bare = await fetch(`${base}?src=cesar`, { redirect: "manual" });
  assert.equal(bare.headers.get("location"), "/playground/?src=cesar");
  // So does the guide's address with a trailing slash, and then the guide keeps the code.
  for (const path of ["/guia/?src=cesar", "/guide/?src=cesar"]) {
    const slash = await fetch(`${base}${path}`, { headers: { Accept: "text/html" }, redirect: "manual" });
    assert.equal(slash.status, 308, path);
    const location = slash.headers.get("location") ?? "";
    assert.equal(location, `/playground${path.replace("/?", "?")}`);
    assert.deepEqual(await opened(location.replace("/playground", "")), [KEPT], path);
  }
});

test("anything else in ?src= is ignored, and so is a link opened elsewhere or signed in", async () => {
  for (const odd of ["Cesar", "", "ce%20sar", "ce_sar", "2cesar", "-cesar", "c%C3%A9sar", "x".repeat(25), "%3Cb%3E"]) {
    assert.deepEqual(await opened(`/?src=${odd}`), [], odd);
  }
  assert.deepEqual(await opened("/"), []);
  assert.deepEqual(await opened("/admin?src=cesar"), [], "the team's old panel address is no family's way in");
  assert.deepEqual(await opened("/style.css?src=cesar"), []);
  assert.deepEqual(await opened("/?src=cesar", { Cookie: `aule_guardian=${TOKEN}` }), [], "already signed in");
});

test("signing in with Google hands the code to the platform, and then the cookie goes", async () => {
  asked.length = 0;
  const response = await post("signin", { credential: "good" }, "aule_source=cesar");

  assert.equal(response.status, 200);
  const cookies = response.headers.getSetCookie();
  assert.match(cookies[0] ?? "", new RegExp(`^aule_guardian=${TOKEN};`));
  assert.equal(cookies[1], CLEARED);
  assert.deepEqual(asked, [{ path: "/v1/auth/google", body: { credential: "good", source: "cesar" } }]);
});

test("a code the server did not write is not passed on", async () => {
  asked.length = 0;
  for (const cookie of ["aule_source=Cesar", "aule_source=", "other=cesar"]) {
    const response = await post("signin", { credential: "good" }, cookie);
    assert.equal(response.status, 200);
    assert.equal(response.headers.getSetCookie().length, 1, cookie);
  }
  assert.deepEqual(
    asked.map((call) => call.body),
    Array.from({ length: 3 }, () => ({ credential: "good" })),
  );
});

test("signing up with an emailed code hands the code on too", async () => {
  asked.length = 0;
  const response = await post("signin/email/verify", { email: "luis@example.org", code: "123456", name: "Luis" }, "aule_source=pucp");

  assert.equal(response.status, 200);
  assert.ok(response.headers.getSetCookie().includes(CLEARED));
  assert.deepEqual(asked, [
    { path: "/v1/auth/verify", body: { email: "luis@example.org", code: "123456", language: "es", name: "Luis", source: "pucp" } },
  ]);
});

test("coming back from GitHub, the code the cookie kept is handed on", async () => {
  const start = await fetch(`${base}/api/signin/github/start`, { redirect: "manual" });
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const stateCookie = (start.headers.get("set-cookie") ?? "").split(";")[0]!;
  asked.length = 0;

  const back = await fetch(`${base}/api/signin/github/callback?code=good&state=${state}`, {
    headers: { Cookie: `${stateCookie}; aule_source=colegio-2` },
    redirect: "manual",
  });

  assert.equal(back.headers.get("location"), "/playground/");
  const cookies = back.headers.getSetCookie();
  assert.ok(cookies.some((cookie) => cookie.startsWith(`aule_guardian=${TOKEN};`)));
  assert.ok(cookies.includes(CLEARED));
  assert.deepEqual(asked, [{ path: "/v1/auth/github", body: { code: "good", redirect_uri: CALLBACK, source: "colegio-2" } }]);
});

test("a code is lower-case letters, digits and hyphens, starts with a letter and has 24 at most", () => {
  for (const good of ["cesar", "pucp", "colegio-2", "a", "abcdefghijklmnopqrstuvwx"]) assert.equal(sourceCode(good), good);
  for (const bad of ["", "Cesar", "2cesar", "-cesar", "ce sar", "ce_sar", "césar", "abcdefghijklmnopqrstuvwxy", null, undefined]) {
    assert.equal(sourceCode(bad), null, String(bad));
  }
  const request = (cookie: string) => ({ headers: { cookie } }) as IncomingMessage;
  assert.equal(sourceOf(request(`aule_guardian=${TOKEN}; aule_source=cesar`)), "cesar");
  assert.equal(sourceOf(request("aule_source=<b>")), null);
  assert.equal(sourceOf(request("")), null);
  assert.match(sourceCookie("cesar", ""), /^aule_source=cesar; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=None$/);
});
