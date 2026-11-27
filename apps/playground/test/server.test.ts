import assert from "node:assert/strict";
import { connect, type AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
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

// A GET with the target exactly as written (fetch would tidy it first), and
// the status it gets. A server that threw never answers, hence the timeout.
const raw = (to: Server, target: string) =>
  new Promise<number>((resolve, reject) => {
    const socket = connect((to.address() as AddressInfo).port, "127.0.0.1", () =>
      socket.write(`GET ${target} HTTP/1.1\r\nHost: playground\r\nConnection: close\r\n\r\n`),
    );
    let reply = "";
    socket.setEncoding("utf8");
    socket.setTimeout(2_000, () => socket.destroy(new Error(`no answer to ${target}`)));
    socket.on("data", (chunk: string) => (reply += chunk));
    socket.on("end", () => resolve(Number(reply.split(" ")[1])));
    socket.on("error", reject);
  });

test("serves the page and its scripts with a strict policy", async () => {
  for (const path of [
    "/",
    "/app.js",
    "/signin.js",
    "/steps.js",
    "/screens.js",
    "/onboarding.js",
    "/home.js",
    "/session-messages.js",
    "/first-steps.js",
    "/summaries.js",
    "/students.js",
    "/visuals.js",
    "/choices.js",
    "/cuy.js",
    "/pixels.js",
    "/style.css",
    "/livekit-client.js",
    "/wobnimo.js",
    "/fonts/serif.woff2",
    "/fonts/serif-italic.woff2",
    "/fonts/sans.woff2",
    "/fonts/sans-italic.woff2",
    "/fonts/caveat-semibold-latin.woff2",
    "/fonts/OFL-caveat.txt",
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    // The page is never kept; any other file without its fingerprint is
    // checked on every load (see assets.test.ts).
    if (path === "/") {
      assert.equal(response.headers.get("cache-control"), "no-store");
    } else {
      assert.equal(response.headers.get("cache-control"), "no-cache", path);
      assert.match(response.headers.get("etag") ?? "", /^"[0-9a-f]{12}"$/, path);
    }
    await response.arrayBuffer();
  }
  const policy = (await fetch(`${base}/`)).headers.get("content-security-policy") ?? "";
  assert.match(policy, /connect-src 'self' wss:\/\/livekit\.example\.org https:\/\/livekit\.example\.org/);
  assert.match(policy, /font-src 'self'/);
  const font = await fetch(`${base}/fonts/sans.woff2`);
  assert.equal(font.headers.get("content-type"), "font/woff2");
  await font.arrayBuffer();
});

test("the family guide is served in Spanish and in English as a page", async () => {
  for (const [path, words] of [
    ["/guia", /Guía para familias/],
    ["/guide", /A guide for families/],
  ] as const) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    const page = await response.text();
    assert.match(page, words);
    // Its stylesheet is the page's own, fingerprinted; the build is written in.
    assert.match(page, /href="style\.css\?v=[0-9a-f]{12}"/);
    assert.doesNotMatch(page, /\{\{(version|commit)\}\}/);
  }
});

test("the pictures of the old Andean page are gone, and the icons stay", async () => {
  for (const name of ["wall.png", "motifs.png", "dancers.png", "manta.png", "frame.png"]) {
    const response = await fetch(`${base}/${name}`);
    assert.equal(response.status, 404, name);
    await response.arrayBuffer();
  }
  for (const name of ["icon.svg", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "manifest.webmanifest"]) {
    const response = await fetch(`${base}/${name}`);
    assert.equal(response.status, 200, name);
    await response.arrayBuffer();
  }
});

test("redirects the bare path and hides everything outside it", async () => {
  const bare = await fetch(base, { redirect: "manual" });
  assert.equal(bare.status, 308);
  assert.equal(bare.headers.get("location"), "/playground/");

  assert.equal((await fetch(base.replace("/playground", "/"))).status, 404);
  assert.equal((await fetch(`${base}/../etc/passwd`)).status, 404);
  assert.equal((await fetch(`${base}/api/session`)).status, 405);
});

test("an odd address is answered, and the server stays up", async () => {
  // "//" and the like once read as a host with no name and ended the process.
  for (const target of ["//", "///", "/\\", "//?a=1", "//a:b", "//%09/example.com"]) {
    assert.equal(await raw(server, target), 404, target);
  }
  // A full address that is no address at all.
  assert.equal(await raw(server, "http://x:99999/"), 400);
  assert.equal(await raw(server, "//playground/healthz"), 200, "doubled slashes are folded");
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("the old panel's addresses send the team to admin.meetaule.com, and its API and scripts are gone", async () => {
  const origin = new URL(base).origin;
  for (const path of ["/admin", "/admin/", "/playground/admin", "/playground/admin/"]) {
    for (const method of ["GET", "HEAD"]) {
      for (const query of ["", "?view=usage", "?next=https://evil.example/"]) {
        const response = await fetch(`${origin}${path}${query}`, { method, redirect: "manual" });
        assert.equal(response.status, 302, `${method} ${path}${query}`);
        // A fixed address: nothing of the request goes with it.
        assert.equal(response.headers.get("location"), "https://admin.meetaule.com/", `${method} ${path}${query}`);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(await response.text(), "");
      }
    }
  }
  for (const path of ["/api/admin/families", "/api/admin/build", "/api/admin/metrics", "/api/admin/weekly"]) {
    const response = await fetch(`${base}${path}`, { headers: { Accept: "text/html" }, redirect: "manual" });
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get("location"), null, path);
    await response.arrayBuffer();
  }
  for (const path of ["/api/admin/grant", "/api/admin/ungrant"]) {
    assert.equal((await fetch(`${base}${path}`, { method: "POST", body: "{}" })).status, 404, path);
  }
  for (const name of ["admin.js", "pilot.js", "admin.html"]) {
    assert.equal((await fetch(`${base}/${name}`)).status, 404, name);
  }
  const bare = await fetch(`${base}?signin=cancelled`, { redirect: "manual" });
  assert.equal(bare.headers.get("location"), "/playground/?signin=cancelled");
});

test("the family guide's aliases keep the query, a link's ?src= with it, and reach the guide", async () => {
  const origin = new URL(base).origin;
  const headers = { Accept: "text/html" };
  for (const [page, words] of [
    ["/guia", /Guía para familias/],
    ["/guide", /A guide for families/],
  ] as const) {
    for (const path of [`/playground${page}/`, page, `${page}/`]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await fetch(`${origin}${path}?src=cesar`, { method, headers, redirect: "manual" });
        assert.equal(response.status, 308, `${method} ${path}`);
        assert.equal(response.headers.get("location"), `/playground${page}?src=cesar`, path);
        assert.equal(response.headers.get("cache-control"), "no-store");
      }
    }
    const guide = await fetch(`${origin}/playground${page}/`, { headers });
    assert.equal(guide.url, `${origin}/playground${page}`);
    assert.match(await guide.text(), words);
    const posted = await fetch(`${origin}/playground${page}/`, { method: "POST", headers, redirect: "manual" });
    assert.equal(posted.status, 404, "a write is no visit");
  }
});

// A session's id as the platform writes it (FIGMA.md D41).
const SESSION = "01a215c0-9f37-718e-b5cf-bb3c99184cdd";

test("a session's own address is the page, as the bare one is, and anything else in its place goes home (D41)", async () => {
  const origin = new URL(base).origin;
  const headers = { Accept: "text/html,application/xhtml+xml" };
  const page = await (await fetch(`${base}/`)).text();
  for (const method of ["GET", "HEAD"]) {
    const response = await fetch(`${base}/${SESSION}?src=feria`, { method, headers, redirect: "manual" });
    assert.equal(response.status, 200, method);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    // Never kept, and the address with the id in it goes to no other site in a Referer.
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    // No family is sent a session's address with a link's code: a ?src= there keeps nothing.
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(await response.text(), method === "GET" ? page : "");
  }
  // Anything else where the id goes is no id: a visit lands on the session page's own address...
  for (const junk of [
    `${SESSION}/`,
    SESSION.toUpperCase(),
    `${SESSION}0`,
    SESSION.slice(0, -1),
    SESSION.replaceAll("-", ""),
    `${SESSION}/${SESSION}`,
    "01a215c0-9f37-718e-b5cf-bb3c99184cdg",
    "session",
  ]) {
    const response = await fetch(`${base}/${junk}`, { headers, redirect: "manual" });
    assert.equal(response.status, 302, junk);
    assert.equal(response.headers.get("location"), "/playground/", junk);
  }
  // ...while a file, an API route or a write there stays an error, and outside the base path it is nothing.
  for (const path of [`/${SESSION}/app.js`, `/${SESSION}.js`, `/api/${SESSION}`]) {
    const response = await fetch(`${base}${path}`, { headers, redirect: "manual" });
    assert.equal(response.status, 404, path);
    await response.arrayBuffer();
  }
  assert.equal((await fetch(`${base}/${SESSION}`, { method: "POST", headers, redirect: "manual" })).status, 404);
  const outside = await fetch(`${origin}/${SESSION}`, { headers, redirect: "manual" });
  assert.equal(outside.status, 302);
  assert.equal(outside.headers.get("location"), "/playground/");
});

test("missing page visits return home, while API, file and write errors stay errors", async () => {
  const origin = new URL(base).origin;
  const headers = { Accept: "text/html,application/xhtml+xml" };
  for (const path of ["/old-page", "/playground/old-page"]) {
    const response = await fetch(`${origin}${path}?next=https://example.org`, { headers, redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/playground/");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  }
  for (const path of ["/api/missing", "/playground/api/missing", "/playground/api", "/playground/missing.js"]) {
    const response = await fetch(origin + path, { headers, redirect: "manual" });
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get("location"), null);
    assert.deepEqual(await response.json(), { error: "not_found" });
  }
  for (const path of ["/admin/", "/playground/admin/", "/old-page", "/playground/old-page"]) {
    const response = await fetch(origin + path, { method: "POST", headers, redirect: "manual" });
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get("location"), null);
  }
  assert.equal((await fetch(`${base}/old-page`, { redirect: "manual" })).status, 404);
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
  assert.equal(claims.roomConfig?.departureTimeout, 120);
  assert.equal(claims.roomConfig?.emptyTimeout, 30);
  assert.equal(claims.roomConfig?.maxParticipants, 2);

  // The person can read all of it: the dispatch carries what the page chose and nothing else.
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
    // What the compose healthcheck asks for when the base path is "/": the
    // probe itself, not the page.
    assert.equal((await (await fetch(`${origin}//healthz`)).json()).ok, true);
    assert.equal(await raw(root, "//"), 200);
    for (const path of ["/admin", "/admin/"]) {
      const panel = await fetch(`${origin}${path}?view=usage`, { redirect: "manual" });
      assert.equal(panel.status, 302, path);
      assert.equal(panel.headers.get("location"), "https://admin.meetaule.com/", path);
    }
    const guide = await fetch(`${origin}/guia/?src=cesar`, { redirect: "manual" });
    assert.equal(guide.headers.get("location"), "/guia?src=cesar");
    assert.equal((await fetch(`${origin}/guia`)).status, 200);
    assert.equal((await fetch(`${origin}/${SESSION}`)).status, 200, "a session's own address");
    const missing = await fetch(`${origin}/old-page`, { headers: { Accept: "text/html" }, redirect: "manual" });
    assert.equal(missing.headers.get("location"), "/");
  } finally {
    root.close();
  }
});
