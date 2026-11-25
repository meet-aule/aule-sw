# Edge

The two Cloudflare proxy Workers in front of the server: `playground.meetaule.com` (the session page and its API) and `livekit.meetaule.com` (LiveKit's signalling, WebSocket included; audio and video go straight to the server on its UDP and TCP ports). Each forwards to the server's address, kept as the Worker's secret `ORIGIN_URL` so it is not in this public repository. The server only accepts these ports from Cloudflare's address ranges.

None of the Workers writes a line per request to Cloudflare's logs (`"invocation_logs": false`): the browser sends its LiveKit room token in the address it connects to, and a sign-in's way back carries its code in the address too. Errors and uncaught exceptions are still logged, and traces, whose spans would carry the same addresses, stay off. `test_edge.py` checks both; the change takes effect when the Workers are deployed again.

Both proxy Workers take the analytics cookies of the brand site and the shop out of every request before it reaches the server: Google Analytics' (`_ga`, and any whose name starts with `_ga_`), PostHog's (below) and `aule_consent`, the visitor's answer about them. All of them are kept for the whole of `meetaule.com`: Google's tag sets its cookies there although the store asks for one host only, PostHog sets its own there on purpose so that both sites count one visitor, and the store keeps one answer for both sites. So the browser sends them to the children's app and to LiveKit too. PostHog's are the cookies posthog-js names itself (read in its version 1.447.12), `<key>` being the project key: `ph_<key>_posthog`, which keeps the visitor's anonymous ID and session, and `ph_<key>_posthog_cpm` beside it; `__ph_opt_in_out_<key>`, PostHog's own consent record, if it is told to keep that in a cookie; and `__ph_cookie_support_<ID>` and `dmn_chk_<ID>`, which it sets and deletes at once to learn what the browser allows. Only those shapes go, exactly and with their case: a name that starts with `ph_` and ends in `_posthog` or `_posthog_cpm`, or that starts with one of the other three prefixes. A name that merely has `ph` in it stays. posthog-js also lets a site give these cookies names of its choosing (`persistence_name`, `consent_persistence_name`, `opt_out_capturing_cookie_prefix`), and those would get through, so the store must not use them unless this list changes with it; a newer posthog-js should be read against this list before the store moves to it. A Cookie header with none of them goes on byte for byte. When one or more go, the other cookies go on in their order, joined again with `; ` and without empty pairs, and a request left with none goes without the header; since a Worker reads the header as UTF-8 text, a byte in it that is not UTF-8 then reaches the server as U+FFFD (Aule's own cookies are plain ASCII). Nothing else changes, WebSocket upgrades included. This keeps the cookies from the server only: Cloudflare still receives them, since its edge is where they are taken out, and in the browser any script on the page can still read them. `apps/playground/test/edge.test.mjs` runs both Workers through the cases and `test_edge.py` checks that both deploy the same function; this too takes effect when the Workers are deployed again.

```sh
cd infra/edge
wrangler deploy -c wrangler.playground.jsonc
wrangler secret put ORIGIN_URL -c wrangler.playground.jsonc   # http://<server>:8090
wrangler deploy -c wrangler.livekit.jsonc
wrangler secret put ORIGIN_URL -c wrangler.livekit.jsonc      # http://<server>:7880
```

The shop and the brand site have their own Worker in the store's repository.

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
