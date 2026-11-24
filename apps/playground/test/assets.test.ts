import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { fingerprint, keptUntilEdited, loadAssets, rewrite, stillFresh } from "../src/assets.ts";
import { readSettings } from "../src/config.ts";
import { createPlayground } from "../src/server.ts";
import { COMPLETE } from "./fixtures.ts";

const server = createPlayground(readSettings(COMPLETE));
let base = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/playground`;
});
after(() => server.close());

const YEAR = "public, max-age=31536000, immutable";
const versionOf = (text: string, name: string) =>
  text.match(new RegExp(`${name.replace(/\./g, "\\.")}\\?v=([0-9a-f]{12})`))?.[1];

test("the page points at fingerprinted files, and those are kept for a year", async () => {
  const html = await (await fetch(`${base}/`)).text();

  const css = versionOf(html, "style.css");
  assert.ok(css, "the stylesheet is fingerprinted");
  const style = await fetch(`${base}/style.css?v=${css}`);
  assert.equal(style.status, 200);
  assert.equal(style.headers.get("cache-control"), YEAR);
  const text = await style.text();

  // The page's own fonts are the only files its stylesheet names.
  for (const name of ["fonts/sans.woff2", "fonts/sans-italic.woff2", "fonts/serif.woff2", "fonts/serif-italic.woff2"]) {
    const version = versionOf(text, name);
    assert.ok(version, `${name} is fingerprinted in the stylesheet`);
    const file = await fetch(`${base}/${name}?v=${version}`);
    assert.equal(file.headers.get("cache-control"), YEAR, name);
    assert.equal(fingerprint(Buffer.from(await file.arrayBuffer())), version, `${name}'s version is its hash`);
  }
  for (const name of ["livekit-client.js", "wobnimo.js", "icon.svg", "apple-touch-icon.png", "manifest.webmanifest"]) {
    assert.ok(versionOf(html, name), `${name} is fingerprinted in the page`);
  }
});

test("a module has one address wherever it is named, so it runs once", async () => {
  const html = await (await fetch(`${base}/`)).text();
  const version = Object.fromEntries(
    ["signin.js", "onboarding.js", "home.js", "app.js", "students.js", "steps.js", "screens.js"].map((name) => [name, versionOf(html, name)]),
  );
  for (const [name, hash] of Object.entries(version)) assert.ok(hash, `${name} is fingerprinted in the page`);
  // Each module names the others at the same address the page does.
  const imports = {
    "app.js": ["home.js", "screens.js"],
    "signin.js": ["students.js", "steps.js", "screens.js"],
    "onboarding.js": ["students.js", "steps.js", "screens.js"],
    "home.js": ["students.js", "steps.js", "screens.js"],
    "screens.js": ["steps.js"],
  };
  for (const [name, wanted] of Object.entries(imports)) {
    const text = await (await fetch(`${base}/${name}?v=${version[name]}`)).text();
    for (const other of wanted) {
      assert.match(text, new RegExp(`from "\\./${other.replace(".", "\\.")}\\?v=${version[other]}"`), `${name} imports ${other}`);
    }
  }
  const appText = await (await fetch(`${base}/app.js?v=${version["app.js"]}`)).text();
  const visuals = versionOf(appText, "visuals.js");
  assert.ok(visuals, "app.js imports visuals.js at its fingerprint");
  const visualsFile = await fetch(`${base}/visuals.js?v=${visuals}`);
  assert.equal(visualsFile.headers.get("cache-control"), YEAR);
  await visualsFile.arrayBuffer();

  const manifest = await (await fetch(`${base}/manifest.webmanifest?v=${versionOf(html, "manifest.webmanifest")}`)).text();
  assert.ok(versionOf(manifest, "icon.svg"), "the manifest's icon is fingerprinted");
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
  // Kept, Back after signing out would bring the signed-in page back whole,
  // and an address with the page's hash would pin it for a year.
  for (const path of ["/", "/admin"]) {
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

test("answers about people are never kept", async () => {
  const account = await fetch(`${base}/api/account`);
  assert.equal(account.headers.get("cache-control"), "no-store");
  await account.arrayBuffer();
  const missing = await fetch(`${base}/nothing.png`);
  assert.equal(missing.status, 404);
  await missing.arrayBuffer();
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
