import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { readSettings } from "../src/config.ts";
import { createPlayground } from "../src/server.ts";
import { COMPLETE } from "./fixtures.ts";

const token = `${"a".repeat(32)}.1800000000.es.${"b".repeat(64)}`;
const requests: { token: string; cookie?: string; authorization?: string }[] = [];
let status = 204;
const backend = createServer(async (request, response) => {
  assert.equal(request.url, "/v1/notices/unsubscribe");
  assert.equal(request.method, "POST");
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push({ token: body.token, cookie: request.headers.cookie, authorization: request.headers.authorization });
  response.writeHead(status).end();
});
let app: ReturnType<typeof createPlayground>;
let url: string;
before(async () => {
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
  const settings = readSettings({ ...COMPLETE, AULE_PLATFORM_URL: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`, AULE_ADMIN_TOKEN: "operator-secret" });
  app = createPlayground(settings);
  await new Promise<void>(resolve => app.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(app.address() as AddressInfo).port}${settings.basePath}/unsubscribe`;
});
after(async () => { await Promise.all([app, backend].map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

test("reading or previewing a link never changes preferences", async () => {
  const count = requests.length;
  for (const method of ["GET", "HEAD"]) {
    const response = await fetch(`${url}?token=${token}`, { method });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(response.headers.get("content-security-policy")!, /form-action 'self'/);
    if (method === "GET") assert.match(await response.text(), /<form method="post">/);
  }
  assert.equal(requests.length, count);
});

test("a POST needs no account and does not forward browser credentials", async () => {
  const response = await fetch(`${url}?token=${token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: "guardian=secret", authorization: "Bearer secret" }, body: "List-Unsubscribe=One-Click" });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Avisos por correo desactivados/);
  assert.deepEqual(requests.at(-1), { token, cookie: undefined, authorization: undefined });
});

test("malformed tokens, wrong verbs and oversized requests do not reach the platform", async () => {
  const count = requests.length;
  assert.equal((await fetch(`${url}?token=%3Cscript%3E`, { method: "POST" })).status, 400);
  assert.equal((await fetch(`${url}?token=${token}`, { method: "PUT" })).status, 405);
  assert.equal((await fetch(`${url}?token=${token}`, { method: "POST", body: "x".repeat(1025) })).status, 413);
  assert.equal(requests.length, count);
});

test("a rejected or unavailable platform never displays success", async () => {
  for (const code of [400, 503]) {
    status = code;
    const response = await fetch(`${url}?token=${token}`, { method: "POST" });
    assert.equal(response.status, code);
    assert.match(await response.text(), /No se pudo guardar/);
  }
  status = 204;
  const english = await fetch(`${url}?token=${token.replace('.es.', '.en.')}`);
  assert.match(await english.text(), /<html lang="en">/);
});
