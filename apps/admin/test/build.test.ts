// Which build answers, said where whoever looks can find it: the health probe,
// two meta tags on each page, the panel's build line, the start-up line and
// every request to the platform.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { stamp } from "../src/assets.ts";
import { VERSION, userAgent } from "../src/build.ts";
import { COMMIT, FakePlatform, PUBLIC_URL, TEAM, signIn, startConsole } from "./fake-platform.ts";

const platform = await new FakePlatform().listen();
let base = "";
let close = () => {};
let plainBase = "";
let closePlain = () => {};

before(async () => {
  ({ base, close } = await startConsole(platform));
  ({ base: plainBase, close: closePlain } = await startConsole(platform, {}, { AULE_COMMIT: "" }));
});
after(() => {
  close();
  closePlain();
  platform.close();
});

test("the version is the repository's, as package.json copies it", async () => {
  const source = await readFile(new URL("../../../version.txt", import.meta.url), "utf8");
  assert.equal(VERSION, source.trim());
  assert.equal(userAgent(COMMIT), `aule-admin/${VERSION} (+${COMMIT.slice(0, 7)})`);
});

test("every page carries the build in two meta tags, and nothing is left unstamped", async () => {
  for (const [origin, commit] of [
    [base, COMMIT],
    [plainBase, "unknown"],
  ]) {
    for (const path of ["/", "/live", "/families", "/family", "/passkeys", "/signin"]) {
      const page = await (await fetch(`${origin}${path}`)).text();
      assert.ok(page.includes(`<meta name="aule-version" content="${VERSION}" />`), path);
      assert.ok(page.includes(`<meta name="aule-commit" content="${commit}" />`), path);
      assert.doesNotMatch(page, /\{\{[^}]*\}\}/, path);
    }
  }
});

test("only pages are stamped: the scripts and the stylesheet keep their fingerprints whatever the build", async () => {
  const versions = (page: string) => [...page.matchAll(/"([\w./-]+)\?v=([0-9a-f]{12})"/g)].map(([, name, hash]) => `${name}=${hash}`);
  const withCommit = versions(await (await fetch(`${base}/`)).text());
  assert.ok(withCommit.some((entry) => entry.startsWith("style.css=")) && withCommit.some((entry) => entry.startsWith("admin.js=")));
  assert.deepEqual(withCommit, versions(await (await fetch(`${plainBase}/`)).text()));
  for (const name of ["admin.js", "common.js", "labels.js", "live.js", "families.js", "family.js", "passkeys.js", "pilot.js", "signin.js", "style.css"]) {
    const file = await (await fetch(`${base}/${name}`)).text();
    assert.ok(!file.includes(COMMIT), `${name} is never stamped`);
  }
  assert.equal(stamp("{{version}} {{version}} {{other}}", new Map([["{{version}}", "1.2.3"]])), "1.2.3 1.2.3 {{other}}");
});

test("every request to the platform says which build of the console makes it", async () => {
  platform.heard.length = 0;
  const cookie = await signIn(base);
  await (await fetch(`${base}/api/families`, { headers: { Cookie: cookie } })).arrayBuffer();
  await (await fetch(`${base}/api/build`, { headers: { Cookie: cookie } })).arrayBuffer();
  const paths = platform.heard.map((heard) => heard.path);
  for (const path of ["/v1/auth/team/start", "/v1/auth/team/verify", "/v1/admin/families", "/healthz"]) {
    assert.ok(paths.includes(path), path);
  }
  for (const { path, headers } of platform.heard) assert.equal(headers["user-agent"], `aule-admin/${VERSION} (+${COMMIT.slice(0, 7)})`, path);
});

test("the panel is told the console's build and the platform's; a platform that does not say leaves its part empty", async () => {
  const cookie = await signIn(base);
  const asked = () => fetch(`${base}/api/build`, { headers: { Cookie: cookie } });
  const answer = await asked();
  assert.equal(answer.headers.get("cache-control"), "no-store");
  assert.deepEqual(await answer.json(), {
    admin: { version: VERSION, commit: COMMIT },
    platform: { version: "0.0.7", commit: "fedcba987654" },
  });
  // The platform's probe is asked without a token: it needs none.
  assert.equal(platform.to("/healthz").at(-1)?.headers.authorization, undefined);
  for (const health of [{ status: 503, body: { error: { message: "database" } } }, { status: 200, body: { ok: true } }]) {
    platform.health = health;
    assert.deepEqual((await (await asked()).json()).platform, { version: null, commit: null }, JSON.stringify(health));
  }
  platform.health = { status: 200, body: { ok: true, version: "0.0.7", commit: "fedcba987654" } };

  const panel = await readFile(new URL("../public/admin.js", import.meta.url), "utf8");
  assert.match(panel, /get\("\/api\/build"\)\.then\(showBuild, \(\) => \{\}\)/, "the panel works without the line");
  assert.match(panel, /\$\("build"\)\.textContent = `\$\{named\("aule-admin", build\.admin\)\} · \$\{named\("aule-platform", build\.platform\)\}`/);
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

/** Starts src/server.ts as the image does, and gives its output and how it ended. */
function run(env: Record<string, string>) {
  const child = spawn(process.execPath, [new URL("../src/server.ts", import.meta.url).pathname], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  return { child, output: () => out, exited };
}

test("the server's first line names its build and where it listens", async () => {
  const port = await freePort();
  const started = run({ ADMIN_PORT: String(port), AULE_PLATFORM_URL: platform.url, AULE_ADMIN_EMAILS: TEAM, ADMIN_PUBLIC_URL: PUBLIC_URL, AULE_COMMIT: COMMIT });
  try {
    for (let waited = 0; !started.output().includes("\n") && waited < 5_000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(started.output().split("\n")[0], `aule-admin ${VERSION} (${COMMIT}) on http://127.0.0.1:${port}/`);
  } finally {
    started.child.kill();
  }
});

test("a console with a bad setting does not start, and says which setting without repeating its value", async () => {
  const refused = run({ AULE_PLATFORM_URL: platform.url, AULE_ADMIN_EMAILS: "ana@example.org, luis-at-example.org" });
  assert.equal(await refused.exited, 1);
  assert.equal(refused.output(), "aule-admin: AULE_ADMIN_EMAILS must be email addresses separated by commas\n");
});
