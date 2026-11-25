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

// The brand site and the shop leave their analytics cookies on all of
// meetaule.com, so the browser sends them here too: Google Analytics' (_ga,
// _ga_<ID>), PostHog's, and aule_consent, the visitor's answer about them. The
// children's app has no use for them, so they stop here, and the other cookies
// go on in their order. Both Workers carry this same function (test_edge.py
// checks it).
function stripAnalyticsCookies(headers) {
  const cookie = headers.get("cookie");
  if (cookie === null) return;
  const pairs = cookie.split(";");
  const kept = pairs.filter((pair) => {
    // A name is what comes before the pair's first "=", or the whole pair.
    const name = pair.split("=", 1)[0].trim();
    const google = name === "_ga" || name.startsWith("_ga_");
    // The names posthog-js (read in 1.447.12) gives its cookies, <key> being the
    // project key: ph_<key>_posthog, the visitor's ID, and ph_<key>_posthog_cpm
    // beside it; __ph_opt_in_out_<key> if its consent record is kept in a cookie;
    // and two probes it deletes at once. Names a site may choose instead
    // (persistence_name and the like) are not caught: the store must not choose any.
    const posthog =
      /^ph_.+_posthog(_cpm)?$/.test(name) ||
      name.startsWith("__ph_opt_in_out_") ||
      name.startsWith("__ph_cookie_support_") ||
      name.startsWith("dmn_chk_");
    return !google && !posthog && name !== "aule_consent";
  });
  // A Worker reads a header as UTF-8 text, so writing it back would turn a byte
  // that is not UTF-8 into U+FFFD: a header with nothing to take out stays as it came.
  if (kept.length === pairs.length) return;
  const left = kept.map((pair) => pair.trim()).filter((pair) => pair !== "");
  if (left.length === 0) headers.delete("cookie");
  else headers.set("cookie", left.join("; "));
}
