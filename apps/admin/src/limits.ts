// How often anyone may ask for a code or try one, counted in memory in sliding
// windows: a restart clears them. Each limit counts per client, the address
// the console's Worker read from Cloudflare (server.ts), and per address and
// client, so one client's requests never hold back another's: a stranger
// cannot lock the team out. Every counter applies to every address, the team's
// or not, so reaching a limit tells nothing about an address. With the
// platform's own limits (five console codes an hour per address, five tries a
// code), a client gets at most 10 wrong codes a day for an address. A passkey
// sign-in carries no address, so only the counters per client apply to it.

import { createHash } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The key an address is counted under: its hash, never the address itself. */
export const addressKey = (email: string) => createHash("sha256").update(email).digest("hex");

/** The key an address and a client are counted under together. */
export const pairKey = (email: string, client: string) => `${client} ${addressKey(email)}`;

/**
 * Who a request comes from, as the limits count it: an IPv4 address as it is,
 * an IPv6 address by its /64, which one subscriber usually holds whole, and
 * anything else as one shared "unknown".
 */
export function clientKey(address: string | undefined): string {
  const text = (address ?? "").trim().replace(/%.*$/, "").toLowerCase();
  if (isIPv4(text)) return text;
  if (!isIPv6(text)) return "unknown";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (mapped && isIPv4(mapped[1]!)) return mapped[1]!;
  // Written out in full: "::" stands for as many zero groups as are missing,
  // and a dotted IPv4 tail for two groups.
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const width = (parts: string[]) => parts.reduce((sum, part) => sum + (part.includes(".") ? 2 : 1), 0);
  const [left, right] = text.includes("::") ? text.split("::").map(groups) : [groups(text), []];
  const full = [...left!, ...Array<string>(8 - width(left!) - width(right!)).fill("0"), ...right!];
  return `${full
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

export class Counter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #now: () => number;
  // Each key's requests in the window, oldest first. The map's order is the
  // order the keys were last counted in, so the first is the one heard from
  // longest ago.
  readonly #hits = new Map<string, number[]>();

  constructor(max: number, windowMs: number, now: () => number = Date.now, maxKeys = 10_000) {
    this.#max = max;
    this.#windowMs = windowMs;
    this.#now = now;
    this.#maxKeys = maxKeys;
  }

  /** Whether `key` is under its limit. */
  allows(key: string): boolean {
    const hits = this.#recent(key);
    return !hits || hits.length < this.#max;
  }

  /**
   * Counts one request for `key`. With every key's room taken by requests
   * still in their window, the key heard from longest ago is forgotten: a
   * full counter never refuses everyone new, which would lock the team out.
   */
  add(key: string): void {
    const hits = this.#recent(key) ?? [];
    hits.push(this.#now());
    this.#hits.delete(key);
    if (this.#hits.size >= this.#maxKeys) this.#prune();
    if (this.#hits.size >= this.#maxKeys) this.#hits.delete(this.#hits.keys().next().value!);
    // More than the limit tells nothing more; the newest are the ones that count longest.
    this.#hits.set(key, hits.slice(-this.#max));
  }

  clear(key: string): void {
    this.#hits.delete(key);
  }

  #recent(key: string): number[] | undefined {
    const hits = this.#hits.get(key);
    if (!hits) return undefined;
    const since = this.#now() - this.#windowMs;
    const kept = hits.filter((at) => at > since);
    if (kept.length === 0) {
      this.#hits.delete(key);
      return undefined;
    }
    this.#hits.set(key, kept);
    return kept;
  }

  #prune(): void {
    for (const key of [...this.#hits.keys()]) this.#recent(key);
  }
}

/** One request to count: a counter and the key it is counted under. */
export type Count = readonly [Counter, string];

/**
 * Counts one request in each of `counts` when every one of them is under its
 * limit, and says whether they were; when one is not, nothing is counted. It
 * runs to its end before any other request is looked at, so requests sent
 * together cannot all get through.
 */
export function take(...counts: Count[]): boolean {
  if (!counts.every(([counter, key]) => counter.allows(key))) return false;
  for (const [counter, key] of counts) counter.add(key);
  return true;
}

/** The sign-in's counters (README, «Sign-in»). */
export type SignInLimits = {
  /** Every sign-in request together: a breaker far above the team's own use, 600 a minute. */
  all: Counter;
  /** Code requests: 3 an hour per address and client. */
  codes: Counter;
  /** Code requests: 10 an hour per client, whatever the address. */
  clientCodes: Counter;
  /** Wrong codes per address and client: 5 an hour and 10 a day. A success clears them. */
  wrongHour: Counter;
  wrongDay: Counter;
  /**
   * Wrong codes per client, whatever the address: 10 an hour and 20 a day.
   * A failed passkey sign-in counts here too. A success clears them.
   */
  clientWrongHour: Counter;
  clientWrongDay: Counter;
  /** Passkey sign-ins started: 20 an hour per client. */
  passkeyStarts: Counter;
};

export function signInLimits(now: () => number = Date.now, maxKeys = 10_000): SignInLimits {
  return {
    all: new Counter(600, MINUTE, now, 1),
    codes: new Counter(3, HOUR, now, maxKeys),
    clientCodes: new Counter(10, HOUR, now, maxKeys),
    wrongHour: new Counter(5, HOUR, now, maxKeys),
    wrongDay: new Counter(10, DAY, now, maxKeys),
    clientWrongHour: new Counter(10, HOUR, now, maxKeys),
    clientWrongDay: new Counter(20, DAY, now, maxKeys),
    passkeyStarts: new Counter(20, HOUR, now, maxKeys),
  };
}
