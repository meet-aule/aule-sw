// The console's log: one fixed event per line, with numbers and yes-or-no
// fields only. No free text reaches it, so an address, a code, a token, a
// cookie, a request's body or address, or the words of a platform error never
// do either. This is the only file that writes to the console.

import type { ConfigError } from "./config.ts";

const EVENTS = [
  "code_requested",
  "code_not_sent",
  "signed_in",
  "signed_out",
  "passkey_created",
  "passkey_deleted",
  "session_ended",
  "revoke_failed",
  "platform_error",
  "request_failed",
] as const;

export type LogEvent = (typeof EVENTS)[number];

// Something that went wrong, for the error stream; the rest is ordinary use.
const PROBLEMS: ReadonlySet<LogEvent> = new Set(["code_not_sent", "revoke_failed", "platform_error", "request_failed"]);

export function log(event: LogEvent, fields: Readonly<Record<string, number | boolean>> = {}): void {
  const line = [`aule-admin: ${event}`];
  for (const [name, value] of Object.entries(fields)) {
    // Names are the code's own; a value is a number or a boolean by its type,
    // and checked again here so nothing else can slip through.
    if (/^[a-z_]+$/.test(name) && (typeof value === "boolean" || Number.isFinite(value))) line.push(`${name}=${value}`);
  }
  (PROBLEMS.has(event) ? console.error : console.log)(line.join(" "));
}

/** Why the console did not start. A setting's problem names the setting, never its value. */
export function logConfigProblem(error: ConfigError): void {
  console.error(`aule-admin: ${error.message}`);
}

/** The first line, as the playground's: the build, and where it listens. */
export function logStart(version: string, commit: string, host: string, port: number): void {
  console.log(`aule-admin ${version} (${commit}) on http://${host}:${port}/`);
}
