// What the console passes on of a passkey ceremony. As for every other write
// (api.ts), nothing goes to the platform as it came: a credential the browser
// made or used is built again from the fields webauthn-rs reads, each checked
// for its shape and its length, and a name is checked as the platform checks
// it. The platform checks all of it again: it is the authority.

import { CEREMONY_HANDLE } from "./sessions.ts";
import { trimmed } from "./team.ts";

/** A passkey's name, in characters, as the platform counts them. */
export const MAX_LABEL_CHARS = 60;

// base64url, as the browser's toJSON() writes binary fields.
const B64URL = /^[A-Za-z0-9_-]+$/;
// A credential id is 1,023 bytes at most (WebAuthn's longest).
const MAX_ID_CHARS = 1_368;
// The transports WebAuthn names; any other is left out.
const TRANSPORTS = new Set(["usb", "nfc", "ble", "smart-card", "hybrid", "internal"]);

type Fields = Record<string, unknown>;
const isObject = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const encoded = (value: unknown, most: number): string | null =>
  typeof value === "string" && value.length <= most && B64URL.test(value) ? value : null;

/** The id a credential names, the same as its rawId, and its response; null when it is not a passkey's. */
function credentialParts(value: unknown): { id: string; response: Fields } | null {
  if (!isObject(value) || value.type !== "public-key" || !isObject(value.response)) return null;
  const id = encoded(value.id, MAX_ID_CHARS);
  return id && value.rawId === id ? { id, response: value.response } : null;
}

/**
 * A passkey the browser created (`credential.toJSON()` after
 * `navigator.credentials.create`), as the platform reads it, or null.
 */
export function createdPasskey(value: unknown): Fields | null {
  const parts = credentialParts(value);
  if (!parts || !isObject(value)) return null;
  const clientDataJSON = encoded(parts.response.clientDataJSON, 4_096);
  const attestationObject = encoded(parts.response.attestationObject, 8_192);
  if (!clientDataJSON || !attestationObject) return null;
  const transports = parts.response.transports;
  if (transports !== undefined && !Array.isArray(transports)) return null;
  const known = [...new Set((transports ?? []).filter((transport) => typeof transport === "string" && TRANSPORTS.has(transport)))];
  // Whether the browser made a discoverable passkey: the platform refuses one it says is not.
  const extensions = value.clientExtensionResults;
  const rk = isObject(extensions) && isObject(extensions.credProps) ? extensions.credProps.rk : undefined;
  if (rk !== undefined && typeof rk !== "boolean") return null;
  return {
    id: parts.id,
    rawId: parts.id,
    type: "public-key",
    response: { clientDataJSON, attestationObject, ...(known.length > 0 ? { transports: known } : {}) },
    clientExtensionResults: rk === undefined ? {} : { credProps: { rk } },
  };
}

/**
 * A passkey's answer to a sign-in (`credential.toJSON()` after
 * `navigator.credentials.get`), as the platform reads it, or null. A
 * discoverable passkey always says whose it is: the user handle is required.
 */
export function usedPasskey(value: unknown): Fields | null {
  const parts = credentialParts(value);
  if (!parts) return null;
  const authenticatorData = encoded(parts.response.authenticatorData, 4_096);
  const clientDataJSON = encoded(parts.response.clientDataJSON, 4_096);
  const signature = encoded(parts.response.signature, 1_024);
  const userHandle = encoded(parts.response.userHandle, 88);
  if (!authenticatorData || !clientDataJSON || !signature || !userHandle) return null;
  return {
    id: parts.id,
    rawId: parts.id,
    type: "public-key",
    response: { authenticatorData, clientDataJSON, signature, userHandle },
    clientExtensionResults: {},
  };
}

/** A passkey's name as the platform keeps it: trimmed, 1 to 60 characters, one line. Null for anything else. */
export function passkeyLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = trimmed(value);
  const length = [...label].length;
  return length >= 1 && length <= MAX_LABEL_CHARS && !/\p{Cc}/u.test(label) ? label : null;
}

/** A ceremony the platform started: its handle, for the cookie, and the options, for the page. */
export type Started = { ceremony: string; publicKey: Fields };

/** The platform's `{ceremony, options: {publicKey}}`, checked, or null. */
export function startedCeremony(answer: unknown): Started | null {
  if (!isObject(answer) || typeof answer.ceremony !== "string" || !CEREMONY_HANDLE.test(answer.ceremony)) return null;
  const options = answer.options;
  if (!isObject(options) || !isObject(options.publicKey)) return null;
  return { ceremony: answer.ceremony, publicKey: options.publicKey };
}
