// The fixed words for how a session ends, for one a reload left open and for
// one whose tutor did not arrive, in the session's language. They show on the
// student's screens, in web-only states the Figma does not draw (FIGMA.md): the
// end screen after A15, A05's «¿Seguimos donde nos quedamos?» and the session
// waiting for Aule. So they speak as the device does and as the tutor's own
// lines (apps/agent replies.py) do: to the student, one short sentence each
// (D33), warm, and without an exclamation mark. They never carry a provider's
// exception or anything the session held.

import { SOURCE, keysOf, languageOf, wordsIn } from "./i18n.js";

// The words themselves are with the page's others (words/es.js `ending` and
// `recovery`, and the same groups of each language), and are asked for here in
// the session's language, never the interface's.

/** Every way a session ends that has words of its own, "unknown" included. */
export const ENDINGS = keysOf("ending");

// The language the words for a session are in: its own when the page has words
// in it, else Spanish. The page marks each element it writes them into with it
// (lang), since the page itself may be in another.
export { languageOf };

/** What the end screen says under «La sesión terminó.» for the platform's end_reason; "unknown"'s words for one it has none for. */
export function endedMessage(reason, language = SOURCE) {
  return wordsIn(language, `ending.${reason}`) || wordsIn(language, "ending.unknown");
}

/** Every key of the recovery's words; each is in every language. */
export const RECOVERY_KEYS = keysOf("recovery");

/** The recovery's words for `key`; "failed"'s for anything else. */
export function recoveryMessage(key, language = SOURCE) {
  return wordsIn(language, `recovery.${key}`) || wordsIn(language, "recovery.failed");
}
