# Edge

The three Cloudflare proxy Workers in front of the server: `playground.meetaule.com` (the session page and its API), `livekit.meetaule.com` (LiveKit's signalling, WebSocket included; audio and video go straight to the server on its UDP and TCP ports) and `admin.meetaule.com` (the team's console, `apps/admin`). Each forwards to the server's address, kept as the Worker's secret `ORIGIN_URL` so it is not in this public repository. The server only accepts these ports from Cloudflare's address ranges.

The console's Worker forwards every address as it came, the bare one included, and hands back whatever the console answers without following it; the console has its own sign-in and redirects nobody. It is reachable only at `admin.meetaule.com`: it has no workers.dev address and no preview URLs (`"workers_dev": false`, `"preview_urls": false`). It answers a plain http request itself with a 403, so the page, a code or the session's cookie never cross between the browser and Cloudflare unencrypted, and it adds two headers of its own over whatever the request carried: `X-Edge-Secret`, its secret `EDGE_SECRET`, without which the console gives every address the same 404 (the console's `ADMIN_EDGE_SECRET` is the same value), and `X-Client-IP`, the address Cloudflare saw (`CF-Connecting-IP`), which the console counts its sign-in limits by. Without `EDGE_SECRET` the Worker answers 503 and forwards nothing. From Cloudflare to the server the request still travels in plain http, as the playground's does: the secret shows the console the request came through this Worker, but it hides nothing on the way (`infra/server/README.md`).

None of the Workers writes a line per request to Cloudflare's logs (`"invocation_logs": false`): the browser sends its LiveKit room token in the address it connects to, and a sign-in's way back carries its code in the address too. Errors and uncaught exceptions are still logged, and traces, whose spans would carry the same addresses, stay off. `test_edge.py` checks both; the change takes effect when the Workers are deployed again.

The proxy Workers take the analytics cookies of the brand site and the shop out of every request before it reaches the server: Google Analytics' (`_ga`, and any whose name starts with `_ga_`), PostHog's (below) and `aule_consent`, the visitor's answer about them. Google's tag sets its cookies for all of `meetaule.com` although the store asks for one host only, PostHog keeps the visitor's ID there on purpose so that both sites count one visitor, and the store keeps the answer both sites share there as well; so the browser sends them to the children's app, to LiveKit and to the team's console too. PostHog's are the cookies posthog-js names itself (read in its version 1.447.12), `<key>` being the project key: `ph_<key>_posthog`, which keeps the visitor's anonymous ID and session, and `ph_<key>_posthog_cpm` beside it; `__ph_opt_in_out_<key>`, PostHog's own consent record, if it is told to keep that in a cookie; and `__ph_cookie_support_<ID>` and `dmn_chk_<ID>`, which it sets and deletes at once to learn what the browser allows. Only those shapes go, exactly and with their case: a name made of `ph_`, a key and `_posthog` or `_posthog_cpm`, or one that starts with one of the other three prefixes. A name that merely has `ph` in it stays. posthog-js also lets a site give these cookies names of its choosing (`persistence_name`, `consent_persistence_name`, `opt_out_capturing_cookie_prefix`), and those would get through, so the store must not use them unless this list changes with it; a newer posthog-js should be read against this list before the store moves to it. A Cookie header with none of them goes on byte for byte. When one or more go, the other cookies go on in their order, joined again with `; ` and without empty pairs, and a request left with none goes without the header; since a Worker reads the header as UTF-8 text, a byte in it that is not UTF-8 then reaches the server as U+FFFD (Aule's own cookies are plain ASCII). Nothing else changes, WebSocket upgrades included. This keeps the cookies from the server only: Cloudflare still receives them, since its edge is where they are taken out, and in the browser any script on the page can still read them. `apps/playground/test/edge.test.mjs` runs each of them through the cases and `test_edge.py` checks that they all deploy the same function; this too takes effect when the Workers are deployed again.

```sh
cd infra/edge
# Provision and verify the mobile route below before activating the playground Worker.
wrangler deploy -c wrangler.playground.jsonc
wrangler secret put ORIGIN_URL -c wrangler.playground.jsonc   # http://<server>:8090
wrangler deploy -c wrangler.livekit.jsonc
wrangler secret put ORIGIN_URL -c wrangler.livekit.jsonc      # http://<server>:7880
wrangler deploy --dry-run -c wrangler.admin.jsonc             # builds it and uploads nothing
wrangler deploy -c wrangler.admin.jsonc
wrangler secret put ORIGIN_URL -c wrangler.admin.jsonc        # http://<server>:8092
wrangler secret put EDGE_SECRET -c wrangler.admin.jsonc       # the console's ADMIN_EDGE_SECRET
```

The shop and the brand site have their own Worker in the store's repository.

## Family mobile API

The playground Worker routes `/session/api/v1` and its subpaths to a dedicated
HTTPS service origin. The Worker forwards the guardian's bearer and JSON body.
The Worker adds its own `X-Aule-Mobile-Origin` credential. The playground
accepts mobile requests from the local connector only and verifies this
credential before serving any route, including sign-in. The platform receives
the family's bearer and the request content type.

1. Generate 32 random bytes encoded as 64 lowercase hex characters. Set
   `MOBILE_API_ORIGIN_SECRET` in the playground-only environment file
   (`.env.mobile-origin`, or the file named by `AULE_MOBILE_ORIGIN_ENV_FILE`).
   Restrict the file to the service operator. Stage the same value as a secret
   in the playground Worker, along with the HTTPS URL in `MOBILE_API_ORIGIN`.
   Preserve the existing `ORIGIN_URL` for web routes. Keep secret values out
   of command arguments, source control and logs.
2. Configure the dedicated outbound Cloudflare Tunnel to send the hostname
   and path `^/session/api/v1(/.*)?$` to `http://127.0.0.1:8090`. Set
   `http_status:404` as the catch-all and restrict the connector credentials
   to the host. Check the connector is healthy before adding public DNS.
3. When no tutoring sessions are in progress, deploy the reviewed playground.
   Verify from the host that an anonymous GET of `/session/api/v1/me` returns
   404 without the Worker credential and the platform's JSON 401 with it.
   Check the public web resources and health endpoint after restarting.
4. Route only the dedicated hostname to the tunnel. Its mobile paths must
   return 404 without the credential, and other paths must return the tunnel's
   404. Activate the reviewed Worker and check that the public mobile API
   returns its JSON 401 for an anonymous GET of `/session/api/v1/me`. Collect
   no real family tokens during verification.

If the tunnel fails, keep the previous website origin available for its web
routes. Remove `MOBILE_API_ORIGIN` from the mobile-aware Worker to return an
uncached 503 for mobile traffic during recovery. Retain the playground's
local-peer and credential checks in any rollback.

## OTA firmware

`ota.meetaule.com` is a separate, stateless Worker with its own static assets. It
never contacts the origin server and holds no API key or platform credential.
This prepares firmware delivery, not device enrollment or the IoT voice transport.
The platform's existing `/ota/activate` and `/ota/session` remain private; the
public updater returns 404 for them and for every administrative route.

- `POST /ota/`: xiaozhi-compatible check-in, requiring JSON (at most 16 KiB).
  Only `board.type == "aule-v0.2"` can receive firmware. A numeric
  `application.version` must be older than the published version. Unknown boards
  receive time only; equal/newer versions receive no download URL. Never force
  a downgrade, including from inherited 2.6.0 firmware to Aule's 0.0.x line.
- `GET /healthz` (or `/`): reports the deployed firmware version.
- `GET`/`HEAD /firmware/aule-v0.2-X.Y.Z.ota.bin`: application bytes, immutable,
  with Content-Length for the embedded downloader. Full USB images are not served.
- No browser cookies, device identifiers, bodies or incoming URLs are forwarded
  to another service or written to application logs. The existing device report
  contains network/device metadata; Cloudflare necessarily receives it in transit.
  Only board type and version are read, and neither is persisted. Invocation logs,
  traces, preview URLs and workers.dev are off. Queries are refused.

### Publish a reviewed release

The firmware repository publishes two distinct images plus SHA256SUMS. Download
from the reviewed `aule-vX.Y.Z` release in `meet-aule/aule-fw`; check its commit and
CI before preparing the updater. The script verifies the checksum, application
header, chip, project and embedded version. It rejects the merged USB image and
refuses to overwrite an existing version with different bytes.

```sh
# From the repository root; release files stay outside Git.
gh release download aule-vX.Y.Z --repo meet-aule/aule-fw \
  --pattern '*.ota.bin' --pattern SHA256SUMS --dir /path/to/reviewed-release
python3 infra/edge/prepare_ota.py --version X.Y.Z --release-dir /path/to/reviewed-release
python3 -m unittest discover -s infra/edge -v
node --test apps/playground/test/ota-edge.test.mjs
wrangler deploy -c infra/edge/wrangler.ota.jsonc --dry-run
wrangler deploy -c infra/edge/wrangler.ota.jsonc
```

Preserve `.ota-assets/firmware/` between deployments (or repopulate it from earlier
reviewed GitHub releases): devices may already have an older immutable URL. The
manifest and assets ship in the same Worker deployment. Keep a copy of the
prepared manifest and record the Worker version ID. To stop offering a problematic
release, use `wrangler rollback <previous-worker-version-id> -c
infra/edge/wrangler.ota.jsonc`; this stops new offers but does not downgrade devices
that already installed it. A device rollback still depends on its bootloader and
on-device validation, which must be tested on hardware.

After deployment, check `/healthz`, POST a synthetic older version, download its
returned URL and compare SHA-256 and Content-Length with the release. Also check
that current/newer versions, other boards and private API paths cannot receive an
update or reach the platform. Real flashing, restart and recovery require an
Aule v0.2 board; a successful build and HTTP smoke test do not establish those.
