// Every answer carries the same strict headers: pages, files, the API, its
// errors and the health probe alike.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { FakePlatform, signIn, startConsole, write } from "./fake-platform.ts";

const EXPECTED: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'",
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

const platform = await new FakePlatform().listen();
let base = "";
let close = () => {};
let cookie = "";

before(async () => {
  ({ base, close } = await startConsole(platform));
  cookie = await signIn(base);
});
after(() => {
  close();
  platform.close();
});

function strict(response: Response, what: string) {
  for (const [name, value] of Object.entries(EXPECTED)) assert.equal(response.headers.get(name), value, `${what}: ${name}`);
  assert.equal(response.headers.get("location"), null, what);
  assert.equal(response.headers.get("access-control-allow-origin"), null, what);
}

test("every kind of answer carries the console's headers", async () => {
  const cases: [string, Promise<Response>, number, string][] = [
    ["the overview page", fetch(`${base}/`), 200, "no-store"],
    ["the sign-in page", fetch(`${base}/signin`), 200, "no-store"],
    ["a script", fetch(`${base}/admin.js`), 200, "no-cache"],
    ["the stylesheet", fetch(`${base}/style.css`), 200, "no-cache"],
    ["a font", fetch(`${base}/fonts/sans.woff2`), 200, "no-cache"],
    ["the icon", fetch(`${base}/icon.svg`), 200, "no-cache"],
    ["the health probe", fetch(`${base}/healthz`), 200, "no-store"],
    ["robots.txt", fetch(`${base}/robots.txt`), 200, "no-store"],
    ["the API's data", fetch(`${base}/api/families`, { headers: { Cookie: cookie } }), 200, "no-store"],
    ["the API signed out", fetch(`${base}/api/families`), 401, "no-store"],
    ["the API, unknown", fetch(`${base}/api/nothing`), 404, "no-store"],
    ["a wrong method", fetch(`${base}/api/families`, { method: "DELETE" }), 405, "no-store"],
    ["a write from elsewhere", write(base, "/api/signin/start", { email: "a@example.org" }, { origin: "https://evil.example" }), 403, "no-store"],
    ["a malformed write", write(base, "/api/signin/start", undefined, { raw: "{" }), 400, "no-store"],
    ["a write that is not JSON", write(base, "/api/signin/start", undefined, { type: "text/plain", raw: "x" }), 415, "no-store"],
  ];
  for (const [what, asked, status, cache] of cases) {
    const response = await asked;
    assert.equal(response.status, status, what);
    strict(response, what);
    assert.equal(response.headers.get("cache-control"), cache, what);
    await response.arrayBuffer();
  }
});

test("a file's 304 carries them too, and only a fingerprinted address is kept", async () => {
  const page = await (await fetch(`${base}/`)).text();
  const version = page.match(/style\.css\?v=([0-9a-f]{12})/)?.[1];
  assert.ok(version, "the page names its stylesheet by its fingerprint");
  const kept = await fetch(`${base}/style.css?v=${version}`);
  strict(kept, "a fingerprinted file");
  assert.equal(kept.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const etag = kept.headers.get("etag") ?? "";
  await kept.arrayBuffer();
  const again = await fetch(`${base}/style.css`, { headers: { "If-None-Match": etag } });
  assert.equal(again.status, 304);
  strict(again, "a 304");
  assert.equal(again.headers.get("cache-control"), "no-cache");
});

test("a page is never kept, whatever it is asked with", async () => {
  for (const path of ["/", "/signin"]) {
    const page = await fetch(`${base}${path}`);
    const hash = page.headers.get("etag");
    assert.equal(hash, null, path);
    await page.arrayBuffer();
    for (const query of ["?v=000000000000", "?v=abc"]) {
      const asked = await fetch(`${base}${path}${query}`);
      assert.equal(asked.headers.get("cache-control"), "no-store", `${path}${query}`);
      assert.doesNotMatch(asked.headers.get("cache-control") ?? "", /immutable/);
      await asked.arrayBuffer();
    }
  }
});
