// A reload ticket is opaque and HttpOnly. Only room routing and the original
// deadline stay in bounded RAM; a server restart forgets them.
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { AccessToken, TrackSource } from "livekit-server-sdk";
import type { Settings } from "./config.ts";
import type { Session } from "./session.ts";

const COOKIE = "aule_recovery";
const CAPACITY = 512;
export const STATUS_GRACE_SECONDS = 300;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export type Recovery = {
  owner: string;
  student: string;
  session: Omit<Session, "token">;
  expires: number;
};

export function recoveryTicket(request: IncomingMessage): string | null {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === COOKIE && value && /^[0-9a-f]{64}$/.test(value)) return value;
  }
  return null;
}

export function recoveryCookie(ticket: string, basePath: string, seconds = 0): string {
  return `${COOKIE}=${ticket}; Max-Age=${Math.max(0, Math.floor(seconds))}; Path=${basePath}/; HttpOnly; Secure; SameSite=Strict`;
}

export class RecoveryStore {
  readonly #entries = new Map<string, Recovery>();
  readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  remember(token: string, student: string, session: Session): string {
    for (const [key, value] of this.#entries) if (value.expires + STATUS_GRACE_SECONDS * 1000 <= this.now()) this.#entries.delete(key);
    if (this.#entries.size >= CAPACITY) this.#entries.delete(this.#entries.keys().next().value!);
    const ticket = randomBytes(32).toString("hex");
    const { token: _token, ...routing } = session;
    this.#entries.set(ticket, {
      owner: hash(token), student, session: routing,
      expires: this.now() + session.expiresInSeconds * 1000,
    });
    return ticket;
  }

  get(ticket: string | null, token: string): Recovery | null {
    const entry = ticket ? this.#entries.get(ticket) : undefined;
    if (!entry || entry.owner !== hash(token)) return null;
    if (entry.expires + STATUS_GRACE_SECONDS * 1000 <= this.now()) {
      this.#entries.delete(ticket!);
      return null;
    }
    return entry;
  }

  forget(ticket: string | null): void {
    if (ticket) this.#entries.delete(ticket);
  }
}

/** Rejoin the same identity without room configuration or agent dispatch. */
export async function resumeToken(settings: Settings, recovery: Recovery, seconds: number): Promise<string> {
  const token = new AccessToken(settings.livekitApiKey, settings.livekitApiSecret, {
    identity: `child-${recovery.session.session_id!.replaceAll("-", "")}`,
    ttl: seconds,
  });
  token.addGrant({
    room: recovery.session.room, roomJoin: true,
    canPublish: true, canSubscribe: true, canPublishData: true,
    canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA],
  });
  return token.toJwt();
}
