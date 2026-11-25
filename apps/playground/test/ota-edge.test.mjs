import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../../../infra/edge/src/ota.js", import.meta.url), "utf8");
const ota = (await import(`data:text/javascript,${encodeURIComponent(source)}`)).default;
const origin = "https://ota.example.org";
const manifest = { model: "aule-v0.2", version: "0.0.2", path: "/firmware/aule-v0.2-0.0.2.ota.bin", sha256: "a".repeat(64), size: 400 };
const image = new Uint8Array(400).fill(233);
const assets = [];
const env = { ASSETS: { fetch: async (request) => {
  assets.push(request);
  const path = new URL(request.url).pathname;
  if (path === "/manifest.json") return Response.json(manifest);
  if (path === manifest.path || path === "/firmware/aule-v0.2-0.0.1.ota.bin") {
    return new Response(request.method === "HEAD" ? null : image, { headers: { "Content-Length": "400" } });
  }
  return new Response(null, { status: 404 });
} } };
const request = (version = "0.0.1", board = "aule-v0.2", extra = {}) => new Request(`${origin}/ota/`, {
  method: "POST", headers: { "Content-Type": "application/json", Cookie: "private", "Serial-Number": "synthetic", Authorization: "private" },
  body: JSON.stringify({ application: { version }, board: { type: board, ssid: "private" }, ...extra }),
});

test("only newer numeric firmware on the matching board is offered, never a forced downgrade", async () => {
  for (const [current, offered] of [["0.0.1", true], ["0.0.2", false], ["0.0.3", false], ["2.6.0", false], ["0.10.0", false]]) {
    const reply = await ota.fetch(request(current), env);
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get("cache-control"), "no-store");
    const body = await reply.json();
    assert.equal(body.firmware.url, offered ? origin + manifest.path : "");
    assert.equal(body.firmware.version, offered ? manifest.version : current);
    assert.equal(body.firmware.force, undefined);
    assert.equal(body.server_time.timezone_offset, 0);
    assert.ok(Math.abs(body.server_time.timestamp - Date.now()) < 1000);
    assert.equal(body.activation, undefined);
  }
  for (const board of ["waveshare", "aule-v0.3", null]) {
    assert.equal((await (await ota.fetch(request("0.0.1", board), env)).json()).firmware, undefined);
  }
});

test("malformed input, invalid versions and oversized streamed bodies fail closed", async () => {
  for (const v of ["0.0.1-dev", "", "0.00.1", "99999999999999999.0.0", null, 1]) {
    assert.equal((await ota.fetch(request(v), env)).status, 400);
  }
  for (const body of ["[]", "null", "{", '"text"']) {
    assert.equal((await ota.fetch(new Request(`${origin}/ota/`, { method: "POST", headers: { "content-type": "application/json" }, body }), env)).status, 400);
  }
  assert.equal((await ota.fetch(new Request(`${origin}/ota/`, { method: "POST", body: "{}" }), env)).status, 415);
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(8192)); controller.enqueue(new Uint8Array(8193)); controller.close();
  } });
  assert.equal((await ota.fetch(new Request(`${origin}/ota/`, { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" }), env)).status, 413);
});

test("unknown paths, activation, session creation, administrative routes and HTTP stay closed", async () => {
  for (const path of ["/v1/devices", "/ota/activate", "/ota/session", "/manifest.json", "/firmware/file.bin", "/ota//", "//ota/"]) {
    assert.equal((await ota.fetch(new Request(origin + path), env)).status, 404);
  }
  assert.equal((await ota.fetch(new Request(`${origin}/ota/`), env)).status, 405);
  assert.equal((await ota.fetch(new Request(`${origin}/healthz?serial=test`), env)).status, 400);
  assert.equal((await ota.fetch(new Request("http://ota.example.org/healthz"), env)).status, 426);
});

test("firmware GET/HEAD preserve bytes and length, old URLs survive, and nothing is forwarded externally", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("must not contact an external origin"); });
  assets.length = 0;
  await ota.fetch(request(), env);
  for (const method of ["GET", "HEAD"]) {
    const response = await ota.fetch(new Request(origin + manifest.path, { method, headers: { cookie: "private", authorization: "private", range: "bytes=0-20" } }), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-length"), "400");
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.equal((await response.arrayBuffer()).byteLength, method === "GET" ? 400 : 0);
  }
  assert.equal((await ota.fetch(new Request(origin + "/firmware/aule-v0.2-0.0.1.ota.bin"), env)).status, 200);
  assert.equal((await ota.fetch(new Request(origin + "/firmware/aule-v0.2-0.0.9.ota.bin"), env)).status, 404);
  for (const asset of assets) {
    assert.deepEqual([...asset.headers], []);
    assert.equal(asset.body, null);
    assert.equal(new URL(asset.url).search, "");
  }
});

test("missing, malformed or unavailable manifests produce no update or redirect", async () => {
  for (const value of [null, { ...manifest, version: "bad" }, { ...manifest, path: "https://evil.invalid/image" }, { ...manifest, sha256: "bad" }]) {
    const broken = { ASSETS: { fetch: async () => Response.json(value) } };
    assert.equal((await ota.fetch(request(), broken)).status, 503);
    assert.equal((await ota.fetch(new Request(origin + "/healthz"), broken)).status, 503);
  }
  const down = { ASSETS: { fetch: async () => { throw new Error("private details"); } } };
  const response = await ota.fetch(request(), down);
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes("private"), false);
});
