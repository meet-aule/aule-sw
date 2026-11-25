// Stands in for the platform: its sign-in, its sessions and the team's routes,
// answering as apps/platform does, and recording every request it hears.

import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { readSettings, type Settings } from "../src/config.ts";
import { type Options, type TeamConsole, createConsole } from "../src/server.ts";

/** A team address with a guardian account. */
export const TEAM = "team@example.org";
/** A team address nobody has signed up with yet: the platform sends it no code. */
export const NO_ACCOUNT = "new@example.org";
/** Anyone else. */
export const STRANGER = "someone@example.org";
export const CODE = "123456";
export const WRONG_CODE = "654321";
export const FAMILY = "01a1f5f4-ede7-7028-a524-9d8e2f36b92d";
/** Where the console says it is: the one Origin a write may carry. */
export const PUBLIC_URL = "https://admin.example.org";
/** What the console's Worker adds to every request, when a test sets it. */
export const EDGE_SECRET = "an-edge-secret-of-the-tests-0123456789abcdef";
export const COMMIT = "0123456789ab";

/** A ceremony's handle, as the platform makes them. */
export const CEREMONY = "0123456789abcdef".repeat(4);
/** The cookie a ceremony travels in, and the one that clears it. */
export const CEREMONY_COOKIE = `__Host-aule_admin_passkey=${CEREMONY}; Path=/; Max-Age=300; HttpOnly; Secure; SameSite=Strict`;
export const CLEARED_CEREMONY = "__Host-aule_admin_passkey=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict";
/** What the browser is asked to create, as the platform sends it. */
export const CREATE_OPTIONS = { challenge: "Zm9vYmFy", rp: { id: "admin.example.org", name: "Aule" }, user: { id: "dXNlcg", name: TEAM, displayName: TEAM } };
/** A passkey the browser made, as its toJSON() writes it, with what the console must leave behind. */
export const CREATED = {
  id: "AQIDBA",
  rawId: "AQIDBA",
  type: "public-key",
  authenticatorAttachment: "platform",
  response: {
    clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0",
    attestationObject: "o2NmbXRkbm9uZQ",
    authenticatorData: "SZYN5YgO",
    transports: ["internal", "hybrid", "satellite", "internal"],
    publicKey: "MFkwEwYH",
    publicKeyAlgorithm: -7,
  },
  clientExtensionResults: { credProps: { rk: true }, other: { x: 1 } },
};
/** What the console sends on of it: only the fields the platform reads. */
export const CREATED_SENT = {
  id: "AQIDBA",
  rawId: "AQIDBA",
  type: "public-key",
  response: { clientDataJSON: CREATED.response.clientDataJSON, attestationObject: CREATED.response.attestationObject, transports: ["internal", "hybrid"] },
  clientExtensionResults: { credProps: { rk: true } },
};
export const PASSKEY_ID = "01a1f5f4-ede7-7028-a524-9d8e2f36b9f0";
/** A passkey as the platform lists it. */
export const PASSKEY = { id: PASSKEY_ID, label: "MacBook de Ana", created_at: "2026-11-25T15:00:00Z", last_used_at: null };

/** Two sessions open: Mateo's on the web with the engine, and a test of the team's. */
export const OPEN_SESSIONS = {
  open: 2,
  starting: 0,
  overdue: 0,
  overdue_after_minutes: 70,
  more: false,
  sessions: [
    { family_id: FAMILY, family: "Quispe", child: "Mateo", audience: "child", status: "active", created_at: "2026-11-25T15:30:00Z", started_at: "2026-11-25T15:30:20Z", engine: true, via: "web", overdue: false },
    { family_id: null, family: null, child: null, audience: "operator", status: "active", created_at: "2026-11-25T15:20:00Z", started_at: "2026-11-25T15:20:20Z", engine: false, via: "web", overdue: false },
  ],
};

export type Heard = { method: string; path: string; headers: IncomingHttpHeaders; body: unknown };
type Answer = { status: number; body?: unknown; waitMs?: number };

const error = (status: number, code: string, message: string): Answer => ({ status, body: { error: { code, message } } });

export class FakePlatform {
  readonly heard: Heard[] = [];
  /** The platform sessions alive, as their tokens. */
  readonly tokens = new Set<string>();
  /** Whether the platform counts the team's address as the team: its code check and its Staff check. */
  teamAtPlatform = true;
  /** How long /v1/auth/team/start takes to answer. */
  startWaitMs = 0;
  health: Answer = { status: 200, body: { ok: true, version: "0.0.7", commit: "fedcba987654" } };
  /** Who is in a session now, as GET /v1/admin/sessions/open says it. */
  openSessions: unknown = OPEN_SESSIONS;
  /** The team member's passkeys, as GET /v1/admin/passkeys lists them. */
  passkeys: unknown[] = [];
  /** Whether the sign-in is too old for the platform to add a passkey (409). */
  staleSignIn = false;
  // Tokens the platform's Staff check refuses (403) although they are alive.
  readonly #notStaff = new Set<string>();
  // Answers given once, before any rule: "METHOD /path" → answer.
  readonly #once = new Map<string, Answer>();
  readonly #server: Server;
  url = "";

  constructor() {
    this.#server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const text = Buffer.concat(chunks).toString("utf8");
      const method = request.method ?? "";
      const path = request.url ?? "";
      const body: unknown = text ? JSON.parse(text) : null;
      this.heard.push({ method, path, headers: request.headers, body });
      const answer = await this.#answer(method, path, request.headers.authorization, body as Record<string, unknown>);
      if (answer.waitMs) await delay(answer.waitMs);
      if (answer.body === undefined) {
        response.writeHead(answer.status);
        return response.end();
      }
      response.writeHead(answer.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(answer.body));
    });
  }

  async listen(): Promise<this> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    return this;
  }

  close(): void {
    this.#server.closeAllConnections();
    this.#server.close();
  }

  /** The next request to `route` ("GET /v1/admin/families") gets this answer, whatever it is. */
  once(route: string, answer: Answer): void {
    this.#once.set(route, answer);
  }

  /** From now on the Staff check refuses this token, as for someone taken off the team. */
  refuseStaff(token: string): void {
    this.#notStaff.add(token);
  }

  /** The requests heard to one path. */
  to(path: string): Heard[] {
    return this.heard.filter((heard) => heard.path === path);
  }

  /** The platform tokens the console signed out, in order. */
  signedOut(): string[] {
    return this.to("/v1/auth/signout").map((heard) => (heard.headers.authorization ?? "").replace(/^Bearer /, ""));
  }

  async #answer(method: string, path: string, authorization: string | undefined, body: Record<string, unknown> | null): Promise<Answer> {
    const fixed = this.#once.get(`${method} ${path}`);
    if (fixed) {
      this.#once.delete(`${method} ${path}`);
      return fixed;
    }
    if (method === "GET" && path === "/healthz") return this.health;
    if (method === "POST" && path === "/v1/auth/team/start") return { status: 204, waitMs: this.startWaitMs };
    if (method === "POST" && path === "/v1/auth/team/verify") {
      // A code goes only to a team address with an account, so anything else is a wrong code.
      if (body?.code !== CODE || body.email !== TEAM || !this.teamAtPlatform) {
        return error(403, "forbidden", "that code is wrong or has expired");
      }
      const token = randomBytes(32).toString("hex");
      this.tokens.add(token);
      return { status: 200, body: { token, expires_in_hours: 12 } };
    }
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!this.tokens.has(token)) return error(401, "unauthorized", "missing or wrong credentials");
    if (method === "POST" && path === "/v1/auth/signout") {
      this.tokens.delete(token);
      return { status: 204 };
    }
    if (!path.startsWith("/v1/admin/") && !path.startsWith("/v1/metrics/")) return error(404, "not_found", "route not found");
    if (!this.teamAtPlatform || this.#notStaff.has(token)) return error(403, "forbidden", "this route is for Aule's team");
    // The families list answers the same whatever it is asked: the tests look at what it heard.
    if (method === "GET" && /^\/v1\/admin\/families(\?.*)?$/.test(path)) return { status: 200, body: { families: [{ id: FAMILY, name: "Quispe" }] } };
    const family = /^\/v1\/admin\/families\/([^/?]+)(?:\/(sessions|notices))?(\?.*)?$/.exec(path);
    if (method === "GET" && family) {
      if (family[1] !== FAMILY) return error(404, "not_found", "family not found");
      if (family[2]) return { status: 200, body: { [family[2]]: [], next: null } };
      return { status: 200, body: { id: FAMILY, name: "Quispe", guardians: [], children: [] } };
    }
    if (method === "GET" && path === "/v1/admin/sessions/open") return { status: 200, body: this.openSessions };
    if (method === "GET" && path === "/v1/metrics/daily?days=14") return { status: 200, body: { days: [] } };
    if (method === "GET" && path === "/v1/metrics/weekly?weeks=12") {
      return { status: 200, body: { timezone_offset_minutes: -300, weeks: 12, cohorts: [{ week: "2026-11-23", source: "cesar", families: 2 }] } };
    }
    if (path === `/v1/admin/families/${FAMILY}/grant`) {
      if (method === "POST") return { status: 201, body: { plan: "granted" } };
      if (method === "DELETE") return { status: 200, body: { plan: "trial" } };
    }
    if (/^\/v1\/admin\/families\/[^/]+\/grant$/.test(path)) return error(404, "not_found", "family not found");
    // The member's own passkeys: a ceremony is the one this platform handed out.
    if (method === "POST" && path === "/v1/admin/passkeys/options") {
      if (this.staleSignIn) return error(409, "conflict", "sign in again to add a passkey");
      return { status: 200, body: { ceremony: CEREMONY, options: { publicKey: CREATE_OPTIONS } } };
    }
    if (method === "POST" && path === "/v1/admin/passkeys") {
      if (body?.ceremony !== CEREMONY) return error(400, "bad_request", "that passkey request is unknown or has expired");
      return { status: 201, body: { ...PASSKEY, label: body.label } };
    }
    if (method === "GET" && path === "/v1/admin/passkeys") return { status: 200, body: { passkeys: this.passkeys } };
    const passkey = /^\/v1\/admin\/passkeys\/([^/]+)$/.exec(path);
    if (method === "DELETE" && passkey) return passkey[1] === PASSKEY_ID ? { status: 204 } : error(404, "not_found", "passkey not found");
    return error(404, "not_found", "route not found");
  }
}

/** A clock the tests move on by hand. */
export function clock(start = Date.UTC(2026, 10, 25, 15)) {
  let now = start;
  return { now: () => now, pass: (ms: number) => void (now += ms) };
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export function settingsFor(platform: FakePlatform, more: Record<string, string> = {}): Settings {
  return readSettings({
    AULE_PLATFORM_URL: platform.url,
    AULE_ADMIN_EMAILS: ` ${TEAM.toUpperCase()} , ${NO_ACCOUNT}`,
    ADMIN_PUBLIC_URL: PUBLIC_URL,
    AULE_COMMIT: COMMIT,
    ...more,
  });
}

/** A console on a free port, answering for `platform`. Code checks have no floor unless one is given. */
export async function startConsole(platform: FakePlatform, options: Options = {}, more: Record<string, string> = {}) {
  const server: TeamConsole = createConsole(settingsFor(platform, more), { verifyFloorMs: 0, ...options });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => {
    server.closeAllConnections();
    server.close();
  };
  return { server, base, close };
}

export type WriteOptions = {
  origin?: string | null;
  cookie?: string;
  type?: string;
  site?: string;
  raw?: string;
  /** More headers, such as what the console's Worker adds. */
  headers?: Record<string, string>;
};

/** The headers the console's Worker adds to a request from `client`. */
export const fromWorker = (client: string, secret = EDGE_SECRET) => ({ "X-Edge-Secret": secret, "X-Client-IP": client });

/** A write as the console's own pages make it, less whatever a test takes away. */
export function write(base: string, path: string, body: unknown = {}, options: WriteOptions = {}): Promise<Response> {
  const origin = options.origin === undefined ? PUBLIC_URL : options.origin;
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": options.type ?? "application/json",
      ...(origin === null ? {} : { Origin: origin }),
      ...(options.site ? { "Sec-Fetch-Site": options.site } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...options.headers,
    },
    body: options.raw ?? JSON.stringify(body),
  });
}

/** The cookie a browser would send back, from a Set-Cookie header. */
export const cookieFrom = (response: Response) => (response.headers.getSetCookie()[0] ?? "").split(";")[0]!;

/** Signs in through the console as the team, and returns the cookie to send. */
export async function signIn(base: string, email = TEAM, headers?: Record<string, string>): Promise<string> {
  const started = await write(base, "/api/signin/start", { email }, { headers });
  await started.arrayBuffer();
  const verified = await write(base, "/api/signin/verify", { email, code: CODE }, { headers });
  await verified.arrayBuffer();
  if (verified.status !== 200) throw new Error(`sign-in answered ${verified.status}`);
  return cookieFrom(verified);
}

/** Waits until `check` holds, for at most two seconds. */
export async function until(check: () => boolean, what = "the condition"): Promise<void> {
  for (let waited = 0; !check(); waited += 10) {
    if (waited > 2_000) throw new Error(`timed out waiting for ${what}`);
    await delay(10);
  }
}

/** Every line the console logs while `run` runs, as it printed them; `run` may watch them come. */
export async function logged(run: (lines: readonly string[]) => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  for (const name of ["log", "error", "warn"] as const) {
    console[name] = (...parts: unknown[]) => void lines.push(parts.map(String).join(" "));
  }
  try {
    await run(lines);
  } finally {
    Object.assign(console, original);
  }
  return lines;
}
