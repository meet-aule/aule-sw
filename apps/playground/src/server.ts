// The playground's HTTP server: a static page and one endpoint that trades the
// access code for a room token. It keeps no state and stores nothing.

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GuessLimiter, sameCode } from "./access.ts";
import { ConfigError, LANGUAGES, readSettings, type Language, type Settings } from "./config.ts";
import {
  account,
  answer,
  createSession,
  eraseAccount,
  googleClient,
  PlatformError,
  signIn,
  signOut,
  step,
  supervisorView,
} from "./session.ts";
import {
  createStudent,
  forget,
  known,
  objectiveFrom,
  profileFrom,
  readStudent,
  readStudents,
  removeStudent,
  saveStudent,
  startSession,
} from "./students.ts";
import { DailyLimit, guardianToken, signedInCookie, signedOutCookie } from "./signin.ts";

const publicDir = new URL("../public/", import.meta.url);
// The browser build that ships inside the livekit-client package.
// Aule's animated face: one file with no imports and no network calls of its own.
const mascot = join(dirname(createRequire(import.meta.url).resolve("wobnimo/package.json")), "dist", "wobnimo.js");

const livekitClient = join(
  dirname(createRequire(import.meta.url).resolve("livekit-client")),
  "livekit-client.umd.js",
);

const STATIC: Record<string, { file: string | URL; type: string }> = {
  "/": { file: new URL("index.html", publicDir), type: "text/html; charset=utf-8" },
  "/app.js": { file: new URL("app.js", publicDir), type: "text/javascript; charset=utf-8" },
  "/students.js": { file: new URL("students.js", publicDir), type: "text/javascript; charset=utf-8" },
  "/signin.js": { file: new URL("signin.js", publicDir), type: "text/javascript; charset=utf-8" },
  "/visuals.js": { file: new URL("visuals.js", publicDir), type: "text/javascript; charset=utf-8" },
  "/tokens.css": { file: new URL("tokens.css", publicDir), type: "text/css; charset=utf-8" },
  "/style.css": { file: new URL("style.css", publicDir), type: "text/css; charset=utf-8" },
  // Inter, self-hosted: no font is fetched from anywhere else.
  "/fonts/InterVariable.woff2": { file: new URL("fonts/InterVariable.woff2", publicDir), type: "font/woff2" },
  "/fonts/Inter-LICENSE.txt": { file: new URL("fonts/Inter-LICENSE.txt", publicDir), type: "text/plain; charset=utf-8" },
  "/livekit-client.js": { file: livekitClient, type: "text/javascript; charset=utf-8" },
  "/wobnimo.js": { file: mascot, type: "text/javascript; charset=utf-8" },
};

const MAX_BODY_BYTES = 2_000;
// A Google credential is a signed token of a couple of thousand characters.
const MAX_SIGN_IN_BYTES = 8_000;
// A student's profile: a name, up to ten interests and a line from the family.
const MAX_PROFILE_BYTES = 4_000;
const ID = /^[0-9a-f-]{36}$/i;
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

export function createPlayground(settings: Settings): Server {
  const headers = securityHeaders(settings);
  const limiter = new GuessLimiter();
  const daily = new DailyLimit(settings.dailySessions);

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
    entered?: { token: string; cookie: string },
  ) {
    const extra = entered ? { "Set-Cookie": entered.cookie } : {};
    const reply = (body: unknown, more: Record<string, string> = {}) => {
      response.writeHead(200, { ...headers, ...extra, ...more, "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };
    if (!settings.platform) return reply({ google_client_id: null, signed_in: false });
    const token = entered?.token ?? guardianToken(request);
    const clientId = await googleClient(settings);
    if (!token) return reply({ google_client_id: clientId, signed_in: false });
    try {
      const who = await account(settings, token);
      const students = await readStudents(settings, token, who.students);
      return reply({
        google_client_id: clientId,
        signed_in: true,
        name: who.name,
        students,
        subjects: who.subjects,
      });
    } catch (error) {
      if (!(error instanceof PlatformError)) throw error;
      // A session the platform no longer knows: the page starts over signed out.
      return reply(
        { google_client_id: clientId, signed_in: false },
        { "Set-Cookie": signedOutCookie(settings.basePath) },
      );
    }
  }

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
      let entered;
      try {
        entered = await signIn(settings, body.credential);
      } catch (error) {
        if (error instanceof PlatformError && error.status < 500) {
          return json(response, 403, { error: "sign_in_refused" });
        }
        throw error;
      }
      return whoIsHere(request, response, {
        token: entered.token,
        cookie: signedInCookie(entered.token, settings.basePath, entered.days),
      });
    }
    const token = guardianToken(request);
    if (path === "/api/signout") {
      if (token) await signOut(settings, token).catch(() => undefined);
      response.writeHead(200, {
        ...headers,
        "Set-Cookie": signedOutCookie(settings.basePath),
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
        "Set-Cookie": signedOutCookie(settings.basePath),
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
    if (!daily.take(token)) return json(response, 429, { error: "daily_limit" });
    return json(response, 200, await startSession(settings, token, id, language, objective));
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

  return createServer((request, response) => {
    // Doubled slashes are folded, so "/" as the base path and a probe of
    // "//healthz" mean the same thing.
    const pathname = new URL(request.url ?? "/", "http://playground").pathname.replace(/\/{2,}/g, "/");
    if (pathname === settings.basePath && settings.basePath) {
      response.writeHead(308, { ...headers, Location: `${settings.basePath}/` });
      return response.end();
    }
    if (!pathname.startsWith(`${settings.basePath}/`)) {
      return json(response, 404, { error: "not_found" });
    }
    const path = pathname.slice(settings.basePath.length);

    const handle = async () => {
      if (path === "/healthz" && request.method === "GET") return json(response, 200, { ok: true });
      if (path === "/api/account" && request.method === "GET") return whoIsHere(request, response);
      if (
        path === "/api/signin" ||
        path === "/api/signout" ||
        path === "/api/student" ||
        path === "/api/student/read" ||
        path === "/api/student/save" ||
        path === "/api/student/known" ||
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
      const asset = STATIC[path];
      if (asset && request.method === "GET") {
        return send(response, 200, asset.type, await readFile(asset.file));
      }
      return json(response, 404, { error: "not_found" });
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
    console.log(`playground on http://${settings.host}:${settings.port}${settings.basePath}/`);
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
