// admin.meetaule.com: the team's console on the server (apps/admin). Every
// address goes to the server as it came, the bare one included: the console
// has its own sign-in page and sends nobody anywhere else. Two secrets of the
// Worker: ORIGIN_URL, the server's address, which is not kept in this public
// repository, and EDGE_SECRET, which it adds to every request and without
// which the console answers nothing (the console's ADMIN_EDGE_SECRET).
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Only over https: in plain http the page, a code or the session's cookie
    // could be read or changed on the way, before the browser keeps HSTS.
    if (url.protocol !== "https:") return refuse(403, "Entra por https://admin.meetaule.com\n");
    if (!env.EDGE_SECRET) return refuse(503, "La consola no está configurada.\n");
    const origin = new URL(env.ORIGIN_URL);
    origin.pathname = url.pathname;
    origin.search = url.search;
    // The incoming request's headers cannot be changed; a copy can.
    const headers = new Headers(request.headers);
    stripAnalyticsCookies(headers);
    // That it came through this Worker, and from whom: the address Cloudflare
    // saw, which the console counts its sign-in limits by. Both are set over
    // whatever the request carried.
    headers.set("X-Edge-Secret", env.EDGE_SECRET);
    const client = request.headers.get("cf-connecting-ip");
    if (client) headers.set("X-Client-IP", client);
    else headers.delete("X-Client-IP");
    return fetch(origin.toString(), {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      // The console never redirects; whatever the server answers comes back as it is.
      redirect: "manual",
    });
  },
};

/** An answer of the Worker's own, never kept. */
function refuse(status, text) {
  return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

// The brand site and the shop leave their analytics cookies on all of
// meetaule.com, so the browser sends them here too: Google Analytics' (_ga,
// _ga_<ID>), PostHog's, and aule_consent, the visitor's answer about them. The
// team's console has no use for them either. This is the same function as the
// other forwarding Workers carry (test_edge.py checks it).
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
