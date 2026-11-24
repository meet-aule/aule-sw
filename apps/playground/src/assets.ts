// The page's own files, fingerprinted. Each is read once and given a hash of
// what it holds; asked for as "name?v=<hash>" it may be kept for a year, and
// every reference to it in the page, the stylesheet, the modules and the
// manifest says that address. A reload then downloads only the page, which is
// never kept (see cacheFor). A deploy or an edit changes the hashes, so
// nothing stale is ever kept.

import { createHash } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { readFile } from "node:fs/promises";

export type AssetSource = { file: string | URL; type: string };
export type Asset = { body: Buffer; type: string; hash: string };

// The files whose references are rewritten: the page's own text, never a
// package's bundle (those are versioned, but their contents are left alone).
const REWRITTEN = /^(text\/html|text\/css|application\/manifest\+json)/;
const OWN_SCRIPT = /^text\/javascript/;
const isPage = (type: string) => type.startsWith("text/html");

export function fingerprint(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 12);
}

const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A reference is a file's name in quotes or in url(): "style.css",
// './students.js', url("wall.png"), url(wall.png). In other brackets it is
// prose, like "(style.css)" in a comment: versioned, it would give the script a
// new address whenever the stylesheet changed. Pages are never versioned.
export function rewrite(text: string, versions: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [name, hash] of versions) {
    out = out.replace(new RegExp(`(["']|url\\()(\\./)?(${escape(name)})(?=["')])`, "g"), `$1$2$3?v=${hash}`);
  }
  return out;
}

/** Writes each value at its place, like the build's version at "{{version}}". */
export function stamp(text: string, values: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [place, value] of values) out = out.replaceAll(place, value);
  return out;
}

/**
 * Reads the files and settles their hashes. A file's hash depends on the
 * hashes it writes into its references, so they are worked out from the
 * leaves up, repeating until nothing changes. A file that cannot be read is
 * left out, and asking for it is a 404. Pages, and only pages, are stamped
 * with `stamps` (see build.ts): a page is never fingerprinted or kept, so what
 * it says about the build moves no other file's address.
 */
export async function loadAssets(
  sources: Record<string, AssetSource>,
  own: ReadonlySet<string>,
  stamps: ReadonlyMap<string, string> = new Map(),
): Promise<Map<string, Asset>> {
  const raw = new Map<string, { body: Buffer; type: string }>();
  await Promise.all(
    Object.entries(sources).map(async ([path, source]) => {
      try {
        raw.set(path, { body: await readFile(source.file), type: source.type });
      } catch {
        // Missing on disk: answered as not found.
      }
    }),
  );

  const rewritten = (path: string, type: string) => REWRITTEN.test(type) || (OWN_SCRIPT.test(type) && own.has(path));
  const versions = new Map<string, string>();
  const bodies = new Map<string, Buffer>();
  for (let round = 0; round < 10; round++) {
    let changed = false;
    for (const [path, { body, type }] of raw) {
      const next = rewritten(path, type) ? Buffer.from(rewrite(body.toString("utf8"), versions)) : body;
      if (isPage(type)) {
        bodies.set(path, Buffer.from(stamp(next.toString("utf8"), stamps)));
        continue;
      }
      bodies.set(path, next);
      const hash = fingerprint(next);
      const name = path.slice(1);
      if (versions.get(name) !== hash) {
        versions.set(name, hash);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const assets = new Map<string, Asset>();
  for (const [path, { type }] of raw) {
    const body = bodies.get(path) ?? Buffer.alloc(0);
    assets.set(path, { body, type, hash: fingerprint(body) });
  }
  return assets;
}

/**
 * How long a file may be kept: a fingerprinted address for a year, any other
 * file checked on every load. A page is never kept, whatever it is asked with:
 * kept, Back after signing out could show it again whole, with a child's name
 * or the families' emails, and an address with its hash would pin it.
 */
export function cacheFor(asset: Asset, version: string | null): string {
  if (isPage(asset.type)) return "no-store";
  return version === asset.hash ? "public, max-age=31536000, immutable" : "no-cache";
}

/**
 * What load() gives, kept until a file in dir changes; the next ask then loads
 * again. Deployed, nothing changes and it is read once; while working on the
 * page, an edit shows on the next reload. A folder that cannot be watched is
 * read once.
 */
export function keptUntilEdited<T>(dir: string | URL, load: () => Promise<T>): { get(): Promise<T>; close(): void } {
  let kept: Promise<T> | undefined;
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(dir, { persistent: false }, () => {
      kept = undefined;
    });
    // A watcher that fails stops watching; it must not take the server down.
    watcher.on("error", () => watcher?.close());
  } catch {
    // Not watchable here: read once.
  }
  return { get: () => (kept ??= load()), close: () => watcher?.close() };
}

/**
 * Whether a request's If-None-Match names this ETag. The comparison is the
 * weak one HTTP asks for here: Cloudflare marks the tag weak (W/"…") when it
 * compresses the file on the way out, and that still means the same file.
 */
export function stillFresh(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const bare = (tag: string) => tag.trim().replace(/^W\//, "");
  return ifNoneMatch.split(",").some((tag) => tag.trim() === "*" || bare(tag) === bare(etag));
}
