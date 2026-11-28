import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { readSettings } from "../src/config.ts";
import { createPlayground } from "../src/server.ts";
import { COMPLETE } from "./fixtures.ts";
const TOKEN = "ab".repeat(32);
let seen: {url:string;authorization:string|undefined;signature:string|undefined;body:string}[] = [];
let status = 200;
const backend = createServer(async (request,response) => {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk as Buffer);
  seen.push({url:request.url!,authorization:request.headers.authorization,signature:request.headers["x-signature"] as string|undefined,body:Buffer.concat(chunks).toString()});
  response.writeHead(status,{"Content-Type":"application/json"}); response.end(JSON.stringify(status === 200 ? {received:true,available:true} : {error:{message:"unavailable"}}));
});
let page: ReturnType<typeof createPlayground>; let base = "";
before(async () => {
  await new Promise<void>(resolve=>backend.listen(0,"127.0.0.1",resolve));
  page = createPlayground(readSettings({...COMPLETE,AULE_PLATFORM_URL:`http://127.0.0.1:${(backend.address() as AddressInfo).port}`,AULE_ADMIN_TOKEN:"operator-token-never-forwarded"}));
  await new Promise<void>(resolve=>page.listen(0,"127.0.0.1",resolve));
  base=`http://127.0.0.1:${(page.address() as AddressInfo).port}/playground`;
});
after(()=>{page.close();backend.close();});
beforeEach(()=>{seen=[];status=200;});
const post=(path:string,headers:Record<string,string>={},body:unknown={})=>fetch(base+path,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});
test("billing needs a guardian session and a same-origin JSON write",async()=>{
  assert.equal((await fetch(base+"/api/billing")).status,401);
  const cookie={Cookie:`aule_guardian=${TOKEN}`};
  assert.equal((await post("/api/billing/subscribe",cookie,{accept_recurring:true})).status,403);
  assert.equal((await post("/api/billing/subscribe",{...cookie,Origin:"https://attacker.example"},{accept_recurring:true})).status,403);
  assert.equal(seen.length,0);
  const paid=await post("/api/billing/subscribe",{...cookie,Origin:new URL(base).origin},{accept_recurring:true});
  assert.equal(paid.status,200); assert.equal(seen[0]!.authorization,`Bearer ${TOKEN}`); assert.equal(seen[0]!.url,"/v1/me/billing/subscribe"); assert.equal(paid.headers.get("cache-control"),"no-store");
});
test("the public callback forwards only the signed resource and never a browser or operator token",async()=>{
  const response=await post("/api/payments/webhook?data.id=123&type=payment",{"x-signature":"ts=1,v1=test","x-request-id":"event-1",Cookie:`aule_guardian=${TOKEN}`,Authorization:"Bearer unwanted"},{type:"payment",data:{id:"123"}});
  assert.equal(response.status,200);assert.equal(seen[0]!.authorization,undefined);assert.equal(seen[0]!.signature,"ts=1,v1=test");assert.equal(seen[0]!.url,"/v1/payments/webhook?data.id=123");
});
test("unsigned callbacks reach nothing and failed persistence requests a provider retry",async()=>{
  assert.equal((await post("/api/payments/webhook?data.id=123")).status,401);assert.equal(seen.length,0);
  status=503;
  assert.equal((await post("/api/payments/webhook?data.id=123",{"x-signature":"ts=1,v1=test","x-request-id":"event-1"},{type:"payment",data:{id:"123"}})).status,503);
});
