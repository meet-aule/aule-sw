// Who is on Aule's team: the addresses in AULE_ADMIN_EMAILS, the same list the
// platform reads. The console sends a sign-in code only to one of them; the
// platform's Staff check still decides every data call.

// What Rust's char::is_whitespace counts as a space (the White_Space property).
const SPACE = /[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;
const EDGES = /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu;

/** A text without the spaces at its ends, as Rust's str::trim takes them off. */
export const trimmed = (text: string) => text.replace(EDGES, "");

/**
 * An address as the platform keeps it (signin::normalized_email): trimmed and
 * lower-cased, one "@" with something before it and a dot inside the part
 * after it, no spaces, 254 bytes at most. Anything else is no address: null.
 */
export function normalizedEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = trimmed(value).toLowerCase();
  const parts = email.split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts as [string, string];
  const valid =
    local !== "" &&
    domain.includes(".") &&
    !domain.startsWith(".") &&
    !domain.endsWith(".") &&
    Buffer.byteLength(email, "utf8") <= 254 &&
    !SPACE.test(email);
  return valid ? email : null;
}
