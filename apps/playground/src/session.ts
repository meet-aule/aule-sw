// A playground session: one private room, one person, and a request for the
// tutor to join it.

import { randomBytes } from "node:crypto";

import { AccessToken, RoomAgentDispatch, RoomConfiguration, TrackSource } from "livekit-server-sdk";

import { userAgent } from "./build.ts";
import type { Language, Settings } from "./config.ts";

export type Session = {
  /** Set when the platform created the session. */
  session_id?: string;
  serverUrl: string;
  token: string;
  room: string;
  agentName: string;
  expiresInSeconds: number;
  engine?: boolean;
};

export class PlatformError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

// `token` is a signed-in guardian's; without one the call is the team's own.
export async function platform(
  settings: Settings,
  path: string,
  body?: unknown,
  token?: string,
  method?: "DELETE" | "PUT",
): Promise<unknown> {
  const response = await fetch(`${settings.platform!.url}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      Authorization: `Bearer ${token ?? settings.platform!.adminToken}`,
      // Which build of the page asks, for the platform's side of a problem.
      "User-Agent": userAgent(settings.commit),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const answer = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!response.ok) {
    throw new PlatformError(answer.error?.message ?? `the platform answered ${response.status}`, response.status);
  }
  return answer;
}

/** The public id of each provider people can sign in with; null where it is not set up. */
export type Providers = {
  google: string | null;
  github: string | null;
  meta: string | null;
  apple: string | null;
  /** Whether a sign-in code can be sent by email. */
  email: boolean;
};

export async function signInProviders(settings: Settings): Promise<Providers> {
  const none = { google: null, github: null, meta: null, apple: null, email: false };
  try {
    const answer = (await platform(settings, "/v1/auth/providers")) as Record<string, unknown>;
    const id = (value: unknown) => (typeof value === "string" && value ? value : null);
    return {
      google: id(answer.google),
      github: id(answer.github),
      meta: id(answer.meta),
      apple: id(answer.apple),
      email: answer.email === true,
    };
  } catch (error) {
    if (error instanceof PlatformError) return none;
    throw error;
  }
}

/** Which build the platform runs, from its health probe; nulls where it does not say. */
export async function platformBuild(settings: Settings): Promise<{ version: string | null; commit: string | null }> {
  let answer: Record<string, unknown> = {};
  try {
    answer = (await platform(settings, "/healthz")) as Record<string, unknown>;
  } catch (error) {
    if (!(error instanceof PlatformError)) throw error;
  }
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  return { version: text(answer.version), commit: text(answer.commit) };
}

/** The family's plan and what is left of it, and whether the person is on Aule's team. */
export type Plan = { standing: Record<string, unknown> | null; team: boolean };

export async function readPlan(settings: Settings, token: string): Promise<Plan> {
  try {
    const { team, ...standing } = (await platform(settings, "/v1/me/plan", undefined, token)) as Record<
      string,
      unknown
    >;
    return { standing, team: team === true };
  } catch (error) {
    // Without it the page shows no plan, and the platform still keeps the limit.
    if (error instanceof PlatformError) return { standing: null, team: false };
    throw error;
  }
}

/** Asks the platform to email a sign-in code. It answers the same whether or not the address has an account. */
export async function emailCode(settings: Settings, email: string): Promise<void> {
  await platform(settings, "/v1/auth/start", { email, language: "es" });
}

/**
 * Trades an emailed code for a session; a new address needs the guardian's
 * name. `source` is the link a new family came from (signin.ts).
 */
export async function signInWithEmail(
  settings: Settings,
  email: string,
  code: string,
  name: string | null,
  source: string | null = null,
): Promise<SignedIn> {
  const answer = (await platform(settings, "/v1/auth/verify", {
    email,
    code,
    language: "es",
    ...(name ? { name } : {}),
    ...(source ? { source } : {}),
  })) as { token?: unknown; expires_in_days?: unknown };
  if (typeof answer.token !== "string") throw new PlatformError("the platform sent no session");
  return { token: answer.token, days: typeof answer.expires_in_days === "number" ? answer.expires_in_days : 1 };
}

/** Trades the code a provider sent back for a session of the person it names. */
export async function signInWithCode(
  settings: Settings,
  provider: "github" | "meta" | "apple",
  code: string,
  redirectUri: string,
  name: string | null,
  source: string | null = null,
): Promise<SignedIn> {
  const answer = (await platform(settings, `/v1/auth/${provider}`, {
    code,
    redirect_uri: redirectUri,
    ...(name ? { name } : {}),
    ...(source ? { source } : {}),
  })) as { token?: unknown; expires_in_days?: unknown };
  if (typeof answer.token !== "string") throw new PlatformError("the platform sent no session");
  return { token: answer.token, days: typeof answer.expires_in_days === "number" ? answer.expires_in_days : 1 };
}

export type SignedIn = { token: string; days: number };

/** Trades what Google gave the page for a session of the person it names. */
export async function signIn(settings: Settings, credential: string, source: string | null = null): Promise<SignedIn> {
  const answer = (await platform(settings, "/v1/auth/google", { credential, ...(source ? { source } : {}) })) as {
    token?: unknown;
    expires_in_days?: unknown;
  };
  if (typeof answer.token !== "string") throw new PlatformError("the platform sent no session");
  return { token: answer.token, days: typeof answer.expires_in_days === "number" ? answer.expires_in_days : 1 };
}

/**
 * Erases the signed-in guardian's family: the account, its students and what
 * was kept about them. The platform only does it when the address typed is the
 * one the guardian signed in with.
 */
export function eraseAccount(settings: Settings, token: string, email: string): Promise<unknown> {
  return platform(settings, "/v1/me", { confirm_email: email }, token, "DELETE");
}

export function signOut(settings: Settings, token: string): Promise<unknown> {
  return platform(settings, "/v1/auth/signout", {}, token);
}

export type Account = {
  name: string;
  familyId: string;
  students: { id: string; name: string }[];
  /** The subjects the platform keeps for a student; null when it keeps none. */
  subjects: string[] | null;
};

/** Who is signed in and the students of their family. */
export async function account(settings: Settings, token: string): Promise<Account> {
  const answer = (await platform(settings, "/v1/me", undefined, token)) as {
    guardian?: { name?: unknown };
    family_id?: unknown;
    children?: { id?: unknown; nickname?: unknown }[];
    subjects?: unknown;
  };
  if (typeof answer.family_id !== "string") throw new PlatformError("the platform sent no family");
  return {
    name: typeof answer.guardian?.name === "string" ? answer.guardian.name : "",
    familyId: answer.family_id,
    students: (answer.children ?? []).flatMap((child) =>
      typeof child.id === "string" && typeof child.nickname === "string"
        ? [{ id: child.id, name: child.nickname }]
        : [],
    ),
    subjects: Array.isArray(answer.subjects)
      ? answer.subjects.filter((subject): subject is string => typeof subject === "string")
      : null,
  };
}

/** What the supervisor planned and advised in a session the platform created. */
/**
 * Where a session run by the engine stands: the stage, the route and the card
 * of the exercise. Never the answer. `token` is the guardian's when signed in.
 */
export function step(settings: Settings, sessionId: string, token?: string): Promise<unknown> {
  return platform(settings, `/v1/sessions/${encodeURIComponent(sessionId)}/step`, undefined, token);
}

/** An answer written on the page, checked by the platform like a spoken one. */
export function answer(
  settings: Settings,
  sessionId: string,
  written: { answer: string; explanation?: string },
  token?: string,
): Promise<unknown> {
  return platform(settings, `/v1/sessions/${encodeURIComponent(sessionId)}/answers`, written, token);
}

export function supervisorView(settings: Settings, sessionId: string): Promise<unknown> {
  return platform(settings, `/v1/sessions/${encodeURIComponent(sessionId)}/supervisor`);
}

export async function createSession(settings: Settings, language: Language): Promise<Session> {
  if (settings.platform) {
    // The platform creates the session, so the supervisor plans and follows it.
    const body = { audience: "operator", language, child_id: settings.platform.childId ?? undefined };
    return (await platform(settings, "/v1/sessions", body)) as Session;
  }
  const id = randomBytes(9).toString("base64url");
  const room = `playground-${id}`;
  const expiresInSeconds = settings.sessionMinutes * 60;

  const token = new AccessToken(settings.livekitApiKey, settings.livekitApiSecret, {
    identity: `operator-${id}`,
    name: "Operator",
    ttl: expiresInSeconds,
  });
  token.addGrant({
    room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA],
  });
  // The room is created when the person joins, already asking for the tutor.
  // "operator" tells the agent this is an adult on the team: it refuses any
  // other session until the safety gates exist. Whoever holds the token can
  // read it, so the dispatch says only what the page chose and nothing secret.
  // A session the platform creates has its room opened by the platform instead.
  token.roomConfig = new RoomConfiguration({
    emptyTimeout: 30,
    // Keep the room while the client reconnects, as platform-issued rooms do.
    departureTimeout: 120,
    maxParticipants: 2,
    agents: [
      new RoomAgentDispatch({
        agentName: settings.agentName,
        metadata: JSON.stringify({ audience: "operator", language }),
      }),
    ],
  });

  return {
    serverUrl: settings.livekitUrl,
    token: await token.toJwt(),
    room,
    agentName: settings.agentName,
    expiresInSeconds,
  };
}
