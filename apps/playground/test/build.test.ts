// Which build answers, said where whoever looks can find it and nowhere else:
// the health probe, two meta tags, the last line of the family's account, the
// team's panel, the start-up line and every request to the platform.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { stamp } from "../src/assets.ts";
import { VERSION } from "../src/build.ts";
import { readSettings } from "../src/config.ts";
import { createPlayground } from "../src/server.ts";
import { COMPLETE } from "./fixtures.ts";

const COMMIT = "0123456789ab";
const FAMILY_TOKEN = "ef".repeat(32);
const TEAM_TOKEN = "fe".repeat(32);

// Stands in for the platform: a family, a team member, and its own health probe.
const heard: { path: string; headers: IncomingHttpHeaders }[] = [];
let platformHealth: { status: number; body: unknown } = { status: 200, body: { ok: true, version: "0.0.7", commit: "fedcba987654" } };
const platform = createServer((request, response) => {
  const path = request.url ?? "";
  heard.push({ path, headers: request.headers });
  const answer = (status: number, value: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  };
  if (path === "/healthz") return answer(platformHealth.status, platformHealth.body);
  if (path === "/v1/auth/providers") return answer(200, { google: "client-1", github: null, meta: null, apple: null });
  const team = request.headers.authorization === `Bearer ${TEAM_TOKEN}`;
  if (!team && request.headers.authorization !== `Bearer ${FAMILY_TOKEN}`) return answer(401, { error: { message: "who?" } });
  if (path === "/v1/me") return answer(200, { guardian: { name: "Ana" }, family_id: "f-1", children: [] });
  if (path === "/v1/me/plan") return answer(200, { plan: "trial", team });
  answer(404, { error: { message: "no such path" } });
});

const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

let base = "";
let linked: Server;
let plain: Server;
let plainBase = "";

before(async () => {
  const url = await listen(platform);
  linked = createPlayground(readSettings({ ...COMPLETE, AULE_PLATFORM_URL: url, AULE_ADMIN_TOKEN: "admin", AULE_COMMIT: COMMIT }));
  base = `${await listen(linked)}/playground`;
  plain = createPlayground(readSettings(COMPLETE));
  plainBase = `${await listen(plain)}/playground`;
});
after(() => {
  linked.close();
  plain.close();
  platform.close();
});

const as = (token: string) => ({ Cookie: `aule_guardian=${token}` });

test("the version is the repository's, as package.json copies it", async () => {
  const source = await readFile(new URL("../../../version.txt", import.meta.url), "utf8");
  assert.equal(VERSION, source.trim());
});

test("AULE_COMMIT is taken only when it is a commit; otherwise the commit is unknown", () => {
  assert.equal(readSettings(COMPLETE).commit, "unknown");
  assert.equal(readSettings({ ...COMPLETE, AULE_COMMIT: ` ${COMMIT} ` }).commit, COMMIT);
  assert.equal(readSettings({ ...COMPLETE, AULE_COMMIT: "a".repeat(40) }).commit, "a".repeat(40));
  for (const odd of ["unknown", "abc12", "0123456789AB", '"><script>', `${COMMIT}-dirty`, "a".repeat(41)]) {
    assert.equal(readSettings({ ...COMPLETE, AULE_COMMIT: odd }).commit, "unknown", odd);
  }
});

test("the health probe says which build answers, and is still never kept", async () => {
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true, version: VERSION, commit: COMMIT });
  assert.deepEqual(await (await fetch(`${plainBase}/healthz`)).json(), { ok: true, version: VERSION, commit: "unknown" });
});

test("both pages carry the build in two meta tags, and nothing is left unstamped", async () => {
  for (const [origin, commit] of [
    [base, COMMIT],
    [plainBase, "unknown"],
  ]) {
    for (const path of ["/", "/admin"]) {
      const page = await (await fetch(`${origin}${path}`)).text();
      assert.ok(page.includes(`<meta name="aule-version" content="${VERSION}" />`), path);
      assert.ok(page.includes(`<meta name="aule-commit" content="${commit}" />`), path);
      assert.doesNotMatch(page, /\{\{[^}]*\}\}/, path);
    }
  }
});

test("the family's account ends with a faint line: the name, the version and the short commit", async () => {
  const lastLine = async (origin: string) => {
    const page = await (await fetch(`${origin}/`)).text();
    const account = page.match(/<details class="account" id="account">([\s\S]*?)<\/details>/)?.[1] ?? "";
    return account.trim().split("\n").at(-1)?.trim();
  };
  assert.equal(await lastLine(base), `<p class="build">Aule ${VERSION} · ${COMMIT.slice(0, 7)}</p>`);
  // Without a commit the line stops at the version: a family never reads "unknown".
  assert.equal(await lastLine(plainBase), `<p class="build">Aule ${VERSION}</p>`);
  const css = await readFile(new URL("../public/style.css", import.meta.url), "utf8");
  const rule = css.match(/\n\.build \{([^}]*)\}/)?.[1] ?? "";
  assert.match(rule, /color: var\(--muted\)/, "faint");
  assert.doesNotMatch(rule, /user-select/, "left selectable");
});

test("only pages are stamped: the scripts and the stylesheet keep their fingerprints whatever the build", async () => {
  const versions = (page: string) => [...page.matchAll(/"([\w./-]+)\?v=([0-9a-f]{12})"/g)].map(([, name, hash]) => `${name}=${hash}`);
  const withCommit = versions(await (await fetch(`${base}/`)).text());
  const without = versions(await (await fetch(`${plainBase}/`)).text());
  assert.ok(withCommit.some((entry) => entry.startsWith("style.css=")) && withCommit.some((entry) => entry.startsWith("app.js=")));
  assert.deepEqual(withCommit, without);
  for (const name of ["app.js", "style.css", "admin.js"]) {
    const file = await (await fetch(`${base}/${name}`)).text();
    assert.ok(!file.includes(COMMIT) && !file.includes(`Aule ${VERSION}`), `${name} is never stamped`);
  }
  assert.equal(stamp("{{version}} {{version}} {{other}}", new Map([["{{version}}", "1.2.3"]])), "1.2.3 1.2.3 {{other}}");
});

test("every request to the platform says which build of the playground makes it", async () => {
  heard.length = 0;
  const account = await fetch(`${base}/api/account`, { headers: as(FAMILY_TOKEN) });
  assert.equal(account.status, 200);
  await account.arrayBuffer();
  assert.ok(heard.length >= 3, "providers, the account and the plan");
  for (const { path, headers } of heard) {
    assert.equal(headers["user-agent"], `aule-playground/${VERSION} (+${COMMIT.slice(0, 7)})`, path);
  }
});

test("the team's panel is told the page's build and the platform's, and nobody else is", async () => {
  assert.equal((await fetch(`${base}/api/admin/build`)).status, 401);
  const family = await fetch(`${base}/api/admin/build`, { headers: as(FAMILY_TOKEN) });
  assert.deepEqual([family.status, await family.json()], [403, { error: "not_team" }]);
  assert.equal((await fetch(`${plainBase}/api/admin/build`, { headers: as(TEAM_TOKEN) })).status, 404, "no platform, no panel");

  const team = await fetch(`${base}/api/admin/build`, { headers: as(TEAM_TOKEN) });
  assert.equal(team.headers.get("cache-control"), "no-store");
  assert.deepEqual(await team.json(), {
    playground: { version: VERSION, commit: COMMIT },
    platform: { version: "0.0.7", commit: "fedcba987654" },
  });

  // A platform whose probe fails, or an older one that does not say, leaves its part empty.
  for (const health of [{ status: 503, body: { error: { message: "database" } } }, { status: 200, body: { ok: true } }]) {
    platformHealth = health;
    const answer = await (await fetch(`${base}/api/admin/build`, { headers: as(TEAM_TOKEN) })).json();
    assert.deepEqual(answer.platform, { version: null, commit: null }, JSON.stringify(health));
  }
  platformHealth = { status: 200, body: { ok: true, version: "0.0.7", commit: "fedcba987654" } };

  const panel = await readFile(new URL("../public/admin.js", import.meta.url), "utf8");
  assert.match(panel, /get\("api\/admin\/build"\)\.then\(showBuild, \(\) => \{\}\)/, "the panel works without the line");
  assert.match(panel, /\$\("build"\)\.textContent = /, "and writes it as text");
  // Asked for only once the team's data has loaded, so nobody else's page is refused it.
  const load = panel.slice(panel.indexOf("async function load()"));
  assert.ok(load.indexOf('get("api/admin/build")') > load.indexOf("showOverview(metrics);"), "after the panel's data");
  assert.ok(load.indexOf('get("api/admin/build")') > load.indexOf("return;"), "and never after a refusal");
});

test("the server's first line names its build", async () => {
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
  const child = spawn(process.execPath, [new URL("../src/server.ts", import.meta.url).pathname], {
    env: { ...COMPLETE, PATH: process.env.PATH, AULE_COMMIT: COMMIT, PLAYGROUND_PORT: String(port) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const line = await new Promise<string>((resolve, reject) => {
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
        if (out.includes("\n")) resolve(out.split("\n")[0]!);
      });
      child.on("exit", (code) => reject(new Error(`the server stopped (${code}): ${out}`)));
    });
    assert.equal(line, `aule-playground ${VERSION} (${COMMIT}) on http://127.0.0.1:${port}/playground/`);
  } finally {
    child.kill();
  }
});
