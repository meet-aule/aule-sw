// The platform, as the console asks it. The sign-in calls go to the
// platform's routes for the team's own codes (/v1/auth/team/*) and carry no
// Authorization header, as the platform needs none for them; every other call
// carries the signed-in team member's own token, which never leaves this
// process. The platform's Staff check decides each of them.

import { userAgent } from "./build.ts";

/**
 * The platform said no, or did not answer (status 0). Its message and code are
 * kept to tell its refusals apart here; they are never logged or sent to the
 * browser. `code` is null when the answer was not the platform's own error,
 * such as the bare 404 of a route an older platform does not have.
 */
export class PlatformError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// A guardian's session token, as the platform makes them: 32 random bytes in hex.
const TOKEN = /^[0-9a-f]{64}$/;

export type Build = { version: string | null; commit: string | null };

export type Platform = {
  /**
   * Asks the platform to mail a code for the console. It sends one only to an
   * address on its own list of the team that has an account, and answers the
   * same for every address.
   */
  sendCode(email: string): Promise<void>;
  /** Trades that code for a platform session of 12 hours; the platform never makes an account for it. */
  verifyCode(email: string, code: string): Promise<string>;
  /** Ends that one platform session; the person's others, the playground's included, stay. */
  signOut(token: string): Promise<void>;
  /** Which build the platform runs, from its health probe; nulls where it does not say. */
  build(): Promise<Build>;
  /** A call on the team member's behalf. */
  teamCall(token: string, method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<unknown>;
};

export function createPlatform(baseUrl: string, commit: string, timeoutMs = 10_000): Platform {
  async function call(method: string, path: string, token: string | null, body?: unknown, wait = timeoutMs): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          // Which build asks, for the platform's side of a problem.
          "User-Agent": userAgent(commit),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // The token goes to the platform's address and nowhere it might point.
        redirect: "error",
        signal: AbortSignal.timeout(wait),
      });
    } catch {
      throw new PlatformError("the platform did not answer", 0);
    }
    const answer = (await response.json().catch(() => ({}))) as { error?: { message?: unknown; code?: unknown } } | null;
    if (!response.ok) {
      const message = typeof answer?.error?.message === "string" ? answer.error.message : "";
      const code = typeof answer?.error?.code === "string" ? answer.error.code : null;
      throw new PlatformError(message || `the platform answered ${response.status}`, response.status, code);
    }
    return answer;
  }

  return {
    async sendCode(email) {
      await call("POST", "/v1/auth/team/start", null, { email });
    },
    async verifyCode(email, code) {
      const answer = (await call("POST", "/v1/auth/team/verify", null, { email, code })) as { token?: unknown };
      if (typeof answer?.token !== "string" || !TOKEN.test(answer.token)) {
        throw new PlatformError("the platform sent no session", 502);
      }
      return answer.token;
    },
    async signOut(token) {
      await call("POST", "/v1/auth/signout", token, undefined, 5_000);
    },
    async build() {
      let answer: Record<string, unknown> = {};
      try {
        answer = ((await call("GET", "/healthz", null)) as Record<string, unknown>) ?? {};
      } catch (error) {
        if (!(error instanceof PlatformError)) throw error;
      }
      const text = (value: unknown) => (typeof value === "string" && value ? value : null);
      return { version: text(answer.version), commit: text(answer.commit) };
    },
    teamCall(token, method, path, body) {
      return call(method, path, token, body);
    },
  };
}
