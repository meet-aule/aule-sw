// Public firmware only. No platform credential, family/session API, or request logging.
const MODEL = "aule-v0.2";
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const IMAGE = /^\/firmware\/aule-v0\.2-(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.ota\.bin$/;
const MAX_BODY = 16_384;

function json(status, body) {
  return Response.json(body, { status, headers: {
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Strict-Transport-Security": "max-age=31536000", "X-Robots-Tag": "noindex",
  } });
}

function version(value) {
  if (typeof value !== "string" || value.length > 32 || !VERSION.test(value)) return null;
  const parts = value.split(".").map(Number);
  return parts.every((part) => Number.isSafeInteger(part) && part <= 2147483647) ? parts : null;
}

function newer(candidate, current) {
  for (let i = 0; i < 3; i++) {
    if (candidate[i] !== current[i]) return candidate[i] > current[i];
  }
  return false;
}

async function bodyOf(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("empty");
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); throw new RangeError("too large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function manifestOf(env) {
  const response = await env.ASSETS.fetch(new Request("https://assets.invalid/manifest.json"));
  if (response.status !== 200) throw new Error("unavailable");
  const m = await response.json();
  if (m.model !== MODEL || !version(m.version) || m.path !== `/firmware/${MODEL}-${m.version}.ota.bin`
      || !/^[a-f0-9]{64}$/.test(m.sha256) || !Number.isSafeInteger(m.size) || m.size < 288) {
    throw new Error("invalid manifest");
  }
  return m;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol !== "https:") return json(426, { error: "https_required" });
    if (url.search) return json(400, { error: "query_not_supported" });
    const path = url.pathname;
    if (IMAGE.test(path)) {
      if (!["GET", "HEAD"].includes(request.method)) return json(405, { error: "method_not_allowed" });
      try {
        // Construct a fresh request: no cookies, identifiers, authorization or user URL is forwarded.
        const asset = await env.ASSETS.fetch(new Request(`https://assets.invalid${path}`, { method: request.method }));
        if (asset.status !== 200) return json(404, { error: "not_found" });
        const headers = new Headers(asset.headers);
        headers.set("Content-Type", "application/octet-stream");
        headers.set("Cache-Control", "public, max-age=31536000, immutable, no-transform");
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("Strict-Transport-Security", "max-age=31536000");
        return new Response(asset.body, { status: 200, headers });
      } catch { return json(503, { error: "firmware_unavailable" }); }
    }
    if (!["/", "/healthz", "/ota/"].includes(path)) return json(404, { error: "not_found" });
    const checkIn = path === "/ota/";
    if (request.method !== (checkIn ? "POST" : "GET")) return json(405, { error: "method_not_allowed" });
    let body;
    if (checkIn) {
      if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") {
        return json(415, { error: "json_required" });
      }
      if (Number(request.headers.get("content-length")) > MAX_BODY) return json(413, { error: "body_too_large" });
      try { body = await bodyOf(request); }
      catch (error) { return json(error instanceof RangeError ? 413 : 400, { error: "bad_request" }); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { error: "bad_request" });
    }
    let manifest;
    try { manifest = await manifestOf(env); }
    catch { return json(503, { error: "firmware_unavailable" }); }
    if (!checkIn) return json(200, { ok: true, service: "aule-ota", model: MODEL, version: manifest.version });
    // Keep UTC: session signatures use Unix timestamps. Do not shift the device clock to local time.
    const answer = { server_time: { timestamp: Date.now(), timezone_offset: 0 } };
    if (body.board?.type !== MODEL) return json(200, answer);
    const current = version(body.application?.version);
    if (!current) return json(400, { error: "invalid_version" });
    answer.firmware = newer(version(manifest.version), current)
      ? { version: manifest.version, url: new URL(manifest.path, url).href, sha256: manifest.sha256 }
      : { version: body.application.version, url: "" };
    return json(200, answer);
  },
};
