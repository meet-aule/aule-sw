// playground.meetaule.com: the session page and its API, on the server.
// The bare address opens the session page, with its query: a shared link's
// ?src= says where the family came from. ORIGIN_URL is a secret of the
// Worker (the server's address is not kept in this public repository).
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "") {
      return Response.redirect(new URL(`/session/${url.search}`, url).toString(), 302);
    }
    const origin = new URL(env.ORIGIN_URL);
    origin.pathname = url.pathname;
    origin.search = url.search;
    // The incoming request's headers cannot be changed; a copy can.
    const headers = new Headers(request.headers);
    stripAnalyticsCookies(headers);
    return fetch(origin.toString(), {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });
  },
};

// Google Analytics' cookies (_ga, _ga_<ID>) end up set for all of meetaule.com
// from the brand site and the shop, so the browser sends them here too, and
// aule_consent, the answer about them, will go the same way once those sites
// share it. The children's app has no use for them, so they stop here, and the
// other cookies go on in their order. Both Workers carry this same function
// (test_edge.py checks it).
function stripAnalyticsCookies(headers) {
  const cookie = headers.get("cookie");
  if (cookie === null) return;
  const pairs = cookie.split(";");
  const kept = pairs.filter((pair) => {
    // A name is what comes before the pair's first "=", or the whole pair.
    const name = pair.split("=", 1)[0].trim();
    return name !== "_ga" && !name.startsWith("_ga_") && name !== "aule_consent";
  });
  // A Worker reads a header as UTF-8 text, so writing it back would turn a byte
  // that is not UTF-8 into U+FFFD: a header with nothing to take out stays as it came.
  if (kept.length === pairs.length) return;
  const left = kept.map((pair) => pair.trim()).filter((pair) => pair !== "");
  if (left.length === 0) headers.delete("cookie");
  else headers.set("cookie", left.join("; "));
}
