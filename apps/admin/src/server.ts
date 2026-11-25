// The team's console at admin.meetaule.com: today's panel behind its own
// sign-in. Pages hold no data and are served to anyone who comes through the
// console's Worker; every /api call needs a console session, and the
// platform's Staff check decides each data call. No answer carries a
// Location: a page's script sends a signed-out visitor to the fixed path
// /signin, so there is no redirect to point anywhere else.

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { READS, WRITE, apiRoutes } from "./api.ts";
import { type AssetSource, cacheFor, keptUntilEdited, loadAssets, stillFresh } from "./assets.ts";
import { VERSION, stamps } from "./build.ts";
import { ConfigError, isLoopback, readSettings, type Settings } from "./config.ts";
import { SECURITY_HEADERS } from "./headers.ts";
import { clientKey, signInLimits } from "./limits.ts";
import { log, logConfigProblem, logStart } from "./log.ts";
import { type Platform, PlatformError, createPlatform } from "./platform.ts";
import { Sessions } from "./sessions.ts";
import { signInRoutes } from "./signin.ts";

const publicDir = new URL("../public/", import.meta.url);

// The two typefaces, each from its own package, upright only: the panel uses no italics.
const font = (pkg: string, file: string) =>
  join(dirname(createRequire(import.meta.url).resolve(`${pkg}/package.json`)), "files", file);

const HTML = "text/html; charset=utf-8";
const SCRIPT = "text/javascript; charset=utf-8";
const STATIC: Record<string, AssetSource> = {
  "/": { file: new URL("index.html", publicDir), type: HTML },
  "/signin": { file: new URL("signin.html", publicDir), type: HTML },
  "/admin.js": { file: new URL("admin.js", publicDir), type: SCRIPT },
  // The panel's arithmetic for the pilot's numbers, kept apart so it is tested.
  "/pilot.js": { file: new URL("pilot.js", publicDir), type: SCRIPT },
  "/signin.js": { file: new URL("signin.js", publicDir), type: SCRIPT },
  "/style.css": { file: new URL("style.css", publicDir), type: "text/css; charset=utf-8" },
  "/icon.svg": { file: new URL("icon.svg", publicDir), type: "image/svg+xml" },
  "/fonts/serif.woff2": { file: font("@fontsource-variable/source-serif-4", "source-serif-4-latin-wght-normal.woff2"), type: "font/woff2" },
  "/fonts/sans.woff2": { file: font("@fontsource-variable/inter", "inter-latin-wght-normal.woff2"), type: "font/woff2" },
};
// The pages' own scripts: their imports of each other get the fingerprinted addresses.
const OWN_SCRIPTS = new Set(["/admin.js", "/pilot.js", "/signin.js"]);

const SIGN_IN = new Set(["/api/signin/start", "/api/signin/verify", "/api/signout"]);
// A write is a small JSON object: an address and a code, or a grant's days and note.
const MAX_BODY_BYTES = 4_096;
const ROBOTS = "User-agent: *\nDisallow: /\n";

/**
 * The address a request asks for. Its target is a path, so a leading "//" is
 * part of the path, not a host. A target that is still no address, like a bad
 * port in a full one, gives nothing (as the playground's server.ts).
 */
function addressOf(target: string): URL | undefined {
  try {
    return new URL(target.startsWith("/") ? `http://console${target}` : target, "http://console");
  } catch {
    return undefined;
  }
}

const digest = (text: string) => createHash("sha256").update(text).digest();

/**
 * Whether a request came through the console's Worker: it carries the secret
 * the Worker adds, compared in constant time. Cloudflare's addresses, which
 * the origin firewall lets in, are every Worker of every account, so the
 * secret is what says it was ours. With no secret set (local work, on
 * loopback only) every request counts as one.
 */
function fromEdge(request: IncomingMessage, secret: string | null): boolean {
  if (secret === null) return true;
  const given = request.headers["x-edge-secret"];
  return typeof given === "string" && timingSafeEqual(digest(given), digest(secret));
}

/**
 * Who a request comes from, for the sign-in's limits: the address the Worker
 * read from Cloudflare (X-Client-IP), which only a request with the secret
 * can carry, or else, with no secret set, the address the request came from.
 */
function clientOf(request: IncomingMessage, secret: string | null): string {
  if (secret === null) return clientKey(request.socket.remoteAddress);
  const forwarded = request.headers["x-client-ip"];
  return clientKey(typeof forwarded === "string" ? forwarded : undefined);
}

/** What is answered without the Worker's secret: the health probe from this machine, the container's check and the watch's. */
export const answersWithoutEdge = (path: string, address: string | undefined) =>
  path === "/healthz" && isLoopback((address ?? "").replace(/^::ffff:/, ""));

async function readJson(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  if (Number(request.headers["content-length"] ?? 0) > limit) throw new Error("body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("not an object");
  return body as Record<string, unknown>;
}

export type Options = {
  /** The clock for sessions and limits: tests move it on. */
  now?: () => number;
  /** How long a code check takes at least, in milliseconds, from when its body was read. */
  verifyFloorMs?: number;
  /** How many keys each sign-in limit counts at once. */
  limitKeys?: number;
  /** How long a platform call may take, in milliseconds. */
  platformTimeoutMs?: number;
  /** The platform, when a test stands in for it whole. */
  platform?: Platform;
};

export type TeamConsole = Server & {
  /** Ends every session and its platform session, as the process stops. */
  revokeAll(): Promise<void>;
  sessions: Sessions;
};

export function createConsole(settings: Settings, options: Options = {}): TeamConsole {
  const now = options.now ?? Date.now;
  const platform = options.platform ?? createPlatform(settings.platformUrl, settings.commit, options.platformTimeoutMs);

  async function revoke(token: string): Promise<void> {
    try {
      await platform.signOut(token);
    } catch (error) {
      // A 401: the platform already ended it, and there is nothing left to end.
      if (error instanceof PlatformError && error.status === 401) return;
      log("revoke_failed", { status: error instanceof PlatformError ? error.status : 0 });
    }
  }

  const sessions = new Sessions(revoke, now);
  // Read on the first request and kept until a file in public/ changes. The
  // pages say which build they come from.
  const assets = keptUntilEdited(publicDir, () => loadAssets(STATIC, OWN_SCRIPTS, stamps(settings.commit)));

  const reply = (response: ServerResponse, status: number, body: unknown, cookies?: string[]) => {
    response.writeHead(status, {
      ...SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      ...(cookies ? { "Set-Cookie": cookies } : {}),
    });
    response.end(JSON.stringify(body));
  };
  const signIn = signInRoutes({
    team: settings.team,
    platform,
    sessions,
    limits: signInLimits(now, options.limitKeys),
    floorMs: options.verifyFloorMs ?? 500,
    reply,
  });
  const api = apiRoutes({ platform, sessions, commit: settings.commit, reply });

  const notAllowed = (response: ServerResponse, allow: string) => {
    response.setHeader("Allow", allow);
    reply(response, 405, { error: "method_not_allowed" });
  };

  /**
   * The rules every write follows, before anything else is read: it comes from
   * the console's own pages, and it is a small JSON object. Null when the
   * request was refused (and answered).
   */
  async function writeBody(request: IncomingMessage, response: ServerResponse): Promise<Record<string, unknown> | null> {
    const site = request.headers["sec-fetch-site"];
    if (request.headers.origin !== settings.publicUrl || (site !== undefined && site !== "same-origin")) {
      reply(response, 403, { error: "wrong_origin" });
      return null;
    }
    if ((request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() !== "application/json") {
      reply(response, 415, { error: "unsupported_media_type" });
      return null;
    }
    try {
      return await readJson(request, MAX_BODY_BYTES);
    } catch {
      reply(response, 400, { error: "bad_request" });
      return null;
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse, url: URL, path: string) {
    const method = request.method ?? "GET";
    const reading = method === "GET" || method === "HEAD";

    // Watchers read only the status; a person can read which build answers.
    if (path === "/healthz") {
      if (!reading) return notAllowed(response, "GET, HEAD");
      return reply(response, 200, { ok: true, version: VERSION, commit: settings.commit });
    }
    if (path === "/robots.txt") {
      if (!reading) return notAllowed(response, "GET, HEAD");
      response.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
      return response.end(ROBOTS);
    }

    if (SIGN_IN.has(path)) {
      if (method !== "POST") return notAllowed(response, "POST");
      const body = await writeBody(request, response);
      if (!body) return;
      const client = clientOf(request, settings.edgeSecret);
      if (path === "/api/signin/start") return signIn.start(response, body, client);
      if (path === "/api/signin/verify") return signIn.verify(request, response, body, client);
      return signIn.signOut(request, response);
    }
    if (READS.has(path)) {
      if (method !== "GET") return notAllowed(response, "GET");
      const token = sessions.tokenFor(request);
      if (!token) return reply(response, 401, { error: "signed_out" });
      return api.read(path, request, response, token);
    }
    const write = WRITE.exec(path);
    if (write) {
      if (method !== "POST") return notAllowed(response, "POST");
      const body = await writeBody(request, response);
      if (!body) return;
      const token = sessions.tokenFor(request);
      if (!token) return reply(response, 401, { error: "signed_out" });
      return api.write(write[1]!, write[2]!, request, response, token, body);
    }

    const asset = (await assets.get()).get(path);
    if (!asset) return reply(response, 404, { error: "not_found" });
    if (!reading) return notAllowed(response, "GET, HEAD");
    // A fingerprinted address is kept for a year and any other file is checked
    // against its ETag on every load. A page is never kept.
    const cache = cacheFor(asset, url.searchParams.get("v"));
    const etag = cache === "no-store" ? undefined : `"${asset.hash}"`;
    const sent = { ...SECURITY_HEADERS, "Cache-Control": cache, ...(etag ? { ETag: etag } : {}) };
    if (etag && stillFresh(request.headers["if-none-match"], etag)) {
      response.writeHead(304, sent);
      return response.end();
    }
    response.writeHead(200, { ...sent, "Content-Type": asset.type });
    return response.end(asset.body);
  }

  const server = createServer((request, response) => {
    const url = addressOf(request.url ?? "/");
    // Refused, never thrown: out here a throw would end the process.
    if (!url) return reply(response, 400, { error: "bad_request" });
    // Doubled slashes are folded, so a probe of "//healthz" is the probe.
    const path = url.pathname.replace(/\/{2,}/g, "/");
    // Only what the Worker forwards is answered, and the health probe of this
    // machine (the container's check and the watch). To anyone else, every
    // address is the same 404.
    if (!answersWithoutEdge(path, request.socket.remoteAddress) && !fromEdge(request, settings.edgeSecret)) {
      return reply(response, 404, { error: "not_found" });
    }
    handle(request, response, url, path).catch((error: unknown) => {
      // The platform's words stay here: the browser is told only that it failed.
      if (error instanceof PlatformError) log("platform_error", { status: error.status });
      else log("request_failed");
      if (response.headersSent) return response.end();
      reply(response, error instanceof PlatformError ? 502 : 500, { error: error instanceof PlatformError ? "platform" : "internal" });
    });
  });

  // Sessions that are over end within a minute, and their platform sessions with them.
  const sweeper = setInterval(() => sessions.sweep(), 60_000);
  sweeper.unref();
  server.on("close", () => {
    clearInterval(sweeper);
    assets.close();
  });
  return Object.assign(server, { revokeAll: () => sessions.revokeAll(), sessions });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let settings: Settings;
  try {
    settings = readSettings(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      logConfigProblem(error);
      process.exit(1);
    }
    throw error;
  }
  const server = createConsole(settings);
  server.listen(settings.port, settings.host, () => logStart(VERSION, settings.commit, settings.host, settings.port));
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      server.close();
      // Every platform session the console holds ends with it, together, within 5 s.
      void Promise.race([server.revokeAll(), delay(5_000)]).finally(() => process.exit(0));
    });
  }
}
