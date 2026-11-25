// The console's own sessions, kept in memory. The browser holds an opaque id
// in a cookie; the platform token it stands for stays in this process and is
// never sent to the browser, logged or written anywhere. So a token minted on
// the playground cannot be pasted into the console, and the console's length
// and limits hold. A restart signs the team out.
//
// The platform's session underneath lasts 12 hours too, not a family's 30
// days: the platform's team sign-in opens it so. The console also ends it
// whenever its own session ends: on sign-out, expiry, eviction and SIGTERM.

import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { log } from "./log.ts";

export const COOKIE = "__Host-aule_admin";
/** 12 hours from sign-in, the cookie's Max-Age. */
export const LIFETIME_MS = 12 * 60 * 60 * 1000;
/** 2 hours without a request. */
export const IDLE_MS = 2 * 60 * 60 * 1000;
/** At most this many at once; the next one ends the oldest. */
export const MAX_SESSIONS = 20;

// 32 random bytes in base64url. Anything else in the cookie is ignored.
const ID = /^[A-Za-z0-9_-]{43}$/;

/** The cookie a new session sets. With the __Host- prefix the browser requires Secure, Path=/ and no Domain. */
export const sessionCookie = (id: string) =>
  `${COOKIE}=${id}; Path=/; Max-Age=${LIFETIME_MS / 1000}; HttpOnly; Secure; SameSite=Strict`;
export const clearedCookie = `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

/** The session id a request's cookie carries, when it is one the console could have made. */
export function sessionId(request: IncomingMessage): string | null {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at === -1 || part.slice(0, at).trim() !== COOKIE) continue;
    const value = part.slice(at + 1).trim();
    if (ID.test(value)) return value;
  }
  return null;
}

// The map is keyed by the id's hash, so not even the id is kept as it is.
const keyOf = (id: string) => createHash("sha256").update(id).digest("hex");

type Held = { token: string; createdAt: number; seenAt: number };
type Why = "expired" | "evicted" | "refused" | "signed_out" | "stopping";

export class Sessions {
  readonly #held = new Map<string, Held>();
  readonly #pending = new Set<Promise<void>>();
  readonly #revoke: (token: string) => Promise<void>;
  readonly #now: () => number;

  /** `revoke` ends a platform session; it is called whenever a console session ends. */
  constructor(revoke: (token: string) => Promise<void>, now: () => number = Date.now) {
    this.#revoke = revoke;
    this.#now = now;
  }

  get size(): number {
    return this.#held.size;
  }

  /** A new session for a platform token. Its id goes into the cookie and nowhere else. */
  open(token: string): string {
    // A Map keeps the order sessions were made in: the first is the oldest.
    for (const [key] of this.#held) {
      if (this.#held.size < MAX_SESSIONS) break;
      this.#end(key, "evicted");
    }
    const id = randomBytes(32).toString("base64url");
    const now = this.#now();
    this.#held.set(keyOf(id), { token, createdAt: now, seenAt: now });
    return id;
  }

  /** The platform token behind a request's cookie while its session lasts; each use counts as activity. */
  tokenFor(request: IncomingMessage): string | null {
    const id = sessionId(request);
    if (!id) return null;
    const key = keyOf(id);
    const held = this.#held.get(key);
    if (!held) return null;
    if (this.#over(held)) {
      this.#end(key, "expired");
      return null;
    }
    held.seenAt = this.#now();
    return held.token;
  }

  /**
   * Ends the session behind a request's cookie, if it has one. `revoke` is
   * false only when the platform already refused the token (a 401): there is
   * nothing left there to end. The returned promise settles once the platform
   * has been asked.
   */
  end(request: IncomingMessage, why: "signed_out" | "refused", revoke = true): Promise<void> {
    const id = sessionId(request);
    const key = id ? keyOf(id) : null;
    if (!key || !this.#held.has(key)) return Promise.resolve();
    return this.#end(key, why, revoke);
  }

  /** Ends the sessions that are over: run every minute. */
  sweep(): void {
    for (const [key, held] of this.#held) if (this.#over(held)) this.#end(key, "expired");
  }

  /** Ends every session and its platform session, as the process stops. */
  async revokeAll(): Promise<void> {
    for (const [key] of this.#held) this.#end(key, "stopping");
    await this.settled();
  }

  /** Settles once every revocation asked for so far has had its answer. */
  async settled(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }

  #over(held: Held): boolean {
    const now = this.#now();
    return now - held.createdAt >= LIFETIME_MS || now - held.seenAt >= IDLE_MS;
  }

  #end(key: string, why: Why, revoke = true): Promise<void> {
    const held = this.#held.get(key);
    this.#held.delete(key);
    if (why !== "signed_out") log("session_ended", { [why]: true });
    if (!held || !revoke) return Promise.resolve();
    // Nobody waits for most of these: a failure is the revoker's to log, and
    // must never surface as an unhandled rejection that stops the process.
    const asked = this.#revoke(held.token)
      .catch(() => undefined)
      .finally(() => this.#pending.delete(asked));
    this.#pending.add(asked);
    return asked;
  }
}
