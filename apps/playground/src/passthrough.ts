// The family app (meet-aule/aule-app) reaches the platform here: <base
// path>/api/v1/<path> goes on to the platform's /v1/<path>, for the routes the
// app calls and no other. The app holds a guardian's bearer token, never a
// cookie, so that token is the only credential that goes on: of the request's
// headers only Authorization and Content-Type are passed, and a cookie, an
// address or anything else it carried stays here. The operator's token is
// refused, so is a request with no bearer outside signing in, and so is every
// route the app has no use for: starting a session, the team's, the metrics,
// the agent's, the devices' own and the health check. Nothing of a request is
// logged but its route's shape.

import type { IncomingMessage } from "node:http";

import { sameCode } from "./access.ts";
import { userAgent } from "./build.ts";
import type { Settings } from "./config.ts";
import { isSessionToken } from "./signin.ts";

type Method = "GET" | "POST" | "PUT" | "DELETE";

/**
 * A route the app calls, as the platform names it after /v1/. `{id}` is an id
 * as the platform writes them, `open` a route for signing in, which has no
 * bearer to send yet, and `query` the numbers the route may be asked with.
 */
export type Route = { method: Method; path: string; open?: true; query?: readonly string[] };

// The calls of the app's lib/core/api/http_aule_api.dart and
// lib/features/device/data/http_device_api.dart. Joining a live session comes
// with its own routes on the platform, and goes here with them.
export const ROUTES: readonly Route[] = [
  { method: "POST", path: "auth/start", open: true },
  { method: "POST", path: "auth/verify", open: true },
  { method: "GET", path: "auth/google", open: true },
  { method: "POST", path: "auth/google", open: true },
  { method: "POST", path: "auth/signout" },
  { method: "GET", path: "me" },
  { method: "PUT", path: "me" },
  { method: "DELETE", path: "me" },
  { method: "POST", path: "families/{id}/children" },
  { method: "GET", path: "children/{id}" },
  { method: "PUT", path: "children/{id}" },
  { method: "DELETE", path: "children/{id}" },
  { method: "POST", path: "children/{id}/consents" },
  { method: "GET", path: "children/{id}/reviews" },
  { method: "GET", path: "children/{id}/skills" },
  { method: "GET", path: "children/{id}/sessions", query: ["limit"] },
  { method: "GET", path: "children/{id}/memories", query: ["limit"] },
  { method: "DELETE", path: "children/{id}/memories/{id}" },
  { method: "GET", path: "skills" },
  // How a session stands, and ending it; never starting one.
  { method: "GET", path: "sessions/{id}" },
  { method: "POST", path: "sessions/{id}/end" },
  { method: "GET", path: "notices" },
  { method: "POST", path: "notices/{id}/read" },
  { method: "GET", path: "devices" },
  { method: "POST", path: "devices/claim" },
  { method: "PUT", path: "devices/{id}" },
  { method: "DELETE", path: "devices/{id}" },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The route a request is, from its method and what follows /v1/, or undefined
 * when the app has none like it. Each part is a word of the route or an id, so
 * what goes on to the platform has nothing else in it: no dots, no escapes.
 */
export function routeOf(method: string, path: string): Route | undefined {
  const parts = path.split("/");
  return ROUTES.find((route) => {
    const wanted = route.path.split("/");
    return (
      route.method === method &&
      wanted.length === parts.length &&
      wanted.every((word, index) => (word === "{id}" ? UUID.test(parts[index] ?? "") : word === parts[index]))
    );
  });
}

/** The query to send on: what the route takes, each once and a number; null for anything else. */
function queryFor(route: Route, query: URLSearchParams): string | null {
  const kept = new URLSearchParams();
  for (const [name, value] of query) {
    if (!route.query?.includes(name) || kept.has(name) || !/^\d{1,3}$/.test(value)) return null;
    kept.set(name, value);
  }
  const text = kept.toString();
  return text ? `?${text}` : "";
}

/** The token of an Authorization header: undefined with no header, null when it is not a session's bearer. */
function bearerOf(header: string | undefined): string | null | undefined {
  if (header === undefined) return undefined;
  const token = /^Bearer (\S+)$/.exec(header)?.[1];
  return token !== undefined && isSessionToken(token) ? token : null;
}

export type Limits = {
  /** The largest body passed on. The app's largest is a child's profile, a few KiB. */
  bodyBytes: number;
  /** How long a request may take to send its body. */
  bodyMs: number;
  /** How long the platform may take to answer, body and all. */
  platformMs: number;
};

export const LIMITS: Limits = { bodyBytes: 16_384, bodyMs: 10_000, platformMs: 10_000 };

/** What to answer: the platform's own answer, or a refusal in its error shape. */
export type Answer = { status: number; body: Buffer | string; type?: string; close?: true };

const JSON_TYPE = "application/json; charset=utf-8";

const refused = (status: number, code: string, message: string, close?: true): Answer => ({
  status,
  type: JSON_TYPE,
  body: JSON.stringify({ error: { code, message } }),
  ...(close ? { close } : {}),
});

// As the platform says it for a wrong token, so the operator's token gets the
// answer any wrong token gets.
const UNAUTHORIZED = refused(401, "unauthorized", "missing or wrong credentials");
const NOT_FOUND = refused(404, "not_found", "route not found");
const NOT_JSON = refused(400, "bad_request", "the body must be JSON with Content-Type: application/json");

type Body = { bytes: Buffer } | "too large" | "gone";

export async function readBody(request: IncomingMessage, limits: Limits): Promise<Body> {
  if (Number(request.headers["content-length"] ?? 0) > limits.bodyBytes) return "too large";
  // A body sent slower than this loses its connection: trickling bytes cannot
  // hold one open.
  const timer = setTimeout(() => request.destroy(), limits.bodyMs);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    // What is left past the limit is not read: that answer closes the connection.
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      size += (chunk as Buffer).length;
      if (size > limits.bodyBytes) return "too large";
      chunks.push(chunk as Buffer);
    }
  } catch {
    return "gone";
  } finally {
    clearTimeout(timer);
  }
  return request.complete ? { bytes: Buffer.concat(chunks) } : "gone";
}

const isJson = (type: string | undefined) => type?.split(";")[0]?.trim().toLowerCase() === "application/json";

/**
 * Answers a request for `<base path>/api/v1/<path>` with the platform's answer
 * to `/v1/<path>`, or refuses it. Null when the client went away before its
 * body was in, so there is no one to answer.
 */
export function appApi(settings: Settings, limits: Limits = LIMITS) {
  return async (request: IncomingMessage, path: string, query: URLSearchParams): Promise<Answer | null> => {
    const platform = settings.platform;
    const route = platform ? routeOf(request.method ?? "", path) : undefined;
    if (!platform || !route) return NOT_FOUND;
    const token = bearerOf(request.headers.authorization);
    if (token === null || (token === undefined && !route.open)) return UNAUTHORIZED;
    if (token !== undefined && sameCode(token, platform.adminToken)) {
      // Only the operator's own token gets here: it is out where it should not be.
      console.error("app api: refused the operator's token");
      return UNAUTHORIZED;
    }
    const search = queryFor(route, query);
    if (search === null) return refused(400, "bad_request", "the query is not one this route takes");
    let body: Uint8Array<ArrayBuffer> | undefined;
    if (route.method !== "GET") {
      const read = await readBody(request, limits);
      if (read === "gone") return null;
      if (read === "too large") return refused(413, "too_large", `the body must be ${limits.bodyBytes} bytes at most`, true);
      if (read.bytes.length > 0) {
        if (!isJson(request.headers["content-type"])) return NOT_JSON;
        body = new Uint8Array(read.bytes);
      }
    }
    try {
      const answer = await fetch(`${platform.url}/v1/${path}${search}`, {
        method: route.method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
          // Which build asks, as on every other call to the platform.
          "User-Agent": userAgent(settings.commit),
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(limits.platformMs),
      });
      const bytes = Buffer.from(await answer.arrayBuffer());
      return { status: answer.status, body: bytes, type: answer.headers.get("content-type") ?? undefined };
    } catch {
      console.error(`app api: the platform did not answer ${route.method} /v1/${route.path}`);
      return refused(503, "unavailable", "the platform did not answer; try again");
    }
  };
}
