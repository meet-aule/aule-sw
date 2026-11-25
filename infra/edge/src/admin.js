// admin.meetaule.com: an address the team can remember for its panel. It only
// sends the browser to the panel on the playground, where the team signs in;
// nothing is served or forwarded here. Every address on this host goes to the
// same fixed page, so no part of a request can choose where it leads.
const PANEL = "https://playground.meetaule.com/session/admin";

export default {
  async fetch() {
    // A temporary redirect, kept by no cache, so the panel can move here later.
    return new Response(null, { status: 302, headers: { location: PANEL, "cache-control": "no-store" } });
  },
};
