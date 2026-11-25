// An encrypted HttpOnly ticket survives a BFF restart. It is only routing:
// the platform must still authorize the owner and the session on every use.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { AccessToken, TrackSource } from "livekit-server-sdk";
import type { Settings } from "./config.ts";
import type { Session } from "./session.ts";

const COOKIE = "aule_recovery";
const TICKET = /^v1\.[A-Za-z0-9_-]{40,3000}$/;
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
    if (name === COOKIE && value && TICKET.test(value)) return value;
  }
  return null;
}

export function recoveryCookie(ticket: string, basePath: string, seconds = 0): string {
  return `${COOKIE}=${ticket}; Max-Age=${Math.max(0, Math.floor(seconds))}; Path=${basePath}/; HttpOnly; Secure; SameSite=Strict`;
}

export class RecoveryTickets {
  readonly #key: Buffer;
  readonly #context: Buffer;
  readonly now: () => number;
  constructor(settings: Settings, now: () => number = Date.now) {
    this.now = now;
    // Domain separation: this key cannot be used to sign LiveKit room tokens.
    this.#key = Buffer.from(hkdfSync("sha256", settings.livekitApiSecret, settings.livekitApiKey, "aule.playground.recovery.v1", 32));
    this.#context = Buffer.from(`${COOKIE}:v1:${settings.basePath}`);
  }

  remember(token: string, student: string, session: Session): string {
    // Pick fields explicitly: no room JWT, dispatch metadata or future profile
    // field added to the platform response may reach even an encrypted cookie.
    const entry: Recovery = {
      owner: hash(token), student,
      session: {
        session_id: session.session_id, room: session.room, serverUrl: session.serverUrl,
        agentName: session.agentName, expiresInSeconds: session.expiresInSeconds, engine: session.engine,
      },
      expires: this.now() + session.expiresInSeconds * 1000,
    };
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(this.#context);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(entry), "utf8"), cipher.final()]);
    const ticket = `v1.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url")}`;
    if (!TICKET.test(ticket)) throw new Error("recovery ticket exceeds cookie limit");
    return ticket;
  }

  get(ticket: string | null, token: string): Recovery | null {
    if (!ticket || !TICKET.test(ticket)) return null;
    try {
      const bytes = Buffer.from(ticket.slice(3), "base64url");
      const decipher = createDecipheriv("aes-256-gcm", this.#key, bytes.subarray(0, 12));
      decipher.setAAD(this.#context);
      decipher.setAuthTag(bytes.subarray(12, 28));
      const plaintext = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
      const entry: unknown = JSON.parse(plaintext.toString("utf8"));
      if (!isRecovery(entry) || entry.owner !== hash(token)) return null;
      if (entry.expires + STATUS_GRACE_SECONDS * 1000 <= this.now()) return null;
      return entry;
    } catch {
      // Old, corrupt or rotated-key tickets reveal neither data nor crypto errors.
      return null;
    }
  }
}

function isRecovery(value: unknown): value is Recovery {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<Recovery>;
  const session = entry.session;
  return typeof entry.owner === "string" && /^[0-9a-f]{64}$/.test(entry.owner)
    && typeof entry.student === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(entry.student)
    && typeof entry.expires === "number" && Number.isSafeInteger(entry.expires)
    && !!session && typeof session === "object"
    && typeof session.session_id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(session.session_id)
    && typeof session.room === "string" && session.room.length > 0
    && typeof session.serverUrl === "string" && /^wss?:\/\//.test(session.serverUrl)
    && typeof session.agentName === "string"
    && typeof session.expiresInSeconds === "number" && Number.isSafeInteger(session.expiresInSeconds) && session.expiresInSeconds > 0
    && (session.engine === undefined || typeof session.engine === "boolean");
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
