// The Workers in front of the server (infra/edge/src). The page's Worker turns
// the bare address into the session page and keeps the query, so a shared
// link's ?src= reaches the page. The mobile API has a dedicated origin.
// Other requests lose the analytics cookies shared by the brand site and shop.
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

test("the guide goes to the web origin with its query", async (t) => {
  const asked = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    asked.push(url);
    return new Response(null, { status: 204 });
  });
  await playground.fetch(new Request("https://playground.meetaule.com/guia?src=cesar"), { ORIGIN_URL: "http://origin.invalid:8090" });
  assert.deepEqual(asked, ["http://origin.invalid:8090/guia?src=cesar"]);
});

const MOBILE_ENV = {
  ORIGIN_URL: "http://origin.invalid:8090",
  MOBILE_API_ORIGIN: "https://protected-origin.example.test",
  MOBILE_API_ORIGIN_SECRET: "01".repeat(32),
};
const MOBILE = "https://playground.meetaule.com/session/api/v1";

test("the mobile API carries its bearer and body over the protected origin with the Worker's own credentials", async (t) => {
  const sent = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    sent.push({
      url: String(input),
      method: init.method,
      authorization: init.headers.get("authorization"),
      type: init.headers.get("content-type"),
      originProof: init.headers.get("x-aule-mobile-origin"),
      keys: [...init.headers.keys()].sort(),
      redirect: init.redirect,
      cache: init.cache,
      body: init.body ? await new Response(init.body).text() : null,
    });
    return new Response('{"id":"x"}', {
      status: 201,
      headers: { "content-type": "application/json", "set-cookie": "example=value" },
    });
  });
  const token = "ab".repeat(32);
  const body = JSON.stringify({ nickname: "Mati" });
  const family = "0193a1f0-0000-7000-8000-000000000001";
  const response = await playground.fetch(
    new Request(`https://playground.meetaule.com/session/api/v1/families/${family}/children`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        cookie: "origin-cookie=value",
        "x-aule-mobile-origin": "caller",
        "x-forwarded-host": "untrusted.example.test",
      },
      body,
    }),
    MOBILE_ENV,
  );
  assert.deepEqual(sent, [
    {
      url: `${MOBILE_ENV.MOBILE_API_ORIGIN}/session/api/v1/families/${family}/children`,
      method: "POST",
      authorization: `Bearer ${token}`,
      type: "application/json",
      originProof: MOBILE_ENV.MOBILE_API_ORIGIN_SECRET,
      keys: ["authorization", "content-type", "x-aule-mobile-origin"],
      redirect: "manual",
      cache: "no-store",
      body,
    },
  ]);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), '{"id":"x"}');
});

test("plain transport, a different public host or missing protected-origin settings never reach either origin", async (t) => {
  const send = t.mock.method(globalThis, "fetch", () => assert.fail("unexpected upstream request"));
  for (const link of [MOBILE.replace("https:", "http:"), MOBILE.replace("playground.meetaule.com", "preview.example.test")]) {
    assert.equal((await playground.fetch(new Request(link + "/me"), MOBILE_ENV)).status, 403);
  }
  for (const bad of [
    { MOBILE_API_ORIGIN: undefined },
    { MOBILE_API_ORIGIN: MOBILE_ENV.ORIGIN_URL },
    { MOBILE_API_ORIGIN: "invalid" },
    { MOBILE_API_ORIGIN: MOBILE_ENV.MOBILE_API_ORIGIN + "/another-path" },
    { MOBILE_API_ORIGIN: "https://playground.meetaule.com" },
    { MOBILE_API_ORIGIN_SECRET: "too-short" },
    { MOBILE_API_ORIGIN_SECRET: undefined },
  ]) {
    assert.equal((await playground.fetch(new Request(MOBILE + "/me"), { ...MOBILE_ENV, ...bad })).status, 503);
  }
  assert.equal(send.mock.callCount(), 0);
});

test("anonymous sign-in and paths normalized by the playground use the encrypted route; another prefix keeps its original route", async (t) => {
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    sent.push([String(url), init.headers.get("authorization"), init.headers.get("x-aule-mobile-origin")]);
    return new Response(null, { status: 204 });
  });
  const publicHost = "https://playground.meetaule.com";
  for (const [path, method] of [
    ["/session/api/v1/auth/start", "POST"],
    ["/session//api/v1/auth/verify", "POST"],
    ["/session/api//v1/auth/google", "GET"],
    ["/session/api/v1/me?limit=1", "GET"],
    ["/session/api/v10/me", "GET"],
  ]) {
    await playground.fetch(new Request(publicHost + path, { method }), MOBILE_ENV);
  }
  const api = MOBILE_ENV.MOBILE_API_ORIGIN + "/session/api/v1";
  const proof = MOBILE_ENV.MOBILE_API_ORIGIN_SECRET;
  assert.deepEqual(sent, [
    [api + "/auth/start", null, proof],
    [api + "/auth/verify", null, proof],
    [api + "/auth/google", null, proof],
    [api + "/me?limit=1", null, proof],
    [MOBILE_ENV.ORIGIN_URL + "/session/api/v10/me", null, null],
  ]);
});

test("an unavailable, redirecting or HTML origin returns an uncached API error without following or exposing the redirect", async (t) => {
  for (const upstream of [
    () => Response.redirect("https://login.example.test"),
    () => new Response("Proxy error", { status: 403, headers: { "Content-Type": "text/html" } }),
    () => Promise.reject(new Error("transport unavailable")),
  ]) {
    const send = t.mock.method(globalThis, "fetch", upstream);
    const result = await playground.fetch(new Request(MOBILE + "/me"), MOBILE_ENV);
    assert.equal(result.status, 503);
    assert.equal(result.headers.get("location"), null);
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.deepEqual(await result.json(), { error: { code: "unavailable", message: "service unavailable" } });
    assert.equal(send.mock.callCount(), 1);
    send.mock.restore();
  }
});

// The console's Worker's secret in these tests, and what it adds to every request with it.
const EDGE_SECRET = "an-edge-secret-of-the-tests-0123456789abcdef";
const ADMIN_ENV = { ORIGIN_URL: "http://origin.invalid:8092", EDGE_SECRET };

// Each Worker, an address it serves, its settings, where that address goes,
// and the headers it adds of its own.
const WORKERS = [
  [
    "playground.js",
    playground,
    "https://playground.meetaule.com/session/api/account?src=feria",
    { ORIGIN_URL: "http://origin.invalid:8090" },
    "http://origin.invalid:8090/session/api/account?src=feria",
    {},
  ],
  [
    "livekit.js",
    livekit,
    "https://livekit.meetaule.com/rtc?access_token=token&auto_subscribe=1",
    { ORIGIN_URL: "http://origin.invalid:7880" },
    "http://origin.invalid:7880/rtc?access_token=token&auto_subscribe=1",
    {},
  ],
  [
    "admin.js",
    admin,
    "https://admin.meetaule.com/api/families?q=ana",
    ADMIN_ENV,
    "http://origin.invalid:8092/api/families?q=ana",
    { "x-edge-secret": EDGE_SECRET },
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
// PostHog's, named as posthog-js 1.447.12 names them, for a made-up project key.
const PH_KEY = "phc_madeUpProjectKey";
const PH = `ph_${PH_KEY}_posthog=%7B%22distinct_id%22%3A%22019ab3c4-5d6e-7f80-9a1b-2c3d4e5f6a7b%22%2C%22%24user_state%22%3A%22anonymous%22%7D`;
const PH_CPM = `ph_${PH_KEY}_posthog_cpm=%7B%22p%22%3A%5B%5D%2C%22f%22%3A%223k.1x2y3z4.5a6b7c8%22%7D`;
const PH_CONSENT = `__ph_opt_in_out_${PH_KEY}=1`;
const PH_PROBES = "__ph_cookie_support_019ab3c4-5d6e-7f80-9a1b-2c3d4e5f6a7c=%22xyz%22; dmn_chk_019ab3c4-5d6e-7f80-9a1b-2c3d4e5f6a7d=1";
// Names with ph or posthog in them, and PostHog's own with something before,
// after or in another case: posthog-js sets a cookie under none of them.
const NOT_POSTHOG = [
  "ph=1", "ph_=1", "phone=1", "graph_x=1", "aule_ph_x=1", "posthog=1", "my_posthog=1", `x${PH}`,
  `PH_${PH_KEY}_posthog=1`, `ph_${PH_KEY}_Posthog=1`, `ph_${PH_KEY}_posthogx=1`, `ph_${PH_KEY}_posthog_x=1`,
  `ph_${PH_KEY}_posthog_cpmx=1`, `ph_${PH_KEY}_posthog_CPM=1`, "__ph=1", `_ph_opt_in_out_${PH_KEY}=1`,
  "__ph_opt_in_out=1", `__PH_OPT_IN_OUT_${PH_KEY}=1`, "__ph_cookie_support=1", "dmn_chk=1", "dmn_chk1=1",
  "xdmn_chk_1=1", "DMN_CHK_1=1",
].join("; ");

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
  // PostHog's go too, from among the others, which keep their order.
  [`${GUARDIAN}; ${PH}; aule_source=feria; ${PH_CPM}; theme=dark`, `${GUARDIAN}; aule_source=feria; theme=dark`],
  // Every name posthog-js gives a cookie, its two probes included, with
  // Google's and aule_consent: nothing is left, so the header goes.
  [`${PH}; ${PH_CPM}; ${PH_CONSENT}; ${PH_PROBES}; ${GA}; aule_consent=accepted`, null],
  // Malformed pairs of PostHog's go as Google's do: no value, spaces around
  // the name, nothing after the prefix.
  [`flag; ph_${PH_KEY}_posthog; __ph_opt_in_out_${PH_KEY} =0; dmn_chk_=; __ph_cookie_support_ ; a=b`, "flag; a=b"],
  // A name that merely has ph in it, or looks like PostHog's, stays: only
  // ph_<key>_posthog and ph_<key>_posthog_cpm, whatever the key, and the three
  // prefixes go.
  [`${NOT_POSTHOG}; ph_a_posthog=1`, NOT_POSTHOG],
  // No Cookie header at all.
  [null, null],
];

const othersThanCookie = (headers) => Object.fromEntries([...headers].filter(([name]) => name !== "cookie"));

test("every forwarding Worker takes the analytics cookies out, keeps the other cookies in their order and every other header as it came", async (t) => {
  const asked = forwarded(t);
  for (const [file, worker, address, env, origin, added] of WORKERS) {
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
      assert.deepEqual(othersThanCookie(request.headers), { ...othersThanCookie(incoming.headers), ...added }, what);
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
  for (const [file, worker, address, env, origin, added] of WORKERS) {
    await worker.fetch(new Request(address, { headers: { ...upgrade, cookie: `${GA}; ${GUARDIAN}; ${PH}; ${GA4}` } }), env);
    const request = asked.at(-1);
    assert.equal(request.method, "GET", file);
    assert.equal(request.url, origin, file);
    assert.deepEqual(Object.fromEntries(request.headers), { ...upgrade, cookie: GUARDIAN, ...added }, file);
  }
});

test("the console's bare address goes to the console as it came: its own sign-in decides, not a redirect", async (t) => {
  const asked = forwarded(t);
  for (const [address, origin] of [
    ["https://admin.meetaule.com/", "http://origin.invalid:8092/"],
    ["https://admin.meetaule.com", "http://origin.invalid:8092/"],
    ["https://admin.meetaule.com/signin?next=https://evil.example", "http://origin.invalid:8092/signin?next=https://evil.example"],
  ]) {
    const response = await admin.fetch(new Request(address), ADMIN_ENV);
    assert.equal(response.status, 204, address);
    assert.equal(asked.at(-1).url, origin, address);
  }
});

test("the console's writes reach it with their body, and its answers come back as they are, never followed", async (t) => {
  const sent = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    // A Worker hands fetch a stream as the body; Node reads it the same way.
    sent.push({ url: String(input), method: init.method, redirect: init.redirect, body: init.body ? await new Response(init.body).text() : null });
    return new Response(null, { status: 303, headers: { location: "https://elsewhere.example/" } });
  });
  const body = JSON.stringify({ email: "equipo@example.org" });
  const response = await admin.fetch(
    new Request("https://admin.meetaule.com/api/signin/start", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://admin.meetaule.com" },
      body,
    }),
    ADMIN_ENV,
  );
  assert.deepEqual(sent, [{ url: "http://origin.invalid:8092/api/signin/start", method: "POST", redirect: "manual", body }]);
  assert.equal(response.status, 303, "handed back, not followed");
  assert.equal(response.headers.get("location"), "https://elsewhere.example/");
});

test("the console's Worker adds its secret and the address Cloudflare saw, over whatever the request carried", async (t) => {
  const asked = forwarded(t);
  const forged = { "x-edge-secret": "forged", "x-client-ip": "198.51.100.66" };
  await admin.fetch(new Request("https://admin.meetaule.com/api/signin/verify", { headers: { ...forged, "cf-connecting-ip": "203.0.113.9" } }), ADMIN_ENV);
  assert.equal(asked.at(-1).headers.get("x-edge-secret"), EDGE_SECRET);
  assert.equal(asked.at(-1).headers.get("x-client-ip"), "203.0.113.9");
  await admin.fetch(new Request("https://admin.meetaule.com/", { headers: { "cf-connecting-ip": "2001:db8::7" } }), ADMIN_ENV);
  assert.equal(asked.at(-1).headers.get("x-client-ip"), "2001:db8::7");
  // With no address from Cloudflare, none goes on: never the one the request named.
  await admin.fetch(new Request("https://admin.meetaule.com/", { headers: forged }), ADMIN_ENV);
  assert.equal(asked.at(-1).headers.get("x-client-ip"), null);
  assert.equal(asked.at(-1).headers.get("x-edge-secret"), EDGE_SECRET);
});

test("the console's Worker answers plain http, and a missing secret, itself: nothing reaches the server", async (t) => {
  const asked = forwarded(t);
  for (const [address, env, status] of [
    ["http://admin.meetaule.com/", ADMIN_ENV, 403],
    ["http://admin.meetaule.com/api/signin/start", ADMIN_ENV, 403],
    ["https://admin.meetaule.com/", { ORIGIN_URL: "http://origin.invalid:8092" }, 503],
    ["https://admin.meetaule.com/", { ORIGIN_URL: "http://origin.invalid:8092", EDGE_SECRET: "" }, 503],
  ]) {
    const response = await admin.fetch(new Request(address, { headers: { cookie: GUARDIAN } }), env);
    assert.equal(response.status, status, address);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("location"), null, "no redirect");
  }
  assert.equal(asked.length, 0);
});
