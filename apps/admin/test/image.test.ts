// The image starts the console with its own settings and nothing else: the env
// file every service shares also holds the operator's token, the database's
// password and the LiveKit secret, and none of them may reach the process.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { promisify } from "node:util";

import { SETTINGS } from "../src/config.ts";

const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
const cmd = dockerfile.split("\n").find((line) => line.startsWith("CMD "));

/** The command the image runs, as /bin/sh gets it. */
function command(): string {
  assert.ok(cmd, "the image has a CMD");
  const parts = JSON.parse(cmd.slice(4)) as string[];
  assert.deepEqual(parts.slice(0, 2), ["/bin/sh", "-c"]);
  return parts[2]!;
}

test("the process gets exactly the console's settings, the path, NODE_ENV and the commit", () => {
  const line = command();
  assert.match(line, /^exec env -i /, "exec, so Node is PID 1 with nothing inherited");
  assert.match(line, / node src\/server\.ts$/);
  const names = [...line.matchAll(/ ([A-Z_]+)=/g)].map(([, name]) => name).sort();
  assert.deepEqual(names, [...SETTINGS, "PATH", "NODE_ENV", "AULE_COMMIT"].sort());
  for (const name of [...SETTINGS, "PATH", "AULE_COMMIT"]) assert.ok(line.includes(`${name}="$${name}"`), name);
});

test("the Dockerfile never names a secret of the shared env file", () => {
  for (const secret of ["AULE_ADMIN_TOKEN", "DATABASE_URL", "POSTGRES_PASSWORD", "LIVEKIT_API_SECRET", "ANTHROPIC_API_KEY", "AULE_SMTP_URL"]) {
    assert.ok(!dockerfile.includes(secret), secret);
  }
});

test("run as the image runs it, the console sees only its own settings", async () => {
  // The CMD's own words through /bin/sh, with a shared env file's secrets around
  // it, printing what the process would see instead of starting the console.
  const node = `'${process.execPath.replaceAll("'", `'"'"'`)}'`;
  const line = command().replace(/ node src\/server\.ts$/, ` ${node} -e "console.log(Object.keys(process.env).sort().join(' '))"`);
  const { stdout } = await promisify(execFile)("/bin/sh", ["-c", line], {
    env: {
      PATH: process.env.PATH,
      AULE_COMMIT: "0123456789ab",
      AULE_PLATFORM_URL: "http://127.0.0.1:8091",
      AULE_ADMIN_EMAILS: "team@example.org",
      AULE_ADMIN_TOKEN: "operator-token",
      DATABASE_URL: "postgres://aule:secret@127.0.0.1:5433/aule",
      LIVEKIT_API_SECRET: "secret",
      ANTHROPIC_API_KEY: "key",
    },
  });
  // macOS adds its text encoding to every process it starts; Linux adds nothing.
  const seen = stdout.trim().split(" ").filter((name) => name !== "__CF_USER_TEXT_ENCODING");
  assert.deepEqual(seen, [...SETTINGS, "PATH", "NODE_ENV", "AULE_COMMIT"].sort());
});
