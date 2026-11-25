// The team's sign-in: a code by mail, sent only to an address in
// AULE_ADMIN_EMAILS. Every other address gets the same answer, so the console
// tells nobody who is on the team. The platform's team routes keep these codes
// apart from a family's, never make an account, and open a session of 12 hours.
//
//   POST /api/signin/start   {email}         202 {sent: true}, at once, for any address
//   POST /api/signin/verify  {email, code}   200 {signed_in: true} and the cookie, or 403 wrong_code
//   POST /api/signout                        200 {signed_in: false}, with or without a session

import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import { type Count, type SignInLimits, pairKey, take } from "./limits.ts";
import { log } from "./log.ts";
import { type Platform, PlatformError } from "./platform.ts";
import { type Sessions, clearedCookie, sessionCookie } from "./sessions.ts";
import { normalizedEmail } from "./team.ts";

export type Reply = (response: ServerResponse, status: number, body: unknown, cookies?: string[]) => void;

export type SignInParts = {
  team: ReadonlySet<string>;
  platform: Platform;
  sessions: Sessions;
  limits: SignInLimits;
  /** No code check answers sooner than this after its body was read. */
  floorMs: number;
  reply: Reply;
};

export function signInRoutes({ team, platform, sessions, limits, floorMs, reply }: SignInParts) {
  const tooMany = { error: "too_many" };

  /** `client` is who asks (limits.ts clientKey), for the limits only. */
  async function start(response: ServerResponse, body: Record<string, unknown>, client: string): Promise<void> {
    if (!take([limits.all, "all"])) return reply(response, 429, tooMany);
    const email = normalizedEmail(body.email);
    if (!email) return reply(response, 400, { error: "bad_email" });
    if (!take([limits.codes, pairKey(email, client)], [limits.clientCodes, client])) return reply(response, 429, tooMany);
    // The answer comes first. The platform mails the code inside its own
    // request, so waiting for it would tell a team address apart by the time.
    reply(response, 202, { sent: true });
    if (!team.has(email)) return;
    try {
      await platform.sendCode(email);
      log("code_requested");
    } catch (error) {
      if (!(error instanceof PlatformError)) throw error;
      log("code_not_sent", { status: error.status });
    }
  }

  /**
   * The platform's session for a team address and its code, or null. A wrong,
   * used or expired code, an address the platform does not count as the team
   * or has no account for, and a platform that fails all come to null: the
   * page is told the same in each case.
   */
  async function check(email: string, code: string): Promise<string | null> {
    try {
      return await platform.verifyCode(email, code);
    } catch (error) {
      if (!(error instanceof PlatformError)) throw error;
      if (error.status !== 403) log("platform_error", { status: error.status });
      return null;
    }
  }

  async function verify(
    request: IncomingMessage,
    response: ServerResponse,
    body: Record<string, unknown>,
    client: string,
  ): Promise<void> {
    // How long an answer takes says nothing: none comes before the floor. It
    // counts from here, once the body is in, so a body sent slowly cannot use
    // the floor up before the platform is asked.
    const began = performance.now();
    const answer = async (status: number, value: unknown, cookies?: string[]) => {
      await delay(Math.max(0, began + floorMs - performance.now()));
      reply(response, status, value, cookies);
    };
    if (!take([limits.all, "all"])) return answer(429, tooMany);
    const email = normalizedEmail(body.email);
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!email || !/^\d{6}$/.test(code)) return reply(response, 400, { error: "bad_request" });
    // The try counts before the platform is asked, so tries sent together
    // cannot all get past the limit; a success takes them back.
    const pair = pairKey(email, client);
    const tries: Count[] = [
      [limits.wrongHour, pair],
      [limits.wrongDay, pair],
      [limits.clientWrongHour, client],
      [limits.clientWrongDay, client],
    ];
    if (!take(...tries)) return answer(429, tooMany);

    const token = team.has(email) ? await check(email, code) : null;
    if (!token) return answer(403, { error: "wrong_code" });
    for (const [counter, key] of tries) counter.clear(key);
    // A session this browser already had ends first, and its platform session with it.
    void sessions.end(request, "signed_out");
    const id = sessions.open(token);
    log("signed_in", { sessions: sessions.size });
    return answer(200, { signed_in: true }, [sessionCookie(id)]);
  }

  /** Works with or without a session: the cookie goes, whatever the platform answers. */
  async function signOut(request: IncomingMessage, response: ServerResponse): Promise<void> {
    await sessions.end(request, "signed_out");
    log("signed_out", { sessions: sessions.size });
    reply(response, 200, { signed_in: false }, [clearedCookie]);
  }

  return { start, verify, signOut };
}
