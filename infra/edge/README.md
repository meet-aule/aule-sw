# Edge

The two Cloudflare proxy Workers in front of the server: `playground.meetaule.com` (the session page and its API) and `livekit.meetaule.com` (LiveKit's signalling, WebSocket included; audio and video go straight to the server on its UDP and TCP ports). Each forwards to the server's address, kept as the Worker's secret `ORIGIN_URL` so it is not in this public repository. The server only accepts these ports from Cloudflare's address ranges.

None of the Workers writes a line per request to Cloudflare's logs (`"invocation_logs": false`): the browser sends its LiveKit room token in the address it connects to, and a sign-in's way back carries its code in the address too. Errors and uncaught exceptions are still logged, and traces, whose spans would carry the same addresses, stay off. `test_edge.py` checks both; the change takes effect when the Workers are deployed again.

Both proxy Workers take Google Analytics' cookies (`_ga`, and any whose name starts with `_ga_`) and `aule_consent` out of every request before it reaches the server. Google's tag on the brand site and the shop sets its cookies for all of `meetaule.com`, although the store asks for one host only, so the browser sends them to the children's app and to LiveKit too; `aule_consent`, the visitor's answer about them, will travel the same way once those two sites share it. A Cookie header with none of them goes on byte for byte. When one or more go, the other cookies go on in their order, joined again with `; ` and without empty pairs, and a request left with none goes without the header; since a Worker reads the header as UTF-8 text, a byte in it that is not UTF-8 then reaches the server as U+FFFD (Aule's own cookies are plain ASCII). Nothing else changes, WebSocket upgrades included. This keeps the cookies from the server only: Cloudflare still receives them, since its edge is where they are taken out, and in the browser any script on the page can still read them. `apps/playground/test/edge.test.mjs` runs both Workers through the cases and `test_edge.py` checks that both deploy the same function; this too takes effect when the Workers are deployed again.

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
