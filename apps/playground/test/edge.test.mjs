// The Worker in front of the page (infra/edge/src/playground.js): the bare
// address opens the session page and keeps the query, so a shared link's
// ?src= reaches the page; any other address goes to the server as it came.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// The Worker has no package of its own, so it is loaded from its source as a module.
const source = await readFile(new URL("../../../infra/edge/src/playground.js", import.meta.url), "utf8");
const { default: worker } = await import(`data:text/javascript,${encodeURIComponent(source)}`);

test("the bare address opens the session page with its query, on the same site", async () => {
  for (const [address, location] of [
    ["https://playground.meetaule.com/", "https://playground.meetaule.com/session/"],
    ["https://playground.meetaule.com/?src=cesar", "https://playground.meetaule.com/session/?src=cesar"],
    ["https://playground.meetaule.com/?//example.org/x", "https://playground.meetaule.com/session/?//example.org/x"],
  ]) {
    const response = await worker.fetch(new Request(address), {});
    assert.equal(response.status, 302, address);
    assert.equal(response.headers.get("location"), location);
  }
});

test("any other address goes to the server as it came, query and all", async (t) => {
  const asked = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    asked.push(url);
    return new Response(null, { status: 204 });
  });
  await worker.fetch(new Request("https://playground.meetaule.com/guia?src=cesar"), { ORIGIN_URL: "http://origin.invalid:8090" });
  assert.deepEqual(asked, ["http://origin.invalid:8090/guia?src=cesar"]);
});
