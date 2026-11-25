import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

import { ConfigError, readSettings, SETTINGS } from "../src/config.ts";
import { normalizedEmail } from "../src/team.ts";

const COMPLETE = { AULE_PLATFORM_URL: "http://127.0.0.1:8091", AULE_ADMIN_EMAILS: "team@example.org" };

const problems = (env: Record<string, string>) => {
  try {
    readSettings(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error.message;
  }
  return "";
};

test("reads a complete environment with defaults", () => {
  const settings = readSettings(COMPLETE);
  assert.equal(settings.host, "127.0.0.1");
  assert.equal(settings.port, 8092);
  assert.equal(settings.publicUrl, "https://admin.meetaule.com");
  assert.equal(settings.platformUrl, "http://127.0.0.1:8091");
  assert.deepEqual([...settings.team], ["team@example.org"]);
  assert.equal(settings.commit, "unknown");
  assert.equal(settings.edgeSecret, null);
  // Empty is the same as left out: the image passes every name, set or not.
  assert.deepEqual(readSettings({ ...COMPLETE, ADMIN_HOST: "", ADMIN_PORT: " ", ADMIN_PUBLIC_URL: "", ADMIN_EDGE_SECRET: " " }), settings);
});

test("reports every problem at once, each naming its setting", () => {
  const message = problems({ ADMIN_HOST: "0.0.0.0 x", ADMIN_PORT: "99999", ADMIN_PUBLIC_URL: "admin.example.org" });
  for (const name of ["ADMIN_HOST", "ADMIN_PORT", "ADMIN_PUBLIC_URL", "ADMIN_EDGE_SECRET", "AULE_PLATFORM_URL", "AULE_ADMIN_EMAILS"]) {
    assert.match(message, new RegExp(`${name} must`), name);
  }
  assert.equal(message.split("; ").length, 6);
});

test("the team's addresses are read as the platform reads them, and a message never repeats one", () => {
  assert.deepEqual([...readSettings({ ...COMPLETE, AULE_ADMIN_EMAILS: " Team@Example.org , " }).team], ["team@example.org"]);
  assert.deepEqual(
    [...readSettings({ ...COMPLETE, AULE_ADMIN_EMAILS: "a@example.org,B@Example.org,a@example.org" }).team],
    ["a@example.org", "b@example.org"],
  );
  for (const list of ["", " , ", ","]) {
    assert.match(problems({ ...COMPLETE, AULE_ADMIN_EMAILS: list }), /AULE_ADMIN_EMAILS must name at least one/, JSON.stringify(list));
  }
  for (const list of ["ana@example.org, not-an-address", "ana@example.org;luis@example.org", "luis @example.org"]) {
    const message = problems({ ...COMPLETE, AULE_ADMIN_EMAILS: list });
    assert.match(message, /AULE_ADMIN_EMAILS must be email addresses separated by commas/);
    assert.doesNotMatch(message, /ana|luis|not-an-address|@/, "no address in the message");
  }
});

test("an address is normalized as signin::normalized_email does", () => {
  assert.equal(normalizedEmail(" Ana@Example.ORG "), "ana@example.org");
  for (const odd of ["", "ana", "@example.org", "ana@", "ana@example", "ana@.example.org", "ana@example.org.", "a@b@example.org", "an a@example.org", `${"a".repeat(250)}@example.org`, 42, null]) {
    assert.equal(normalizedEmail(odd), null, String(odd));
  }
});

test("the public address is the console's https origin, or this machine with a port", () => {
  for (const [given, kept] of [
    ["https://admin.example.org/", "https://admin.example.org"],
    ["https://admin.example.org:8443", "https://admin.example.org:8443"],
    ["http://localhost:8092", "http://localhost:8092"],
    ["http://127.0.0.1:8092/", "http://127.0.0.1:8092"],
  ]) {
    assert.equal(readSettings({ ...COMPLETE, ADMIN_PUBLIC_URL: given }).publicUrl, kept, given);
  }
  for (const odd of ["http://admin.example.org", "https://admin.example.org/panel", "https://admin.example.org?x=1", "https://Admin.example.org", "http://localhost", "javascript:alert(1)", "https://"]) {
    assert.match(problems({ ...COMPLETE, ADMIN_PUBLIC_URL: odd }), /ADMIN_PUBLIC_URL/, odd);
  }
});

test("listening beyond this machine takes the Worker's secret, a long one, never repeated in a message", () => {
  const secret = "0123456789abcdef0123456789abcdef";
  for (const host of ["0.0.0.0", "::", "203.0.113.5"]) {
    assert.match(problems({ ...COMPLETE, ADMIN_HOST: host }), /ADMIN_EDGE_SECRET must be set when ADMIN_HOST is not a loopback address/, host);
    assert.equal(readSettings({ ...COMPLETE, ADMIN_HOST: host, ADMIN_EDGE_SECRET: ` ${secret} ` }).edgeSecret, secret, host);
  }
  for (const host of ["127.0.0.1", "localhost", "::1", "127.0.0.2"]) assert.equal(readSettings({ ...COMPLETE, ADMIN_HOST: host }).edgeSecret, null, host);
  for (const odd of ["short-secret", `${secret.slice(0, 16)} ${secret.slice(16)}`, `${secret}\u00e9`]) {
    const message = problems({ ...COMPLETE, ADMIN_EDGE_SECRET: odd });
    assert.match(message, /ADMIN_EDGE_SECRET must be at least 32 printable characters/, odd);
    assert.ok(!message.includes(odd) && !message.includes(secret.slice(0, 16)), "the secret is not in the message");
  }
});

test("the platform's address is http or https, kept without its trailing slash", () => {
  assert.equal(readSettings({ ...COMPLETE, AULE_PLATFORM_URL: "http://127.0.0.1:8091/" }).platformUrl, "http://127.0.0.1:8091");
  assert.match(problems({ ...COMPLETE, AULE_PLATFORM_URL: "127.0.0.1:8091" }), /AULE_PLATFORM_URL/);
});

test("AULE_COMMIT is taken only when it is a commit; otherwise the commit is unknown", () => {
  assert.equal(readSettings({ ...COMPLETE, AULE_COMMIT: " 0123456789ab " }).commit, "0123456789ab");
  assert.equal(readSettings({ ...COMPLETE, AULE_COMMIT: "a".repeat(40) }).commit, "a".repeat(40));
  for (const odd of ["unknown", "abc12", "0123456789AB", '"><script>', "0123456789ab-dirty", "a".repeat(41)]) {
    assert.equal(readSettings({ ...COMPLETE, AULE_COMMIT: odd }).commit, "unknown", odd);
  }
});

test("the console reads only its own settings: never the operator's token or the database's", async () => {
  assert.deepEqual([...SETTINGS], ["ADMIN_HOST", "ADMIN_PORT", "ADMIN_PUBLIC_URL", "ADMIN_EDGE_SECRET", "AULE_PLATFORM_URL", "AULE_ADMIN_EMAILS"]);
  const dir = new URL("../src/", import.meta.url);
  for (const name of await readdir(dir)) {
    const source = await readFile(new URL(name, dir), "utf8");
    for (const secret of ["AULE_ADMIN_TOKEN", "DATABASE_URL", "LIVEKIT_API_SECRET", "POSTGRES_PASSWORD"]) {
      assert.ok(!source.includes(secret), `${name} names ${secret}`);
    }
    // Every name read from the environment is one of SETTINGS, or the image's commit.
    for (const [, read] of source.matchAll(/get\("([A-Z_]+)"/g)) {
      assert.ok([...SETTINGS, "AULE_COMMIT"].includes(read as (typeof SETTINGS)[number]), `${name} reads ${read}`);
    }
  }
});

test("only log.ts writes to the console's output", async () => {
  const dir = new URL("../src/", import.meta.url);
  for (const name of await readdir(dir)) {
    if (name === "log.ts") continue;
    assert.doesNotMatch(await readFile(new URL(name, dir), "utf8"), /\bconsole\.(log|info|warn|error|debug|trace|dir)\b|process\.std(out|err)\b/, name);
  }
});
