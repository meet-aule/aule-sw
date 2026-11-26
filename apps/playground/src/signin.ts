// Signing in to the playground with Google. The platform decides who the person
// is; this server only carries their session in a cookie the page cannot read.

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";

const COOKIE = "aule_guardian";
// A platform session token: 32 random bytes in hex.
const TOKEN = /^[0-9a-f]{64}$/;

/** Whether `value` has the shape of a platform session token. */
export const isSessionToken = (value: string) => TOKEN.test(value);

/** The signed-in guardian's platform token, or null when nobody is signed in. */
export function guardianToken(request: IncomingMessage): string | null {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === COOKIE && value && isSessionToken(value)) return value;
  }
  return null;
}

/** The cookie that keeps someone signed in, readable only by this server. */
export function signedInCookie(token: string, basePath: string, days: number): string {
  const seconds = Math.max(1, Math.floor(days * 24 * 60 * 60));
  return `${COOKIE}=${token}; Max-Age=${seconds}; Path=${basePath}/; HttpOnly; Secure; SameSite=Strict`;
}

export function signedOutCookie(basePath: string): string {
  return `${COOKIE}=; Max-Age=0; Path=${basePath}/; HttpOnly; Secure; SameSite=Strict`;
}

// The link a family came from: a page opened as ?src=cesar keeps "cesar" here
// until someone signs in, and the platform writes it on the family it creates.
const SOURCE_COOKIE = "aule_source";
// A family may sign up days after it first opens the link.
const SOURCE_DAYS = 30;
// The platform's rule (signin::source_code): lower-case letters, digits and
// hyphens, starting with a letter, 24 at most.
const SOURCE = /^[a-z][a-z0-9-]{0,23}$/;

/** The link's code when it is a short lower-case one; anything else is ignored. */
export function sourceCode(value: string | null | undefined): string | null {
  return typeof value === "string" && SOURCE.test(value) ? value : null;
}

/** The link a signing-in family came from, or null. */
export function sourceOf(request: IncomingMessage): string | null {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === SOURCE_COOKIE) return sourceCode(value);
  }
  return null;
}

// Apple answers with a form posted from its own site, so this cookie travels
// on cross-site requests too, as the sign-in state does (providers.ts). It
// holds nothing but the link's code, and nothing is decided by it.
export function sourceCookie(source: string, basePath: string): string {
  return `${SOURCE_COOKIE}=${source}; Max-Age=${SOURCE_DAYS * 24 * 60 * 60}; Path=${basePath}/; HttpOnly; Secure; SameSite=None`;
}

export function clearedSourceCookie(basePath: string): string {
  return `${SOURCE_COOKIE}=; Max-Age=0; Path=${basePath}/; HttpOnly; Secure; SameSite=None`;
}

/**
 * How many sessions one sign-in may start in a day. The page is open to anyone
 * with a Google account and every session costs speech and model time, so this
 * bounds what one account can spend. It is kept in memory: a restart forgets it.
 */
export class DailyLimit {
  readonly #perDay: number;
  readonly #now: () => number;
  // `returned`: how many of the day's sessions were given back (giveBack).
  readonly #used = new Map<string, { day: number; count: number; returned: number }>();

  constructor(perDay: number, now: () => number = Date.now) {
    this.#perDay = perDay;
    this.#now = now;
  }

  #today(): number {
    return Math.floor(this.#now() / 86_400_000);
  }

  // The token itself is never kept, only what tells two sign-ins apart.
  #key(token: string): string {
    return createHash("sha256").update(token).digest("base64url");
  }

  /** Counts one session for this sign-in. False when the day's sessions are used up. */
  take(token: string): boolean {
    const day = this.#today();
    const key = this.#key(token);
    const entry = this.#used.get(key);
    if (!entry || entry.day !== day) {
      for (const [other, value] of this.#used) if (value.day !== day) this.#used.delete(other);
      this.#used.set(key, { day, count: 1, returned: 0 });
      return this.#perDay >= 1;
    }
    if (entry.count >= this.#perDay) return false;
    entry.count += 1;
    return true;
  }

  /**
   * Gives back one of today's sessions of this sign-in: one its tutor never
   * started, which cost no speech or model time. At most as many a day as the
   * day allows, so starting and closing sessions at once cannot go on forever.
   */
  giveBack(token: string): void {
    const entry = this.#used.get(this.#key(token));
    if (!entry || entry.day !== this.#today() || entry.count === 0 || entry.returned >= this.#perDay) return;
    entry.count -= 1;
    entry.returned += 1;
  }
}
