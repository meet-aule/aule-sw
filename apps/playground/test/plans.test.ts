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
const asked: { method: string; path: string; body: unknown }[] = [];
const platform = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  const body = text ? JSON.parse(text) : null;
  const path = request.url ?? "";
  asked.push({ method: request.method ?? "", path, body });
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
  if (path.startsWith("/v1/admin/") || path.startsWith("/v1/metrics/")) {
    if (!team) return answer(403, { error: { code: "forbidden", message: "this route is for Aule's team" } });
    if (path === "/v1/admin/families") return answer(200, { families: [{ id: FAMILY, name: "Quispe" }] });
    if (path.startsWith("/v1/metrics/daily")) return answer(200, { days: [] });
    if (path === "/v1/metrics/weekly?weeks=12") {
      return answer(200, { timezone_offset_minutes: -300, weeks: 12, cohorts: [{ week: "2026-11-23", source: "cesar", families: 2 }] });
    }
    if (path === `/v1/admin/families/${FAMILY}/grant`) return answer(request.method === "DELETE" ? 200 : 201, { plan: "granted" });
  }
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

test("the team's panel answers only the team", async () => {
  assert.equal((await fetch(`${base}/api/admin/families`)).status, 401);
  const family = await fetch(`${base}/api/admin/families`, { headers: as(FAMILY_TOKEN) });
  assert.deepEqual([family.status, await family.json()], [403, { error: "not_team" }]);

  const team = await fetch(`${base}/api/admin/families`, { headers: as(TEAM_TOKEN) });
  assert.deepEqual(await team.json(), { families: [{ id: FAMILY, name: "Quispe" }] });
  assert.equal((await fetch(`${base}/api/admin/metrics`, { headers: as(TEAM_TOKEN) })).status, 200);
});

test("the pilot's weekly numbers are the team's only, for the last twelve weeks", async () => {
  assert.equal((await fetch(`${base}/api/admin/weekly`)).status, 401);
  const family = await fetch(`${base}/api/admin/weekly`, { headers: as(FAMILY_TOKEN) });
  assert.deepEqual([family.status, await family.json()], [403, { error: "not_team" }]);

  const team = await fetch(`${base}/api/admin/weekly`, { headers: as(TEAM_TOKEN) });
  assert.equal(team.status, 200);
  assert.deepEqual((await team.json()).cohorts, [{ week: "2026-11-23", source: "cesar", families: 2 }]);
  assert.equal((await fetch(`${base}/api/admin/weekly`, { method: "POST", headers: as(TEAM_TOKEN) })).status, 404);
});

test("granting and ending a plan pass on only what the platform needs", async () => {
  assert.equal((await post("admin/grant", { family_id: "../me", days: 30 }, TEAM_TOKEN)).status, 400);
  assert.equal((await post("admin/grant", { family_id: FAMILY, days: "30" }, TEAM_TOKEN)).status, 400);
  asked.length = 0;

  const granted = await post("admin/grant", { family_id: FAMILY, days: 30, note: " piloto ", extra: 1 }, TEAM_TOKEN);
  assert.equal(granted.status, 201);
  const ended = await post("admin/ungrant", { family_id: FAMILY }, TEAM_TOKEN);
  assert.equal(ended.status, 200);

  assert.deepEqual(
    asked.filter((call) => call.path.startsWith("/v1/admin/")).map(({ method, body }) => [method, body]),
    [
      ["POST", { days: 30, note: "piloto" }],
      ["DELETE", null],
    ],
  );
});
