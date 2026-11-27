// Hosted payments: guardian routes use their own session; the provider webhook
// forwards only its signature and resource id, never an operator credential.
import type { IncomingMessage } from "node:http";
import type { Settings } from "./config.ts";
import { LIMITS, readBody, type Answer } from "./passthrough.ts";
import { guardianToken } from "./signin.ts";
import { platform, PlatformError } from "./session.ts";

const reply = (status: number, body: unknown): Answer => ({ status, body: JSON.stringify(body), type: "application/json; charset=utf-8" });
const ACTIONS = new Set(["subscribe", "cancel", "refresh", "redeem"]);

export async function paymentRequest(request: IncomingMessage, settings: Settings, path: string, query: URLSearchParams): Promise<Answer> {
  if (!settings.platform) return reply(503, { error: "unavailable" });
  const webhook = path === "/api/payments/webhook";
  const action = path.slice("/api/billing/".length);
  const read = path === "/api/billing";
  if (!webhook && !read && !ACTIONS.has(action)) return reply(404, { error: "not_found" });
  if (request.method !== (read ? "GET" : "POST")) return reply(405, { error: "method_not_allowed" });
  const token = guardianToken(request);
  if (!webhook && !token) return reply(401, { error: "not_signed_in" });
  if (!webhook && !read) {
    try {
      const origin = request.headers.origin;
      const expected = settings.publicUrl ? new URL(settings.publicUrl).origin : `http://${request.headers.host}`;
      if (!origin || new URL(origin).origin !== expected) return reply(403, { error: "wrong_origin" });
    } catch { return reply(403, { error: "wrong_origin" }); }
  }
  if (!read && request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") return reply(415, { error: "json_required" });
  let body: Record<string, unknown> | undefined;
  if (!read) {
    const received = await readBody(request, LIMITS);
    if (typeof received === "string") return reply(received === "too large" ? 413 : 400, { error: "invalid_body" });
    try {
      body = JSON.parse(received.bytes.toString("utf8")) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400, { error: "invalid_body" });
    } catch { return reply(400, { error: "invalid_body" }); }
  }
  try {
    if (webhook) {
      const id = query.get("data.id");
      const signature = request.headers["x-signature"];
      const requestId = request.headers["x-request-id"];
      if (!id || query.getAll("data.id").length !== 1 || !/^[\w-]{1,200}$/.test(id) || typeof signature !== "string" || typeof requestId !== "string") return reply(401, { error: "invalid_signature" });
      const url = new URL(`${settings.platform.url}/v1/payments/webhook`);
      url.searchParams.set("data.id", id);
      const result = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-signature": signature, "x-request-id": requestId }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: "error" });
      return reply(result.status, result.ok ? { received: true } : { error: "webhook_refused" });
    }
    const result = await platform(settings, `/v1/me/billing${read ? "" : `/${action}`}`, body, token!);
    return reply(200, result);
  } catch (error) {
    return reply(error instanceof PlatformError ? error.status : 503, { error: "payment_unavailable" });
  }
}
