// Which build this is: the version in package.json, which scripts/version.py
// keeps equal to version.txt, and the commit the image was built from
// (AULE_COMMIT, read with the other settings in config.ts).

import { readFileSync } from "node:fs";

export const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string })
  .version;

/** A commit as people are shown it: its first seven characters. */
export const short = (commit: string) => commit.slice(0, 7);

/** What the console calls itself on every request to the platform, as the playground does. */
export const userAgent = (commit: string) => `aule-admin/${VERSION} (+${short(commit)})`;

/**
 * Where the pages show the build: two meta tags. Only pages are stamped (see
 * assets.ts), so a new build changes no fingerprinted file.
 */
export const stamps = (commit: string): ReadonlyMap<string, string> =>
  new Map([
    ["{{version}}", VERSION],
    ["{{commit}}", commit],
  ]);
