// Settings for the team's console, read from the environment once at start.
// Every problem is reported together, and the console does not start with one.
// It reads its own settings only: never the operator's token.

import { normalizedEmail } from "./team.ts";

/** Every name the console reads besides AULE_COMMIT, which comes from the image. */
export const SETTINGS = ["ADMIN_HOST", "ADMIN_PORT", "ADMIN_PUBLIC_URL", "ADMIN_EDGE_SECRET", "AULE_PLATFORM_URL", "AULE_ADMIN_EMAILS"] as const;

export type Settings = {
  host: string;
  port: number;
  /**
   * The console's own origin, like https://admin.meetaule.com: the one Origin
   * a write may carry. It is never compared with Host, which behind the
   * Worker names the server.
   */
  publicUrl: string;
  /**
   * What the console's Worker adds to every request it forwards (its
   * EDGE_SECRET). Set, every request without it is a 404, but the health
   * probe from this machine, and the client address the Worker passes on is
   * believed. Null on this machine for local work: then the console listens
   * on loopback only.
   */
  edgeSecret: string | null;
  /** Where the platform answers, without a trailing slash. */
  platformUrl: string;
  /** The team's addresses, normalized as the platform normalizes them. */
  team: ReadonlySet<string>;
  /**
   * The commit the image was built from (AULE_COMMIT), or "unknown". It goes
   * into pages, so only hex digits are taken.
   */
  commit: string;
};

export class ConfigError extends Error {}

// An https origin, or this machine over http for local work: no path, no query.
const PUBLIC_URL = /^(https:\/\/[a-z0-9.-]+(:\d{1,5})?|http:\/\/(localhost|127\.0\.0\.1):\d{1,5})$/;

/** Whether an address to listen on is this machine's alone. */
export const isLoopback = (host: string) => host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

export function readSettings(env: Record<string, string | undefined>): Settings {
  const get = (name: string, fallback = "") => env[name]?.trim() || fallback;
  const problems: string[] = [];

  const host = get("ADMIN_HOST", "127.0.0.1");
  if (!/^[\w.:-]+$/.test(host)) problems.push("ADMIN_HOST must be an address to listen on, like 127.0.0.1");

  const port = Number(get("ADMIN_PORT", "8092"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push("ADMIN_PORT must be a port number");

  const publicUrl = get("ADMIN_PUBLIC_URL", "https://admin.meetaule.com").replace(/\/+$/, "");
  if (!PUBLIC_URL.test(publicUrl)) {
    problems.push(
      "ADMIN_PUBLIC_URL must be the console's https:// origin, like https://admin.meetaule.com, or http://localhost:<port> to work locally",
    );
  }

  const edgeSecret = get("ADMIN_EDGE_SECRET");
  if (edgeSecret && !/^[\x21-\x7e]{32,}$/.test(edgeSecret)) {
    problems.push("ADMIN_EDGE_SECRET must be at least 32 printable characters with no spaces, like the output of openssl rand -hex 32");
  } else if (!edgeSecret && !isLoopback(host)) {
    // Listening beyond this machine, only the Worker's secret keeps anyone else out.
    problems.push("ADMIN_EDGE_SECRET must be set when ADMIN_HOST is not a loopback address");
  }

  const platformUrl = get("AULE_PLATFORM_URL").replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/.test(platformUrl)) problems.push("AULE_PLATFORM_URL must be an http:// or https:// URL");

  // Read as the platform reads it (config.rs): split on commas, trimmed,
  // lower-cased, empty ones dropped. A message never repeats an address.
  const listed = get("AULE_ADMIN_EMAILS")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email !== "");
  if (listed.length === 0) {
    problems.push("AULE_ADMIN_EMAILS must name at least one of the team's addresses");
  } else if (listed.some((email) => normalizedEmail(email) !== email)) {
    problems.push("AULE_ADMIN_EMAILS must be email addresses separated by commas");
  }
  const team: ReadonlySet<string> = new Set(listed);

  if (problems.length > 0) throw new ConfigError(problems.join("; "));

  const commit = get("AULE_COMMIT");
  return {
    host,
    port,
    publicUrl,
    edgeSecret: edgeSecret || null,
    platformUrl,
    team,
    commit: /^[0-9a-f]{7,40}$/.test(commit) ? commit : "unknown",
  };
}
