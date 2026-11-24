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
    return fetch(origin.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });
  },
};
