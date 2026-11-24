# Edge

The two Cloudflare Workers in front of the server: `playground.meetaule.com` (the session page and its API) and `livekit.meetaule.com` (LiveKit's signalling, WebSocket included; audio and video go straight to the server on its UDP and TCP ports). Each forwards to the server's address, kept as the Worker's secret `ORIGIN_URL` so it is not in this public repository. The server only accepts these ports from Cloudflare's address ranges.

Neither Worker writes a line per request to Cloudflare's logs (`"invocation_logs": false`): the browser sends its LiveKit room token in the address it connects to, and a sign-in's way back carries its code in the address too. Errors and uncaught exceptions are still logged, and traces, whose spans would carry the same addresses, stay off. `test_edge.py` checks both; the change takes effect when the Workers are deployed again.

Both Workers take Google Analytics' cookies (`_ga`, and any whose name starts with `_ga_`) and `aule_consent` out of every request before it reaches the server. Google's tag on the brand site and the shop sets its cookies for all of `meetaule.com`, although the store asks for one host only, so the browser sends them to the children's app and to LiveKit too; `aule_consent`, the visitor's answer about them, will travel the same way once those two sites share it. A Cookie header with none of them goes on byte for byte. When one or more go, the other cookies go on in their order, joined again with `; ` and without empty pairs, and a request left with none goes without the header; since a Worker reads the header as UTF-8 text, a byte in it that is not UTF-8 then reaches the server as U+FFFD (Aule's own cookies are plain ASCII). Nothing else changes, WebSocket upgrades included. This keeps the cookies from the server only: Cloudflare still receives them, since its edge is where they are taken out, and in the browser any script on the page can still read them. `apps/playground/test/edge.test.mjs` runs both Workers through the cases and `test_edge.py` checks that both deploy the same function; this too takes effect when the Workers are deployed again.

```sh
cd infra/edge
wrangler deploy -c wrangler.playground.jsonc
wrangler secret put ORIGIN_URL -c wrangler.playground.jsonc   # http://<server>:8090
wrangler deploy -c wrangler.livekit.jsonc
wrangler secret put ORIGIN_URL -c wrangler.livekit.jsonc      # http://<server>:7880
```

The shop and the brand site have their own Worker in the store's repository.
