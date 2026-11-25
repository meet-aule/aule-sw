// The Workers in front of the server (infra/edge/src). The page's Worker turns
// the bare address into the session page and keeps the query, so a shared
// link's ?src= reaches the page. Both send any other request to the server as
// it came, less the analytics cookies the brand site and the shop leave on all
// of meetaule.com.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// A Worker has no package of its own, so each is loaded from its source as a module.
async function load(file) {
  const source = await readFile(new URL(`../../../infra/edge/src/${file}`, import.meta.url), "utf8");
  return (await import(`data:text/javascript,${encodeURIComponent(source)}`)).default;
}
const playground = await load("playground.js");
const livekit = await load("livekit.js");
const admin = await load("admin.js");

test("the bare address opens the session page with its query, on the same site", async () => {
  for (const [address, location] of [
    ["https://playground.meetaule.com/", "https://playground.meetaule.com/session/"],
    ["https://playground.meetaule.com/?src=cesar", "https://playground.meetaule.com/session/?src=cesar"],
    ["https://playground.meetaule.com/?//example.org/x", "https://playground.meetaule.com/session/?//example.org/x"],
  ]) {
    const response = await playground.fetch(new Request(address), {});
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
  await playground.fetch(new Request("https://playground.meetaule.com/guia?src=cesar"), { ORIGIN_URL: "http://origin.invalid:8090" });
  assert.deepEqual(asked, ["http://origin.invalid:8090/guia?src=cesar"]);
});

test("the panel's address sends every request to the team's panel, and nowhere else", async (t) => {
  const asked = forwarded(t);
  for (const [method, address] of [
    ["GET", "https://admin.meetaule.com/"],
    ["GET", "https://admin.meetaule.com/session"],
    ["GET", "https://admin.meetaule.com/session/admin?next=https://example.org/"],
    ["GET", "https://admin.meetaule.com//example.org/x"],
    ["POST", "https://admin.meetaule.com/api/account"],
  ]) {
    const response = await admin.fetch(new Request(address, { method }), {});
    assert.equal(response.status, 302, address);
    assert.equal(response.headers.get("location"), "https://playground.meetaule.com/session/admin", address);
    assert.equal(response.headers.get("cache-control"), "no-store", address);
  }
  assert.deepEqual(asked, []);
});

// Each Worker, an address it serves, its settings, and where that address goes.
const WORKERS = [
  [
    "playground.js",
    playground,
    "https://playground.meetaule.com/session/api/account?src=feria",
    { ORIGIN_URL: "http://origin.invalid:8090" },
    "http://origin.invalid:8090/session/api/account?src=feria",
  ],
  [
    "livekit.js",
    livekit,
    "https://livekit.meetaule.com/rtc?access_token=token&auto_subscribe=1",
    { ORIGIN_URL: "http://origin.invalid:7880" },
    "http://origin.invalid:7880/rtc?access_token=token&auto_subscribe=1",
  ],
];

/** The requests the Workers hand to fetch, as Requests: livekit.js builds one, playground.js passes its parts. */
function forwarded(t) {
  const asked = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    asked.push(input instanceof Request ? input : new Request(input, init));
    return new Response(null, { status: 204 });
  });
  return asked;
}

const GUARDIAN = `aule_guardian=${"0".repeat(64)}`;
const GA = "_ga=GA1.1.1234567890.1763990000";
const GA4 = "_ga_AB12CD34EF=GS2.1.s1763990000$o1$g0$t1763990060$j60$l0$h0";

// The Cookie header the browser sends, and the one the server gets (null: none at all).
const COOKIES = [
  // A mix: the analytics cookies go, and the rest keep their order.
  [`${GUARDIAN}; ${GA}; aule_source=feria; ${GA4}; aule_consent=accepted; theme=dark`, `${GUARDIAN}; aule_source=feria; theme=dark`],
  // Only analytics cookies, _ga twice (one for the host, one for meetaule.com): the header goes.
  [`${GA}; ${GA4}; _ga=GA1.1.42.1763990001; aule_consent=rejected`, null],
  // None of them: the header goes on byte for byte, spacing and all.
  [`${GUARDIAN};aule_source=feria ;  theme=dark;`, `${GUARDIAN};aule_source=feria ;  theme=dark;`],
  // The same with one of them: the rest are joined again with "; ", in their
  // order, without the spaces around each pair or the empty ones.
  [`${GUARDIAN};aule_source=feria ;  ${GA};;theme=dark;`, `${GUARDIAN}; aule_source=feria; theme=dark`],
  // Malformed pairs. A name is what comes before the first "=", or the whole
  // pair, without the spaces around it; empty pairs go once the header is rewritten.
  [
    'flag; =orphan; a=b=c;; _ga; _ga_=; _ga_ABC ; _ga =GA1.1.9; ref=_ga=1; aule_consent; quoted="x y";',
    'flag; =orphan; a=b=c; ref=_ga=1; quoted="x y"',
  ],
  // Other Google cookies, _gac and _gat among them, and names that only look
  // alike, _ga_ further into the name included, stay: just _ga, a name starting
  // with _ga_, and aule_consent go, and case counts.
  [
    "_gac_UA-1=1.2.x; _gat=1; _gat_gtag_UA_1_1=1; _gid=GA1.1.9; _gcl_au=1.1.2; __ga=1; _gax=1; _ga-1=1; my_ga=1; aule_ga_x=1; x_ga_1=1; _GA=1; aule_consent2=1; _ga_gat=1",
    "_gac_UA-1=1.2.x; _gat=1; _gat_gtag_UA_1_1=1; _gid=GA1.1.9; _gcl_au=1.1.2; __ga=1; _gax=1; _ga-1=1; my_ga=1; aule_ga_x=1; x_ga_1=1; _GA=1; aule_consent2=1",
  ],
  // No Cookie header at all.
  [null, null],
];

const othersThanCookie = (headers) => [...headers].filter(([name]) => name !== "cookie");

test("both Workers take the analytics cookies out, keep the other cookies in their order and every other header as it came", async (t) => {
  const asked = forwarded(t);
  for (const [file, worker, address, env, origin] of WORKERS) {
    for (const [cookie, kept] of COOKIES) {
      const what = `${file}: ${cookie}`;
      const incoming = new Request(address, {
        headers: { "accept-language": "es-PE", "user-agent": "test", ...(cookie === null ? {} : { cookie }) },
      });
      const before = [...incoming.headers];
      await worker.fetch(incoming, env);
      const request = asked.at(-1);
      assert.equal(request.url, origin, what);
      assert.equal(request.method, "GET", what);
      assert.equal(request.headers.get("cookie"), kept, what);
      assert.deepEqual(othersThanCookie(request.headers), othersThanCookie(incoming.headers), what);
      // Cloudflare does not let a Worker change the incoming request's headers.
      assert.deepEqual([...incoming.headers], before, what);
    }
  }
  assert.equal(asked.length, WORKERS.length * COOKIES.length);
});

test("a WebSocket upgrade still goes to the server as it came, less those cookies", async (t) => {
  const asked = forwarded(t);
  const upgrade = {
    connection: "Upgrade",
    origin: "https://playground.meetaule.com",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    "sec-websocket-version": "13",
    upgrade: "websocket",
  };
  for (const [file, worker, address, env, origin] of WORKERS) {
    await worker.fetch(new Request(address, { headers: { ...upgrade, cookie: `${GA}; ${GUARDIAN}; ${GA4}` } }), env);
    const request = asked.at(-1);
    assert.equal(request.method, "GET", file);
    assert.equal(request.url, origin, file);
    assert.deepEqual(Object.fromEntries(request.headers), { ...upgrade, cookie: GUARDIAN }, file);
  }
});
