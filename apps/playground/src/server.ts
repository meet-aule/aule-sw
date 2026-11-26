// The playground's HTTP server: a static page and one endpoint that trades the
// access code for a room token. Reload tickets keep only encrypted room routing.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomServiceClient } from "livekit-server-sdk";

import { GuessLimiter, sameCode } from "./access.ts";
import { cacheFor, keptUntilEdited, loadAssets, stillFresh } from "./assets.ts";
import { stamps, VERSION } from "./build.ts";
import { ConfigError, LANGUAGES, readSettings, type Language, type Settings } from "./config.ts";
import {
  account,
  answer,
  createSession,
  eraseAccount,
  platform,
  PlatformError,
  readPlan,
  emailCode,
  signIn,
  signInProviders,
  signInWithCode,
  signInWithEmail,
  signOut,
  step,
  supervisorView,
} from "./session.ts";
import {
  createStudent,
  forget,
  known,
  latestSessions,
  objectiveFrom,
  profileFrom,
  readStudent,
  readStudents,
  removeStudent,
  saveStudent,
  startSession,
} from "./students.ts";
import {
  appleName,
  authorizeUrl,
  clearedStateCookie,
  CODE_PROVIDERS,
  type CodeProvider,
  newState,
  stateCookie,
  stateMatches,
} from "./providers.ts";
import {
  clearedSourceCookie,
  DailyLimit,
  guardianToken,
  signedInCookie,
  signedOutCookie,
  sourceCode,
  sourceCookie,
  sourceOf,
} from "./signin.ts";
import { RecoveryTickets, recoveryCookie, recoveryTicket, resumeToken, STATUS_GRACE_SECONDS } from "./recovery.ts";

const publicDir = new URL("../public/", import.meta.url);
// The browser build that ships inside the livekit-client package.
// The engine of Aule's animated face: one file with no imports and no network calls of its own.
const mascot = join(dirname(createRequire(import.meta.url).resolve("wobnimo/package.json")), "dist", "wobnimo.js");

const livekitClient = join(
  dirname(createRequire(import.meta.url).resolve("livekit-client")),
  "livekit-client.umd.js",
);

// The page's two typefaces, each from its own package: no font is fetched
// from anywhere else. Source Serif 4 for titles, Inter for everything else.
const serif = join(
  dirname(createRequire(import.meta.url).resolve("@fontsource-variable/source-serif-4/package.json")),
  "files",
);
const sans = join(dirname(createRequire(import.meta.url).resolve("@fontsource-variable/inter/package.json")), "files");

const STATIC: Record<string, { file: string | URL; type: string }> = {
  "/": { file: new URL("index.html", publicDir), type: "text/html; charset=utf-8" },
  "/app.js": { file: new URL("app.js", publicDir), type: "text/javascript; charset=utf-8" },
  "/students.js": { file: new URL("students.js", publicDir), type: "text/javascript; charset=utf-8" },
  "/signin.js": { file: new URL("signin.js", publicDir), type: "text/javascript; charset=utf-8" },
  // The screens of the Figma «Login-Aule» v8 (FIGMA.md): their table, the
  // router, the onboarding and the family's home.
  "/steps.js": { file: new URL("steps.js", publicDir), type: "text/javascript; charset=utf-8" },
  "/screens.js": { file: new URL("screens.js", publicDir), type: "text/javascript; charset=utf-8" },
  "/onboarding.js": { file: new URL("onboarding.js", publicDir), type: "text/javascript; charset=utf-8" },
  "/home.js": { file: new URL("home.js", publicDir), type: "text/javascript; charset=utf-8" },
  // The fixed words for a session that can be resumed or has ended.
  "/session-messages.js": { file: new URL("session-messages.js", publicDir), type: "text/javascript; charset=utf-8" },
  // A child's first steps: the hand-off, the microphone check on the device and the coached first turn.
  "/first-steps.js": { file: new URL("first-steps.js", publicDir), type: "text/javascript; charset=utf-8" },
  // The lines the family's home says about each student's latest sessions.
  "/summaries.js": { file: new URL("summaries.js", publicDir), type: "text/javascript; charset=utf-8" },
  "/visuals.js": { file: new URL("visuals.js", publicDir), type: "text/javascript; charset=utf-8" },
  // Aule's face: the cuy the mascot's engine draws, and the arithmetic that shows it in pixel art.
  "/cuy.js": { file: new URL("cuy.js", publicDir), type: "text/javascript; charset=utf-8" },
  "/pixels.js": { file: new URL("pixels.js", publicDir), type: "text/javascript; charset=utf-8" },
  "/style.css": { file: new URL("style.css", publicDir), type: "text/css; charset=utf-8" },
  "/icon.svg": { file: new URL("icon.svg", publicDir), type: "image/svg+xml" },
  // The cuy with glasses for a phone's home screen and for launchers.
  "/apple-touch-icon.png": { file: new URL("apple-touch-icon.png", publicDir), type: "image/png" },
  "/icon-192.png": { file: new URL("icon-192.png", publicDir), type: "image/png" },
  "/icon-512.png": { file: new URL("icon-512.png", publicDir), type: "image/png" },
  "/icon-maskable-512.png": { file: new URL("icon-maskable-512.png", publicDir), type: "image/png" },
  "/manifest.webmanifest": { file: new URL("manifest.webmanifest", publicDir), type: "application/manifest+json" },
  // The one-page guide the team sends families, in Spanish and in English.
  "/guia": { file: new URL("guia.html", publicDir), type: "text/html; charset=utf-8" },
  "/guide": { file: new URL("guide.html", publicDir), type: "text/html; charset=utf-8" },
  "/fonts/serif.woff2": { file: join(serif, "source-serif-4-latin-wght-normal.woff2"), type: "font/woff2" },
  "/fonts/serif-italic.woff2": { file: join(serif, "source-serif-4-latin-wght-italic.woff2"), type: "font/woff2" },
  "/fonts/sans.woff2": { file: join(sans, "inter-latin-wght-normal.woff2"), type: "font/woff2" },
  "/fonts/sans-italic.woff2": { file: join(sans, "inter-latin-wght-italic.woff2"), type: "font/woff2" },
  "/livekit-client.js": { file: livekitClient, type: "text/javascript; charset=utf-8" },
  "/wobnimo.js": { file: mascot, type: "text/javascript; charset=utf-8" },
};

const MAX_BODY_BYTES = 2_000;
// A Google credential is a signed token of a couple of thousand characters.
const MAX_SIGN_IN_BYTES = 8_000;
// A student's profile: a name, up to ten interests and a line from the family.
const MAX_PROFILE_BYTES = 4_000;
// Apple's form: a code, the state, a signed token and, the first time, a name.
const MAX_FORM_BYTES = 8_000;
// An address that looks like one; the platform checks it properly.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SIGN_IN_PATH = /^\/api\/signin\/(github|meta|apple)\/(start|callback)$/;
const ID = /^[0-9a-f-]{36}$/i;
// A session's own address, <base path>/<its id> (FIGMA.md D41): the page, as at
// "/". Only an id as the platform writes it, a UUID in lower case, is one. Nothing
// here looks it up: which session the page may carry on is still the sign-in's.
const SESSION_PAGE = /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// What a student writes in the two boxes of an exercise.
const MAX_ANSWER_CHARS = 200;
const MAX_EXPLANATION_CHARS = 600;
// Where the browser gets Google's sign-in button from, and nothing else of Google's.
const GOOGLE = "https://accounts.google.com/gsi/";

function securityHeaders(settings: Settings): Record<string, string> {
  const livekit = new URL(settings.livekitUrl);
  const signalling = `${livekit.protocol}//${livekit.host}`;
  const http = signalling.replace(/^ws/, "http");
  return {
    "Content-Security-Policy": [
      "default-src 'none'",
      `script-src 'self' ${GOOGLE}client`,
      // Google's button sizes itself with styles it writes into the page; without
      // them it draws its logo across the whole screen. Scripts stay strict.
      `style-src 'self' 'unsafe-inline' ${GOOGLE}style`,
      `connect-src 'self' ${signalling} ${http} ${GOOGLE}`,
      `frame-src ${GOOGLE}`,
      "manifest-src 'self'",
      "font-src 'self'",
      "media-src 'self' blob: mediastream:",
      "img-src 'self' data:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    // Google's sign-in opens a window that has to answer this page.
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    "Permissions-Policy": "camera=(self), microphone=(self)",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow",
    "Cache-Control": "no-store",
  };
}

async function readText(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("not an object");
  }
  return body as Record<string, unknown>;
}

/**
 * The address a request asks for. Its target is a path, so a leading "//" is
 * part of the path, not a host ("//" alone would be a host with no name, which
 * URL refuses). A target that is still no address, like a bad port in a full
 * one, gives nothing.
 */
function addressOf(target: string): URL | undefined {
  try {
    return new URL(target.startsWith("/") ? `http://playground${target}` : target, "http://playground");
  } catch {
    return undefined;
  }
}

// The page's own scripts: their imports of each other are rewritten to the
// fingerprinted addresses. The packages' bundles are versioned but left as they are.
const OWN_SCRIPTS = new Set([
  "/app.js",
  "/students.js",
  "/signin.js",
  "/steps.js",
  "/screens.js",
  "/onboarding.js",
  "/home.js",
  "/session-messages.js",
  "/first-steps.js",
  "/summaries.js",
  "/visuals.js",
  "/cuy.js",
  "/pixels.js",
]);

// The pages a family may be sent to with a link's code (?src=cesar), which is
// kept until they sign in.
const LINKED_PAGES = new Set(["/", "/guia", "/guide"]);
// Pages reached from an address typed or shared by hand (see the redirects).
const TYPED_PAGES = ["/guia", "/guide"];
// The team's panel moved to its own console (apps/admin). Its old address
// sends the team there: a fixed address, never one taken from the request.
const TEAM_CONSOLE = "https://admin.meetaule.com/";

export function createPlayground(
  settings: Settings,
  rooms: Pick<RoomServiceClient, "listParticipants" | "deleteRoom"> = new RoomServiceClient(
    settings.livekitServiceUrl, settings.livekitApiKey, settings.livekitApiSecret, { requestTimeout: 5 },
  ),
): Server {
  const headers = securityHeaders(settings);
  // Read on the first request and kept in memory until a file in public/
  // changes, so an edit to the page shows on the next reload. The pages say
  // which build they come from.
  const assets = keptUntilEdited(publicDir, () => loadAssets(STATIC, OWN_SCRIPTS, stamps(settings.commit)));
  const assetFor = async (path: string) => (await assets.get()).get(path);
  const limiter = new GuessLimiter();
  const daily = new DailyLimit(settings.dailySessions);
  const recoveries = new RecoveryTickets(settings);

  async function lifecycle(path: string, request: IncomingMessage, response: ServerResponse) {
    const token = guardianToken(request);
    if (!settings.platform || !token) return json(response, 401, { error: "not_signed_in" });
    const ticket = recoveryTicket(request);
    const saved = recoveries.get(ticket, token);
    const clear = () => {
      response.setHeader("Set-Cookie", recoveryCookie("", settings.basePath));
    };
    if (!saved?.session.session_id) {
      response.setHeader("Set-Cookie", recoveryCookie("", settings.basePath));
      return json(response, 200, { available: false });
    }
    let body: Record<string, unknown> = {};
    if (request.method === "POST") {
      if (request.headers.origin) {
        try {
          const origin = new URL(request.headers.origin);
          if (!["https:", "http:"].includes(origin.protocol) || origin.host !== request.headers.host) {
            return json(response, 403, { error: "wrong_origin" });
          }
        } catch { return json(response, 403, { error: "wrong_origin" }); }
      }
      if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
        return json(response, 400, { error: "bad_request" });
      }
      try { body = await readJson(request); } catch { return json(response, 400, { error: "bad_request" }); }
      if (body.session_id !== saved.session.session_id) {
        return json(response, 409, { error: "session_changed" });
      }
    }
    const endpoint = `/v1/sessions/${saved.session.session_id}`;
    let state: { status: string; end_reason: string | null; remaining_seconds: number; can_resume: boolean; language: string };
    try {
      state = await platform(settings, endpoint, undefined, token) as typeof state;
    } catch (error) {
      if (error instanceof PlatformError && [401, 403, 404].includes(error.status)) {
        clear();
        return json(response, error.status === 401 ? 401 : 200, { available: false });
      }
      throw error;
    }
    if (path === "/api/session/end") {
      // A session its tutor never started (the platform still has it "created")
      // has nothing to flush and cost no speech or model time: it closes at
      // once, and the day's session it took is given back, so a family whose
      // tutor did not arrive can try again (the plan does not count it either).
      const started = state.status !== "created";
      // Let the tutor flush its final turns and usage before the platform closes.
      // If room teardown or agent cleanup fails, the authorized stop still wins.
      const removed = await rooms.deleteRoom(saved.session.room).then(() => true, () => false);
      if (removed && started) {
        for (let attempt = 0; attempt < 20; attempt++) {
          const current = await platform(settings, endpoint, undefined, token) as typeof state;
          if (current.status === "ended") break;
          await delay(250);
        }
      }
      await platform(settings, `${endpoint}/end`, {}, token);
      if (!started) daily.giveBack(token);
      clear();
      return json(response, 200, { ended: true });
    }
    const unavailable = {
      available: false, session_id: saved.session.session_id,
      end_reason: state.end_reason, language: state.language,
    };
    const remaining = Math.min(state.remaining_seconds, Math.floor((saved.expires - Date.now()) / 1000));
    if (state.status !== "active" || !state.can_resume || remaining <= 0) return json(response, 200, unavailable);
    let participants: Awaited<ReturnType<RoomServiceClient["listParticipants"]>>;
    try { participants = await rooms.listParticipants(saved.session.room); }
    catch (error) {
      if ((error as { code?: string }).code === "not_found") participants = [];
      else return json(response, 503, { error: "recovery_unavailable" });
    }
    // ParticipantInfo.Kind.AGENT is 4 in LiveKit's protocol.
    if (!participants.some((participant) => participant.kind === 4)) {
      return json(response, 200, unavailable);
    }
    if (path !== "/api/session/resume") {
      return json(response, 200, { available: true, session_id: saved.session.session_id, student_id: saved.student, remaining_seconds: remaining });
    }
    if (body.student_id !== saved.student) return json(response, 409, { error: "session_changed" });
    // Another tab still owns the participant. Wait for its departure before resuming.
    if (participants.some((participant) => participant.kind !== 4)) {
      return json(response, 409, { error: "session_active" });
    }
    const seconds = Math.min(remaining, Math.floor((saved.expires - Date.now()) / 1000));
    if (seconds <= 0) return json(response, 200, unavailable);
    const resumed = await resumeToken(settings, saved, seconds);
    return json(response, 200, { ...saved.session, token: resumed, expiresInSeconds: seconds });
  }

  const send = (response: ServerResponse, status: number, type: string, body: string | Buffer) => {
    response.writeHead(status, { ...headers, "Content-Type": type });
    response.end(body);
  };
  const json = (response: ServerResponse, status: number, body: unknown) =>
    send(response, status, "application/json; charset=utf-8", JSON.stringify(body));

  // Who is signed in, for the page: never the token, only what it shows.
  async function whoIsHere(
    request: IncomingMessage,
    response: ServerResponse,
    entered?: { token: string; cookies: string[] },
  ) {
    const extra = entered ? { "Set-Cookie": entered.cookies } : {};
    const reply = (body: unknown, more: Record<string, string> = {}) => {
      response.writeHead(200, { ...headers, ...extra, ...more, "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };
    if (!settings.platform) return reply({ google_client_id: null, providers: [], signed_in: false });
    const token = entered?.token ?? guardianToken(request);
    const ids = await signInProviders(settings);
    const clientId = ids.google;
    // The others come back to this page, so they need its public address.
    const providers: string[] = settings.publicUrl ? CODE_PROVIDERS.filter((provider) => ids[provider]) : [];
    if (ids.email) providers.push("email");
    if (!token) return reply({ google_client_id: clientId, providers, signed_in: false });
    try {
      const who = await account(settings, token);
      const students = await readStudents(settings, token, who.students);
      const plan = await readPlan(settings, token);
      return reply({
        google_client_id: clientId,
        providers,
        signed_in: true,
        name: who.name,
        students,
        subjects: who.subjects,
        plan: plan.standing,
        team: plan.team,
      });
    } catch (error) {
      if (!(error instanceof PlatformError)) throw error;
      // A session the platform no longer knows: the page starts over signed out.
      return reply(
        { google_client_id: clientId, providers, signed_in: false },
        { "Set-Cookie": signedOutCookie(settings.basePath) },
      );
    }
  }

  // Signed in, the link a family came from has done its work: it goes.
  const enteredCookies = (token: string, days: number, source: string | null) => [
    signedInCookie(token, settings.basePath, days),
    ...(source ? [clearedSourceCookie(settings.basePath)] : []),
  ];

  async function signedIn(path: string, request: IncomingMessage, response: ServerResponse) {
    if (!settings.platform) return json(response, 404, { error: "not_found" });
    let body: Record<string, unknown>;
    try {
      const limit = path === "/api/signin" ? MAX_SIGN_IN_BYTES : path.startsWith("/api/student") ? MAX_PROFILE_BYTES : MAX_BODY_BYTES;
      body = await readJson(request, limit);
    } catch {
      return json(response, 400, { error: "bad_request" });
    }
    if (path === "/api/signin") {
      if (typeof body.credential !== "string" || !body.credential) {
        return json(response, 400, { error: "bad_request" });
      }
      const source = sourceOf(request);
      let entered;
      try {
        entered = await signIn(settings, body.credential, source);
      } catch (error) {
        if (error instanceof PlatformError && error.status < 500) {
          return json(response, 403, { error: "sign_in_refused" });
        }
        throw error;
      }
      return whoIsHere(request, response, {
        token: entered.token,
        cookies: enteredCookies(entered.token, entered.days, source),
      });
    }
    if (path === "/api/signin/email/start") {
      const email = typeof body.email === "string" ? body.email.trim() : "";
      if (!EMAIL.test(email) || email.length > 254) return json(response, 400, { error: "bad_email" });
      try {
        await emailCode(settings, email);
      } catch (error) {
        if (error instanceof PlatformError && error.status < 500) return json(response, 400, { error: "bad_email" });
        throw error;
      }
      return json(response, 200, { sent: true });
    }
    if (path === "/api/signin/email/verify") {
      const email = typeof body.email === "string" ? body.email.trim() : "";
      const code = typeof body.code === "string" ? body.code.trim() : "";
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : null;
      if (!EMAIL.test(email) || !/^\d{6}$/.test(code)) return json(response, 400, { error: "bad_request" });
      const source = sourceOf(request);
      let entered;
      try {
        entered = await signInWithEmail(settings, email, code, name, source);
      } catch (error) {
        if (!(error instanceof PlatformError) || error.status >= 500) throw error;
        // A new address needs a name; a wrong or used code is refused.
        if (error.status === 400 && error.message.includes("name")) return json(response, 400, { error: "name_needed" });
        return json(response, 403, { error: "wrong_code" });
      }
      return whoIsHere(request, response, {
        token: entered.token,
        cookies: enteredCookies(entered.token, entered.days, source),
      });
    }
    const token = guardianToken(request);
    if (path === "/api/signout") {
      if (token) await signOut(settings, token).catch(() => undefined);
      response.writeHead(200, {
        ...headers,
        "Set-Cookie": [signedOutCookie(settings.basePath), recoveryCookie("", settings.basePath)],
        "Content-Type": "application/json; charset=utf-8",
      });
      return response.end(JSON.stringify({ signed_in: false }));
    }
    if (!token) return json(response, 401, { error: "not_signed_in" });
    const language = LANGUAGES.find((known) => known === body.language) ?? ("es" as Language);
    if (path === "/api/student") {
      const profile = profileFrom(body);
      // Nothing is created without the guardian's explicit yes on the page.
      if (!profile || body.consent !== true) return json(response, 400, { error: "bad_request" });
      const who = await account(settings, token);
      return json(response, 201, await createStudent(settings, token, who.familyId, profile));
    }
    if (path === "/api/account/erase") {
      // The address is typed again on the page; the platform checks it is theirs.
      if (typeof body.email !== "string" || !body.email.trim() || body.email.length > 320) {
        return json(response, 400, { error: "bad_request" });
      }
      try {
        await eraseAccount(settings, token, body.email.trim());
      } catch (error) {
        if (error instanceof PlatformError && error.status === 400) {
          return json(response, 400, { error: "wrong_email" });
        }
        throw error;
      }
      response.writeHead(200, {
        ...headers,
        "Set-Cookie": [signedOutCookie(settings.basePath), recoveryCookie("", settings.basePath)],
        "Content-Type": "application/json; charset=utf-8",
      });
      return response.end(JSON.stringify({ signed_in: false, erased: true }));
    }
    // Everything below is about one student of the guardian's family.
    const id = body.student_id;
    if (typeof id !== "string" || !ID.test(id)) return json(response, 400, { error: "bad_request" });
    if (path === "/api/student/read") return json(response, 200, await readStudent(settings, token, id));
    if (path === "/api/student/save") {
      const profile = profileFrom(body);
      if (!profile) return json(response, 400, { error: "bad_request" });
      return json(response, 200, await saveStudent(settings, token, id, profile));
    }
    if (path === "/api/student/known") return json(response, 200, await known(settings, token, id));
    // The student's latest sessions as facts, for the home (never what was said).
    if (path === "/api/student/sessions") return json(response, 200, await latestSessions(settings, token, id));
    if (path === "/api/student/forget") {
      if (typeof body.memory_id !== "string" || !ID.test(body.memory_id)) {
        return json(response, 400, { error: "bad_request" });
      }
      await forget(settings, token, id, body.memory_id);
      return json(response, 200, { forgotten: body.memory_id });
    }
    if (path === "/api/student/remove") {
      await removeStudent(settings, token, id);
      return json(response, 200, { removed: id });
    }
    // "/api/session" for a signed-in guardian.
    const objective = objectiveFrom(body.objective);
    if (objective === null) return json(response, 400, { error: "bad_request" });
    try {
      const previous = recoveryTicket(request);
      const saved = recoveries.get(previous, token);
      if (saved?.session.session_id) {
        const state = await platform(settings, `/v1/sessions/${saved.session.session_id}`, undefined, token) as { status: string; remaining_seconds: number };
        if (state.status !== "ended" && state.remaining_seconds > 0) {
          return json(response, 409, { error: "session_active" });
        }
      }
      if (!settings.freeAccess && !daily.take(token)) return json(response, 429, { error: "daily_limit" });
      const started = await startSession(settings, token, id, language, objective);
      const ticket = recoveries.remember(token, id, started);
      response.setHeader("Set-Cookie", recoveryCookie(ticket, settings.basePath, started.expiresInSeconds + STATUS_GRACE_SECONDS));
      return json(response, 200, started);
    } catch (error) {
      // The family's plan has no session left now; the platform says which limit.
      if (error instanceof PlatformError && error.status === 402) {
        return json(response, 402, { error: "plan_limit", reason: error.message });
      }
      throw error;
    }
  }

  // A session the engine runs: where it stands, and an answer written on the
  // page. A signed-in guardian asks with their own session; the team, with the
  // access code. The platform decides whose session it is.
  async function engine(path: string, request: IncomingMessage, response: ServerResponse) {
    if (!settings.platform) return json(response, 404, { error: "not_found" });
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch {
      return json(response, 400, { error: "bad_request" });
    }
    const token = guardianToken(request) ?? undefined;
    if (!token) {
      if (limiter.blocked()) return json(response, 429, { error: "too_many_attempts" });
      if (typeof body.code !== "string" || !sameCode(body.code, settings.accessCode)) {
        limiter.recordFailure();
        return json(response, 401, { error: "wrong_code" });
      }
    }
    const id = body.session_id;
    if (typeof id !== "string" || !ID.test(id)) return json(response, 400, { error: "bad_request" });
    try {
      if (path === "/api/step") return json(response, 200, await step(settings, id, token));
      const written = typeof body.answer === "string" ? body.answer.trim() : "";
      const explanation = typeof body.explanation === "string" ? body.explanation.trim() : "";
      if (!written || written.length > MAX_ANSWER_CHARS || explanation.length > MAX_EXPLANATION_CHARS) {
        return json(response, 400, { error: "bad_request" });
      }
      const sent = explanation ? { answer: written, explanation } : { answer: written };
      return json(response, 200, await answer(settings, id, sent, token));
    } catch (error) {
      // Not the engine's session, or it is over: the page stops asking.
      if (error instanceof PlatformError && [403, 404, 409].includes(error.status)) {
        return json(response, 409, { error: "no_step" });
      }
      throw error;
    }
  }

  async function session(path: string, request: IncomingMessage, response: ServerResponse) {
    if (limiter.blocked()) return json(response, 429, { error: "too_many_attempts" });
    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch {
      return json(response, 400, { error: "bad_request" });
    }
    if (typeof body.code !== "string" || !sameCode(body.code, settings.accessCode)) {
      limiter.recordFailure();
      return json(response, 401, { error: "wrong_code" });
    }
    const language = LANGUAGES.find((known) => known === body.language) ?? ("es" as Language);
    // With a platform, the page may also ask what the supervisor is doing.
    if (path === "/api/supervisor") {
      if (!settings.platform || typeof body.session_id !== "string") {
        return json(response, 404, { error: "not_found" });
      }
      return json(response, 200, await supervisorView(settings, body.session_id));
    }
    return json(response, 200, await createSession(settings, language));
  }

  // GitHub, Meta and Apple: "start" sends the person there, "callback" is where
  // they come back with a code. Whatever goes wrong, they land on the page,
  // which says so; the code itself is never logged.
  async function codeSignIn(
    provider: CodeProvider,
    step: string,
    query: URLSearchParams,
    request: IncomingMessage,
    response: ServerResponse,
  ) {
    if (!settings.platform || !settings.publicUrl) return json(response, 404, { error: "not_found" });
    const redirectUri = `${settings.publicUrl}${settings.basePath}/api/signin/${provider}/callback`;
    if (step === "start") {
      if (request.method !== "GET") return json(response, 405, { error: "method_not_allowed" });
      const clientId = (await signInProviders(settings))[provider];
      if (!clientId) return json(response, 404, { error: "not_found" });
      const state = newState();
      response.writeHead(303, {
        ...headers,
        "Set-Cookie": stateCookie(provider, state, settings.basePath),
        Location: authorizeUrl(provider, clientId, redirectUri, state),
      });
      return response.end();
    }
    let answer: URLSearchParams;
    if (request.method === "GET") {
      answer = query;
    } else if (request.method === "POST" && provider === "apple") {
      try {
        answer = new URLSearchParams(await readText(request, MAX_FORM_BYTES));
      } catch {
        return json(response, 400, { error: "bad_request" });
      }
    } else {
      return json(response, 405, { error: "method_not_allowed" });
    }
    const back = (cookies: string[], outcome?: string) => {
      response.writeHead(303, {
        ...headers,
        "Set-Cookie": [...cookies, clearedStateCookie(settings.basePath)],
        Location: `${settings.basePath}/${outcome ? `?signin=${outcome}` : ""}`,
      });
      response.end();
    };
    const code = answer.get("code");
    if (!stateMatches(request, provider, answer.get("state") ?? "")) return back([], "failed");
    // Without a code the person said no at the provider, or it failed there.
    if (!code) return back([], answer.get("error") ? "cancelled" : "failed");
    try {
      const source = sourceOf(request);
      const entered = await signInWithCode(settings, provider, code, redirectUri, appleName(answer.get("user")), source);
      return back(enteredCookies(entered.token, entered.days, source));
    } catch (error) {
      if (!(error instanceof PlatformError)) throw error;
      console.error(`sign-in with ${provider} failed: ${error.message}`);
      return back([], "failed");
    }
  }

  const server = createServer((request, response) => {
    const url = addressOf(request.url ?? "/");
    // Refused, never thrown: here, outside handle()'s catch, a throw ends the process.
    if (!url) return json(response, 400, { error: "bad_request" });
    // Doubled slashes are folded, so "/" as the base path and a probe of
    // "//healthz" mean the same thing.
    const pathname = url.pathname.replace(/\/{2,}/g, "/");
    const reading = request.method === "GET" || request.method === "HEAD";
    const redirect = (status: number, location: string) => {
      response.writeHead(status, { ...headers, Location: location });
      response.end();
    };
    // The team's old panel, as bookmarked, with or without the base path or a
    // trailing slash: the team's console, with nothing from the request.
    const panel = `${settings.basePath}/admin`;
    if (reading && [panel, `${panel}/`, ...(settings.basePath ? ["/admin", "/admin/"] : [])].includes(pathname)) {
      return redirect(302, TEAM_CONSOLE);
    }
    // The family guide is an address people type and share: with a trailing
    // slash, or without the base path, it still reaches the page, and keeps
    // the query (a guide's ?src=).
    for (const page of TYPED_PAGES) {
      const target = `${settings.basePath}${page}`;
      if (reading && (pathname === `${target}/` || (settings.basePath && [page, `${page}/`].includes(pathname)))) {
        return redirect(308, target + url.search);
      }
    }
    const missing = () => {
      const wantsPage = (request.headers.accept ?? "").split(",").some((type) => type.trim().split(";")[0] === "text/html");
      const api = ["/api", `${settings.basePath}/api`].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
      // Only a page visit comes home: missing API routes and files keep their error.
      if (reading && wantsPage && !api && !/\/[^/]*\.[^/]*$/.test(pathname)) {
        return redirect(302, `${settings.basePath}/`);
      }
      return json(response, 404, { error: "not_found" });
    };
    if (pathname === settings.basePath && settings.basePath) {
      return redirect(308, `${settings.basePath}/${url.search}`);
    }
    if (!pathname.startsWith(`${settings.basePath}/`)) {
      return missing();
    }
    const path = pathname.slice(settings.basePath.length);

    const handle = async () => {
      // Watchers read only the status; a person can read which build answers.
      if (path === "/healthz" && request.method === "GET") {
        return json(response, 200, { ok: true, version: VERSION, commit: settings.commit });
      }
      if (path === "/api/account" && request.method === "GET") return whoIsHere(request, response);
      if (["/api/session/recovery", "/api/session/resume", "/api/session/end"].includes(path)) {
        const expected = path === "/api/session/recovery" ? "GET" : "POST";
        if (request.method !== expected) return json(response, 405, { error: "method_not_allowed" });
        return lifecycle(path, request, response);
      }
      const signingIn = SIGN_IN_PATH.exec(path);
      if (signingIn) return codeSignIn(signingIn[1] as CodeProvider, signingIn[2]!, url.searchParams, request, response);
      if (
        path === "/api/signin" ||
        path === "/api/signin/email/start" ||
        path === "/api/signin/email/verify" ||
        path === "/api/signout" ||
        path === "/api/student" ||
        path === "/api/student/read" ||
        path === "/api/student/save" ||
        path === "/api/student/known" ||
        path === "/api/student/sessions" ||
        path === "/api/student/forget" ||
        path === "/api/student/remove" ||
        path === "/api/account/erase"
      ) {
        if (request.method !== "POST") return json(response, 405, { error: "method_not_allowed" });
        return signedIn(path, request, response);
      }
      if (path === "/api/step" || path === "/api/answer") {
        if (request.method !== "POST") return json(response, 405, { error: "method_not_allowed" });
        return engine(path, request, response);
      }
      if (path === "/api/session" || path === "/api/supervisor") {
        if (request.method !== "POST") return json(response, 405, { error: "method_not_allowed" });
        // Signed in, a session is for one of the family's students; the access
        // code stays as the team's way in, and the only way to the supervisor.
        if (path === "/api/session" && guardianToken(request)) return signedIn(path, request, response);
        return session(path, request, response);
      }
      const asset = reading ? await assetFor(SESSION_PAGE.test(path) ? "/" : path) : undefined;
      if (asset) {
        // A fingerprinted address is kept for a year and any other file is
        // checked against its ETag on every load. A page is never kept, so it
        // has nothing to be checked against.
        const cache = cacheFor(asset, url.searchParams.get("v"));
        const etag = cache === "no-store" ? undefined : `"${asset.hash}"`;
        // A family who has not signed in keeps the link it came from; a code
        // that is not a short lower-case one is ignored.
        const source = LINKED_PAGES.has(path) && !guardianToken(request) ? sourceCode(url.searchParams.get("src")) : null;
        const sent = {
          ...headers,
          "Cache-Control": cache,
          ...(etag ? { ETag: etag } : {}),
          ...(source ? { "Set-Cookie": sourceCookie(source, settings.basePath) } : {}),
        };
        if (etag && stillFresh(request.headers["if-none-match"], etag)) {
          response.writeHead(304, sent);
          return response.end();
        }
        response.writeHead(200, { ...sent, "Content-Type": asset.type });
        return response.end(asset.body);
      }
      return missing();
    };
    handle().catch((error: unknown) => {
      if (error instanceof PlatformError && !response.headersSent) {
        return json(response, 502, { error: "platform", message: error.message });
      }
      console.error("request failed:", error instanceof Error ? error.message : error);
      if (!response.headersSent) json(response, 500, { error: "internal" });
      else response.end();
    });
  });
  server.on("close", () => assets.close());
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let settings: Settings;
  try {
    settings = readSettings(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`aule-playground: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
  const server = createPlayground(settings);
  server.listen(settings.port, settings.host, () => {
    console.log(`aule-playground ${VERSION} (${settings.commit}) on http://${settings.host}:${settings.port}${settings.basePath}/`);
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
