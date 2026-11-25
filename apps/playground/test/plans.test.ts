import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { readSettings } from "../src/config.ts";
import { createPlayground } from "../src/server.ts";
import { COMPLETE } from "./fixtures.ts";

const FAMILY_TOKEN = "ef".repeat(32);
const TEAM_TOKEN = "fe".repeat(32);
const STUDENT = "01a1f5f4-ede7-7028-a524-9d8e2f36b92c";
const FAMILY = "01a1f5f4-ede7-7028-a524-9d8e2f36b92d";

// Stands in for the platform: one family on a plan with nothing left this
// week, and one team member.
const platform = createServer((request, response) => {
  const path = request.url ?? "";
  const answer = (status: number, value: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  };
  const auth = request.headers.authorization;
  if (path === "/v1/auth/providers") return answer(200, { google: "client-1", github: null, meta: null, apple: null });
  const team = auth === `Bearer ${TEAM_TOKEN}`;
  if (!team && auth !== `Bearer ${FAMILY_TOKEN}`) return answer(401, { error: { message: "who?" } });
  if (path === "/v1/me") return answer(200, { guardian: { name: "Ana" }, family_id: FAMILY, children: [] });
  if (path === "/v1/me/plan") {
    return answer(200, { plan: "granted", ends_at: "2026-12-20T00:00:00Z", used: 3, allowed: 3, left: 0, period: "week", team });
  }
  if (path === "/v1/sessions") return answer(402, { error: { code: "plan_limit", message: "week_used" } });
  answer(404, { error: { message: "no such path" } });
});

let base = "";
let server: ReturnType<typeof createPlayground>;

before(async () => {
  await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;
  server = createPlayground(readSettings({ ...COMPLETE, AULE_PLATFORM_URL: url, AULE_ADMIN_TOKEN: "admin" }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/playground`;
});
after(() => {
  server.close();
  platform.close();
});

const as = (token: string) => ({ Cookie: `aule_guardian=${token}` });
const post = (path: string, body: unknown, token?: string) =>
  fetch(`${base}/api/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? as(token) : {}) },
    body: JSON.stringify(body),
  });

test("the page is told the family's plan, and whether the person is on the team", async () => {
  const family = await (await fetch(`${base}/api/account`, { headers: as(FAMILY_TOKEN) })).json();
  assert.deepEqual(family.plan, {
    plan: "granted",
    ends_at: "2026-12-20T00:00:00Z",
    used: 3,
    allowed: 3,
    left: 0,
    period: "week",
  });
  assert.equal(family.team, false);
  assert.equal((await (await fetch(`${base}/api/account`, { headers: as(TEAM_TOKEN) })).json()).team, true);
});

test("a session the plan has no room for says which limit", async () => {
  const response = await post("session", { student_id: STUDENT, language: "es" }, FAMILY_TOKEN);

  assert.equal(response.status, 402);
  assert.deepEqual(await response.json(), { error: "plan_limit", reason: "week_used" });
});
