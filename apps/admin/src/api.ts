// The panel's data, each route one platform call made with the signed-in team
// member's own token: the platform's Staff check decides every one of them.
// Nothing from the request goes to the platform as it came: an id is checked
// to be one, and a body is built again from the fields that are allowed.
//
//   GET  /api/build                    the console's build and the platform's
//   GET  /api/metrics/daily            GET /v1/metrics/daily?days=14
//   GET  /api/metrics/weekly           GET /v1/metrics/weekly?weeks=12
//   GET  /api/families                 GET /v1/admin/families
//   POST /api/families/{id}/grant      POST /v1/admin/families/{id}/grant {days, note?}
//   POST /api/families/{id}/ungrant    DELETE /v1/admin/families/{id}/grant

import type { IncomingMessage, ServerResponse } from "node:http";

import { VERSION } from "./build.ts";
import { log } from "./log.ts";
import { type Platform, PlatformError } from "./platform.ts";
import type { Sessions } from "./sessions.ts";
import type { Reply } from "./signin.ts";

/** A family's id as the platform writes it. Only this goes into a platform path. */
export const FAMILY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The platform's own bounds for a granted plan (plans.rs). */
export const MAX_GRANT_DAYS = 366;
export const MAX_NOTE_CHARS = 500;

/** The data routes a session may read, and the platform path each one reads. */
export const READS: ReadonlyMap<string, string | null> = new Map([
  ["/api/build", null],
  ["/api/metrics/daily", "/v1/metrics/daily?days=14"],
  ["/api/metrics/weekly", "/v1/metrics/weekly?weeks=12"],
  ["/api/families", "/v1/admin/families"],
]);

/** A family's plan: «Regalar plan» and «Quitar». */
export const WRITE = /^\/api\/families\/([^/]+)\/(grant|ungrant)$/;

export type ApiParts = { platform: Platform; sessions: Sessions; commit: string; reply: Reply };

export function apiRoutes({ platform, sessions, commit, reply }: ApiParts) {
  /** Answers with what the platform gave, or with what its refusal means here, never in its words. */
  async function asTeam(
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    call: () => Promise<unknown>,
  ): Promise<void> {
    let answer: unknown;
    try {
      answer = await call();
    } catch (error) {
      if (!(error instanceof PlatformError)) throw error;
      // The platform no longer knows the token: the console's session goes too.
      if (error.status === 401) {
        await sessions.end(request, "refused", false);
        return reply(response, 401, { error: "signed_out" });
      }
      // Not on the team at the platform (any more): the session goes, and its platform session with it.
      if (error.status === 403) {
        void sessions.end(request, "refused");
        return reply(response, 403, { error: "not_team" });
      }
      if (error.status === 400) return reply(response, 400, { error: "bad_request" });
      if (error.status === 404) return reply(response, 404, { error: "not_found" });
      log("platform_error", { status: error.status });
      return reply(response, 502, { error: "platform" });
    }
    return reply(response, status, answer);
  }

  async function read(path: string, request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
    if (path === "/api/build") {
      // Which builds answer, as their logs name them. The session is the team check.
      return reply(response, 200, { admin: { version: VERSION, commit }, platform: await platform.build() });
    }
    const target = READS.get(path);
    if (!target) return reply(response, 404, { error: "not_found" });
    return asTeam(request, response, 200, () => platform.teamCall(token, "GET", target));
  }

  async function write(
    id: string,
    action: string,
    request: IncomingMessage,
    response: ServerResponse,
    token: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    if (!FAMILY_ID.test(id)) return reply(response, 400, { error: "bad_request" });
    const grant = `/v1/admin/families/${id}/grant`;
    if (action === "ungrant") return asTeam(request, response, 200, () => platform.teamCall(token, "DELETE", grant));
    const days = body.days;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_GRANT_DAYS) {
      return reply(response, 400, { error: "bad_request" });
    }
    // Cut by characters, as the platform counts them, so no pair of a surrogate is ever split.
    const note = typeof body.note === "string" ? [...body.note.trim()].slice(0, MAX_NOTE_CHARS).join("").trim() : "";
    const sent = note ? { days, note } : { days };
    return asTeam(request, response, 201, () => platform.teamCall(token, "POST", grant, sent));
  }

  return { read, write };
}
