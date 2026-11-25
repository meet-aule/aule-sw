// The console's files, fingerprinted as the playground's are: assets.ts is a
// copy of apps/playground/src/assets.ts, and the tests of its pure parts are
// copied with it.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { fingerprint, keptUntilEdited, loadAssets, rewrite, stillFresh } from "../src/assets.ts";
import { FakePlatform, startConsole } from "./fake-platform.ts";

const platform = await new FakePlatform().listen();
let base = "";
let close = () => {};

before(async () => {
  ({ base, close } = await startConsole(platform));
});
after(() => {
  close();
  platform.close();
});

const YEAR = "public, max-age=31536000, immutable";
const versionOf = (text: string, name: string) =>
  text.match(new RegExp(`${name.replace(/\./g, "\\.")}\\?v=([0-9a-f]{12})`))?.[1];

test("the pages point at fingerprinted files, and those are kept for a year", async () => {
  for (const path of ["/", "/live", "/families", "/family", "/passkeys", "/signin"]) {
    const html = await (await fetch(`${base}${path}`)).text();
    for (const name of ["style.css", "icon.svg"]) assert.ok(versionOf(html, name), `${path} names ${name} by its fingerprint`);
  }
  const html = await (await fetch(`${base}/`)).text();
  const style = await fetch(`${base}/style.css?v=${versionOf(html, "style.css")}`);
  assert.equal(style.status, 200);
  assert.equal(style.headers.get("cache-control"), YEAR);
  const text = await style.text();

  // The console's own two fonts are the only files its stylesheet names.
  const named = [...text.matchAll(/url\("([^"?]+)/g)].map(([, name]) => name);
  assert.deepEqual(named, ["fonts/serif.woff2", "fonts/sans.woff2"]);
  for (const name of named) {
    const version = versionOf(text, name!);
    assert.ok(version, `${name} is fingerprinted in the stylesheet`);
    const file = await fetch(`${base}/${name}?v=${version}`);
    assert.equal(file.headers.get("cache-control"), YEAR, name);
    assert.equal(file.headers.get("content-type"), "font/woff2", name);
    assert.equal(fingerprint(Buffer.from(await file.arrayBuffer())), version, `${name}'s version is its hash`);
  }
});

test("a module has one address wherever it is named, so it runs once", async () => {
  const html = await (await fetch(`${base}/`)).text();
  const panel = versionOf(html, "admin.js");
  assert.ok(panel, "admin.js is fingerprinted in the page");
  const text = await (await fetch(`${base}/admin.js?v=${panel}`)).text();
  const pilot = versionOf(text, "pilot.js");
  assert.ok(pilot, "admin.js imports pilot.js at its fingerprint");
  assert.match(text, new RegExp(`from "\\./pilot\\.js\\?v=${pilot}"`));
  const file = await fetch(`${base}/pilot.js?v=${pilot}`);
  assert.equal(file.headers.get("cache-control"), YEAR);
  assert.equal(fingerprint(Buffer.from(await file.arrayBuffer())), pilot);
  const signin = await (await fetch(`${base}/signin`)).text();
  assert.ok(versionOf(signin, "signin.js"), "the sign-in page's script is fingerprinted too");
  // What the pages share is one module wherever it is named: the panel's copy of common.js is live.js's.
  const liveHtml = await (await fetch(`${base}/live`)).text();
  const live = await (await fetch(`${base}/live.js?v=${versionOf(liveHtml, "live.js")}`)).text();
  for (const shared of ["common.js", "labels.js"]) assert.ok(versionOf(live, shared), `live.js imports ${shared} at its fingerprint`);
  assert.equal(versionOf(live, "common.js"), versionOf(text, "common.js"));
});

test("without the right version a file is checked every time, and a match is a 304", async () => {
  const plain = await fetch(`${base}/style.css`);
  assert.equal(plain.headers.get("cache-control"), "no-cache");
  const etag = plain.headers.get("etag");
  assert.ok(etag);
  await plain.arrayBuffer();

  // An old page asking for an old version gets today's file, not kept.
  const stale = await fetch(`${base}/style.css?v=000000000000`);
  assert.equal(stale.headers.get("cache-control"), "no-cache");
  await stale.arrayBuffer();

  const again = await fetch(`${base}/style.css`, { headers: { "If-None-Match": etag } });
  assert.equal(again.status, 304);
  assert.match(again.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.equal(await again.text(), "");
});

test("a page is never kept, not even asked for at its own hash", async () => {
  // Kept, Back after signing out could bring the panel back whole, with the families' addresses.
  for (const path of ["/", "/live", "/families", "/family", "/passkeys", "/signin"]) {
    const page = await fetch(`${base}${path}`);
    assert.equal(page.headers.get("cache-control"), "no-store", path);
    assert.equal(page.headers.get("etag"), null, path);
    const hash = fingerprint(Buffer.from(await page.arrayBuffer()));
    const pinned = await fetch(`${base}${path}?v=${hash}`);
    assert.equal(pinned.headers.get("cache-control"), "no-store", `${path}?v=<its hash>`);
    await pinned.arrayBuffer();
    const checked = await fetch(`${base}${path}`, { headers: { "If-None-Match": `"${hash}"` } });
    assert.equal(checked.status, 200, `${path} is sent whole`);
    await checked.arrayBuffer();
  }
});

test("only the console's own files are served: no italic, no other package, nothing missing", async () => {
  for (const path of ["/fonts/sans-italic.woff2", "/fonts/serif-italic.woff2", "/livekit-client.js", "/manifest.webmanifest", "/nothing.png"]) {
    const missing = await fetch(`${base}${path}`);
    assert.equal(missing.status, 404, path);
    await missing.arrayBuffer();
  }
  const dir = new URL("../public/", import.meta.url);
  for (const name of [
    "index.html",
    "live.html",
    "families.html",
    "family.html",
    "passkeys.html",
    "signin.html",
    "admin.js",
    "common.js",
    "credential.js",
    "labels.js",
    "live.js",
    "families.js",
    "family.js",
    "passkeys.js",
    "pilot.js",
    "signin.js",
    "style.css",
    "icon.svg",
  ]) {
    assert.ok((await readFile(new URL(name, dir))).length > 0, name);
  }
});

test("rewrite versions whole names in quotes and url(), and nothing else", () => {
  const versions = new Map([
    ["app.js", "aaa"],
    ["paper.png", "bbb"],
  ]);
  assert.equal(rewrite(`<script src="app.js"></script>`, versions), `<script src="app.js?v=aaa"></script>`);
  assert.equal(rewrite(`import { x } from "./app.js";`, versions), `import { x } from "./app.js?v=aaa";`);
  assert.equal(rewrite(`background: url("paper.png");`, versions), `background: url("paper.png?v=bbb");`);
  assert.equal(
    rewrite(`url(paper.png) url(./paper.png) url('paper.png')`, versions),
    `url(paper.png?v=bbb) url(./paper.png?v=bbb) url('paper.png?v=bbb')`,
  );
  assert.equal(rewrite(`"myapp.js" 'app.json' "app.jsx"`, versions), `"myapp.js" 'app.json' "app.jsx"`);
  assert.equal(rewrite(`// It stays at the bottom (app.js).`, versions), `// It stays at the bottom (app.js).`);
});

test("a script that names the stylesheet in a comment keeps its address when only the stylesheet changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aule-assets-"));
  try {
    const sources = {
      "/app.js": { file: join(dir, "app.js"), type: "text/javascript; charset=utf-8" },
      "/style.css": { file: join(dir, "style.css"), type: "text/css; charset=utf-8" },
    };
    const own = new Set(["/app.js"]);
    const script = "// On a phone the button then stays at the bottom of the screen (style.css).\n";
    await writeFile(join(dir, "app.js"), script);
    await writeFile(join(dir, "style.css"), "main { color: black }\n");
    const first = await loadAssets(sources, own);
    await writeFile(join(dir, "style.css"), "main { color: brown }\n");
    const second = await loadAssets(sources, own);

    assert.notEqual(second.get("/style.css")?.hash, first.get("/style.css")?.hash);
    assert.equal(second.get("/app.js")?.hash, first.get("/app.js")?.hash, "families keep the script they have");
    assert.equal(second.get("/app.js")?.body.toString(), script);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the files are read once, and again after an edit in their folder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aule-assets-"));
  const file = join(dir, "style.css");
  await writeFile(file, "black");
  let reads = 0;
  const kept = keptUntilEdited(dir, () => {
    reads += 1;
    return readFile(file, "utf8");
  });
  try {
    assert.equal(kept.get(), kept.get(), "asked twice, read once");
    assert.equal(await kept.get(), "black");
    assert.equal(reads, 1);

    await writeFile(file, "brown");
    // The system tells of the edit a moment later.
    let seen = await kept.get();
    for (let wait = 0; seen !== "brown" && wait < 150; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      seen = await kept.get();
    }
    assert.equal(seen, "brown");
  } finally {
    kept.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an ETag still matches when Cloudflare has marked it weak, or among others", () => {
  assert.equal(stillFresh('"abc"', '"abc"'), true);
  assert.equal(stillFresh('W/"abc"', '"abc"'), true);
  assert.equal(stillFresh('"x", W/"abc"', '"abc"'), true);
  assert.equal(stillFresh("*", '"abc"'), true);
  assert.equal(stillFresh('"abd"', '"abc"'), false);
  assert.equal(stillFresh(undefined, '"abc"'), false);
});
