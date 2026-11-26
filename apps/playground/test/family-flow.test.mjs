// Run the page's authentication and summary transitions with controlled
// responses: no mailbox, real family or tutoring session is involved.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { codeDigits } from "../public/steps.js";
import { homeWords } from "../public/summaries.js";

const read = (name) => readFile(new URL(`../public/${name}`, import.meta.url), "utf8");
const signin = await read("signin.js");
const reviews = (await read("reviews.js")).replace(/^import .*;\n/gm, "").replace(/^export /gm, "");

function source(text, name) {
  const found = text.match(new RegExp(`\\n(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(found, name);
  return found;
}

function element() {
  return {
    value: "", hidden: false, disabled: false, textContent: "", children: [], attributes: {},
    focus() { this.focused = true; },
    setAttribute(key, value) { this.attributes[key] = value; },
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); },
    addEventListener() {},
  };
}

function login(respond) {
  const fields = new Map();
  const $ = (id) => {
    if (!fields.has(id)) fields.set(id, element());
    return fields.get(id);
  };
  $("email-name-field").hidden = true;
  const calls = [], accounts = [], messages = [];
  const page = runInNewContext(`
    let verifying = false, emailAddress = "family@example.test";
    const codeInput = $("email-code");
    const WRONG_CODE = "wrong", NOT_CHECKED = "unavailable";
    const drawDigits = () => {};
    const entryText = (key) => key;
    ${["nameError", "clearCode", "waiting", "verify"].map((name) => source(signin, name)).join("\n")}
    ({ verify, clearCode })`, {
    $, codeDigits,
    say: (message) => messages.push(message),
    entered: (account) => accounts.push(account),
    call: async (path, body) => {
      calls.push({ path, body: JSON.parse(JSON.stringify(body)) });
      return respond(body);
    },
  });
  return { ...page, $, calls, accounts, messages };
}

test("a new account is asked for its name only after a valid code, and submits that code again", async () => {
  const page = login(async ({ code, name }) => {
    if (code !== "123456") throw new Error("wrong_code");
    if (!name) throw new Error("name_needed");
    return { signed_in: true, students: [] };
  });
  page.$("email-code").value = "123456";
  await page.verify();
  assert.equal(page.$("email-name-field").hidden, false);
  assert.equal(page.$("email-name").focused, true);
  assert.equal(page.accounts.length, 0);
  assert.deepEqual(page.calls[0].body, { email: "family@example.test", code: "123456" });
  await page.verify();
  assert.equal(page.calls.length, 1, "an empty name never sends another request");
  page.$("email-name").value = "  Example guardian  ";
  await page.verify();
  assert.deepEqual(page.calls[1].body, { email: "family@example.test", code: "123456", name: "Example guardian" });
  assert.equal(page.accounts.length, 1);
});

test("a returning account enters without a name, while an incorrect or expired code never enters", async () => {
  const existing = login(async () => ({ signed_in: true, students: [{ id: "one" }] }));
  existing.$("email-code").value = "123456";
  await existing.verify();
  assert.equal(existing.accounts.length, 1);
  assert.equal(existing.$("email-name-field").hidden, true);
  assert.equal("name" in existing.calls[0].body, false);

  const invalid = login(async () => { throw new Error("wrong_code"); });
  invalid.$("email-code").value = "000000";
  await invalid.verify();
  assert.equal(invalid.accounts.length, 0);
  assert.equal(invalid.$("email-name-field").hidden, true);
  assert.equal(invalid.$("email-code").value, "");
  // The name step is not authentication: an expired code must be checked again.
  invalid.$("email-name-field").hidden = false;
  invalid.$("email-name").value = "Example guardian";
  invalid.$("email-code").value = "123456";
  await invalid.verify();
  assert.equal(invalid.accounts.length, 0);
  assert.equal(invalid.$("email-name").value, "");
  assert.equal(invalid.$("code-continue").disabled, false);
});

test("submitting twice while a code is being checked sends only one request", async () => {
  let resolve;
  const page = login(() => new Promise((done) => { resolve = done; }));
  page.$("email-code").value = "123456";
  const first = page.verify();
  await page.verify();
  assert.equal(page.calls.length, 1);
  assert.equal(page.$("code-continue").disabled, true);
  resolve({ signed_in: true });
  await first;
  assert.equal(page.accounts.length, 1);
});

function reader() {
  let account = { signed_in: true, students: [{ id: "one", name: "Example A" }, { id: "two", name: "Example B" }] };
  let screen = "home";
  const fields = new Map(), shown = new Map(), hidden = new Map();
  const requests = [], watchers = [];
  const $ = (id) => {
    if (!fields.has(id)) fields.set(id, element());
    return fields.get(id);
  };
  const page = runInNewContext(`${reviews}\n({ openSummaries, load })`, {
    $, homeWords,
    document: { documentElement: { lang: "es" }, createElement: element },
    current: () => screen,
    getAccount: () => account,
    go: (next) => { hidden.get(screen)?.(); screen = next; shown.get(next)?.(); },
    need() {},
    onShow: (id, handler) => shown.set(id, handler),
    onHide: (id, handler) => hidden.set(id, handler),
    onAccount: (handler) => watchers.push(handler),
    call: (path, body) => new Promise((resolve, reject) => requests.push({ path, body, resolve, reject })),
  });
  return {
    $, requests,
    open: (id) => page.openSummaries(account.students.find((one) => one.id === id)),
    leave() { hidden.get(screen)?.(); screen = "home"; },
    signOut() { account = { signed_in: false }; watchers.forEach((watch) => watch(account)); },
    reload: page.load,
  };
}
const tick = () => new Promise((done) => setImmediate(done));
const summary = (text) => ({ sessions: [{ day: "2026-11-25", summary: text, next: "Practise again." }] });

test("late summaries cannot replace another child's, return after leaving, or survive signing out", async () => {
  const page = reader();
  page.open("one");
  page.open("two");
  page.requests[1].resolve(summary("Second child's review"));
  await tick();
  page.requests[0].resolve(summary("Obsolete review"));
  await tick();
  assert.equal(page.$("summary-list").children[0].children[1].textContent, "Second child's review");
  page.signOut();
  assert.equal(page.$("summary-list").children.length, 0);
  assert.equal(page.$("summaries-title").textContent, "");

  const left = reader();
  left.open("one");
  left.leave();
  left.requests[0].resolve(summary("Too late"));
  await tick();
  assert.equal(left.$("summary-list").children.length, 0);
  assert.equal(left.$("summaries-retry").hidden, true);
});

test("empty and failed summaries offer a retry; review markup stays text", async () => {
  const page = reader();
  page.open("one");
  page.requests[0].resolve({ sessions: [] });
  await tick();
  assert.match(page.$("summaries-status").textContent, /Todavía no hay resúmenes/);
  assert.equal(page.$("summaries-retry").hidden, false);
  const failed = page.reload();
  page.requests[1].reject(new Error("unavailable"));
  await failed;
  assert.match(page.$("summaries-status").textContent, /No pudimos/);
  const ready = page.reload();
  const markup = '<img src=x onerror="throw 1">';
  page.requests[2].resolve(summary(markup));
  await ready;
  const text = page.$("summary-list").children[0].children[1];
  assert.equal(text.textContent, markup);
  assert.equal(text.children.length, 0);
});
