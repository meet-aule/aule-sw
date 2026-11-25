// The team's sign-in: a code by mail, sent only to an address in
// AULE_ADMIN_EMAILS, or a passkey. Every other address gets the same answer,
// so the console tells nobody who is on the team. The platform's team routes
// keep these codes apart from a family's, never make an account, and open a
// session of 12 hours, as a passkey does.
//
//   POST /api/signin/start            {email}         202 {sent: true}, at once, for any address
//   POST /api/signin/verify           {email, code}   200 {signed_in: true} and the cookie, or 403 wrong_code
//   POST /api/signin/passkey/start                    200 {publicKey}, and the ceremony in its cookie
//   POST /api/signin/passkey/finish   {credential}    200 {signed_in: true} and the cookie, or 403 passkey_failed
//   POST /api/signout                                 200 {signed_in: false}, with or without a session

import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import { type Count, type SignInLimits, pairKey, take } from "./limits.ts";
import { log } from "./log.ts";
import { usedPasskey } from "./passkeys.ts";
import { type Platform, PlatformError, type Signed } from "./platform.ts";
import { type Sessions, ceremonyCookie, ceremonyOf, clearedCeremonyCookie, clearedCookie, sessionCookie } from "./sessions.ts";
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
  /** Ends a platform session the console will not hold. */
  revoke: (token: string) => Promise<void>;
};

export function signInRoutes({ team, platform, sessions, limits, floorMs, reply, revoke }: SignInParts) {
  const tooMany = { error: "too_many" };
  // Every sign-in request together, counted only with its client's own
  // counters and only once its body is one: a malformed request, or one past
  // its client's limits, adds nothing to it, so no one client can trip it.
  const breaker: Count = [limits.all, "all"];

  /** `client` is who asks (limits.ts clientKey), for the limits only. */
  async function start(response: ServerResponse, body: Record<string, unknown>, client: string): Promise<void> {
    const email = normalizedEmail(body.email);
    if (!email) return reply(response, 400, { error: "bad_email" });
    if (!take([limits.codes, pairKey(email, client)], [limits.clientCodes, client], breaker)) return reply(response, 429, tooMany);
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

  /**
   * An answer that comes no sooner than the floor after `began`: how long a
   * check takes says nothing. The floor counts from when the body is in, so
   * a body sent slowly cannot use it up before the platform is asked.
   */
  const floored =
    (response: ServerResponse, began: number, always: string[] = []) =>
    async (status: number, value: unknown, cookies: string[] = []) => {
      await delay(Math.max(0, began + floorMs - performance.now()));
      reply(response, status, value, [...cookies, ...always]);
    };

  /**
   * The way in, by a code or a passkey: the client's tries are taken back,
   * the browser's earlier session ends, and a new one opens for the token.
   * The session's cookie comes first.
   */
  function enter(request: IncomingMessage, token: string, tries: Count[], passkey: boolean): string {
    for (const [counter, key] of tries) counter.clear(key);
    // A session this browser already had ends first, and its platform session with it.
    void sessions.end(request, "signed_out");
    const id = sessions.open(token);
    log("signed_in", passkey ? { sessions: sessions.size, passkey } : { sessions: sessions.size });
    return sessionCookie(id);
  }

  async function verify(
    request: IncomingMessage,
    response: ServerResponse,
    body: Record<string, unknown>,
    client: string,
  ): Promise<void> {
    const answer = floored(response, performance.now());
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
    if (!take(...tries, breaker)) return answer(429, tooMany);

    const token = team.has(email) ? await check(email, code) : null;
    if (!token) return answer(403, { error: "wrong_code" });
    return answer(200, { signed_in: true }, [enter(request, token, tries, false)]);
  }

  /**
   * «Entrar con passkey», step one: the platform's ceremony, the same for
   * everyone, its handle in the ceremony's cookie and the options for the
   * browser in the body.
   */
  async function passkeyStart(response: ServerResponse, client: string): Promise<void> {
    if (!take([limits.passkeyStarts, client], breaker)) return reply(response, 429, tooMany);
    let started;
    try {
      started = await platform.passkeyOptions();
    } catch (error) {
      if (!(error instanceof PlatformError)) throw error;
      log("platform_error", { status: error.status });
      return reply(response, 502, { error: "platform" });
    }
    return reply(response, 200, { publicKey: started.publicKey }, [ceremonyCookie(started.ceremony)]);
  }

  /**
   * The platform's session for a passkey's answer to the ceremony, or null.
   * A passkey it does not know, someone no longer on its team or on this
   * console's, a refusal of any kind and a platform that fails all come to
   * null: the page is told the same in each case.
   */
  async function signedBy(ceremony: string, credential: Record<string, unknown>): Promise<string | null> {
    let signed: Signed;
    try {
      signed = await platform.passkeySignIn(ceremony, credential);
    } catch (error) {
      if (!(error instanceof PlatformError)) throw error;
      if (error.status !== 403) log("platform_error", { status: error.status });
      return null;
    }
    if (signed.email !== null && team.has(signed.email)) return signed.token;
    // The platform still counts them as the team and this console does not:
    // the two lists differ until both are restarted, and either one leaving
    // someone off is enough. The session the platform opened ends unused.
    log("passkey_off_team");
    await revoke(signed.token);
    return null;
  }

  /**
   * «Entrar con passkey», step two: the browser's answer, built again, and
   * the ceremony from its cookie, which every answer clears. A failure counts
   * apart from wrong codes, so neither holds the other back, and none is
   * answered before the floor.
   */
  async function passkeyFinish(
    request: IncomingMessage,
    response: ServerResponse,
    body: Record<string, unknown>,
    client: string,
  ): Promise<void> {
    const answer = floored(response, performance.now(), [clearedCeremonyCookie]);
    const credential = usedPasskey(body.credential);
    if (!credential) return reply(response, 400, { error: "bad_request" }, [clearedCeremonyCookie]);
    // The try counts before the platform is asked, as a code's; a success takes it back.
    const tries: Count[] = [[limits.passkeyFailures, client]];
    if (!take(...tries, breaker)) return answer(429, tooMany);
    const ceremony = ceremonyOf(request);
    const token = ceremony ? await signedBy(ceremony, credential) : null;
    if (!token) return answer(403, { error: "passkey_failed" });
    return answer(200, { signed_in: true }, [enter(request, token, tries, true)]);
  }

  /** Works with or without a session: the cookie goes, whatever the platform answers. */
  async function signOut(request: IncomingMessage, response: ServerResponse): Promise<void> {
    await sessions.end(request, "signed_out");
    log("signed_out", { sessions: sessions.size });
    reply(response, 200, { signed_in: false }, [clearedCookie]);
  }

  return { start, verify, passkeyStart, passkeyFinish, signOut };
}
