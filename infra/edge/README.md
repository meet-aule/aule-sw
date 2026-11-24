# Edge

The two Cloudflare Workers in front of the server: `playground.meetaule.com` (the session page and its API) and `livekit.meetaule.com` (LiveKit's signalling, WebSocket included; audio and video go straight to the server on its UDP and TCP ports). Each forwards to the server's address, kept as the Worker's secret `ORIGIN_URL` so it is not in this public repository. The server only accepts these ports from Cloudflare's address ranges.

Neither Worker writes a line per request to Cloudflare's logs (`"invocation_logs": false`): the browser sends its LiveKit room token in the address it connects to, and a sign-in's way back carries its code in the address too. Errors and uncaught exceptions are still logged, and traces, whose spans would carry the same addresses, stay off. `test_edge.py` checks both; the change takes effect when the Workers are deployed again.

```sh
cd infra/edge
wrangler deploy -c wrangler.playground.jsonc
wrangler secret put ORIGIN_URL -c wrangler.playground.jsonc   # http://<server>:8090
wrangler deploy -c wrangler.livekit.jsonc
wrangler secret put ORIGIN_URL -c wrangler.livekit.jsonc      # http://<server>:7880
```

The shop and the brand site have their own Worker in the store's repository.
