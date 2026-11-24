// Which build this is: the version in package.json, which scripts/version.py
// keeps equal to version.txt, and the commit the image was built from
// (AULE_COMMIT, read with the other settings in config.ts).

import { readFileSync } from "node:fs";

export const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string })
  .version;

/** A commit as people are shown it: its first seven characters. */
export const short = (commit: string) => commit.slice(0, 7);

/** What the playground calls itself on every request to the platform, as Anthropic's SDKs do. */
export const userAgent = (commit: string) => `aule-playground/${VERSION} (+${short(commit)})`;

/**
 * The last line of the family's account: the name, the version and the short
 * commit. Without a commit it stops at the version, so a family never reads
 * the English word "unknown" (the meta tag and the health probe still say it).
 */
export const buildLine = (commit: string) => (commit === "unknown" ? `Aule ${VERSION}` : `Aule ${VERSION} · ${short(commit)}`);

/**
 * Where the pages show the build, and what goes there: two meta tags and the
 * last line of the family's account. Only pages are stamped (see assets.ts),
 * so a new build changes no fingerprinted file.
 */
export const stamps = (commit: string): ReadonlyMap<string, string> =>
  new Map([
    ["{{version}}", VERSION],
    ["{{commit}}", commit],
    ["{{build}}", buildLine(commit)],
  ]);
