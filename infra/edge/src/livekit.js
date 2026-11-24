// livekit.meetaule.com: LiveKit's signalling on the server, WebSocket included
// (a Request built from the incoming one carries the upgrade). The audio and
// video go straight to the server, not through here. ORIGIN_URL is a secret.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = new URL(env.ORIGIN_URL);
    origin.pathname = url.pathname;
    origin.search = url.search;
    const forwarded = new Request(origin.toString(), request);
    stripAnalyticsCookies(forwarded.headers);
    return fetch(forwarded);
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
