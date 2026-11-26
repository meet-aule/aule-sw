// A session's own address, /session/<id> (FIGMA.md D41): the router as it is,
// with the functions of home.js and app.js that say each screen's address, run
// against a stand-in for the browser's history.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { SCREENS, progressAt } from "../public/steps.js";

const read = (name) => readFile(new URL(`../public/${name}`, import.meta.url), "utf8");
// The router as a script: its one import is given, and what it exports stays in scope.
const screens = (await read("screens.js")).replace(/^import .*$/m, "").replace(/^export /gm, "");
const app = await read("app.js");
const home = await read("home.js");

/** A function of a page's script, as written there. */
function source(text, name) {
  const found = text.match(new RegExp(`\\n(?:export )?(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(found, name);
  return found.replace("export ", "");
}

const SESSION = "01a215c0-9f37-718e-b5cf-bb3c99184cdd";
const OTHER = "01a215c0-9f37-718e-b5cf-bb3c99184cde";
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** The page loaded at `address`, with `recovery` as what api/session/recovery answers (an Error: it fails). */
function page(address, recovery = { available: false }) {
  const entries = [{ state: null, url: new URL(address) }];
  let at = 0;
  const popped = [];
  const clone = (state) => (state == null ? null : structuredClone(state));
  const moved = (url) => (url == null ? entries[at].url : new URL(url, entries[at].url));
  const history = {
    get state() {
      return clone(entries[at].state);
    },
    pushState(state, _title, url) {
      entries.splice(at + 1, Infinity, { state: clone(state), url: moved(url) });
      at += 1;
    },
    replaceState(state, _title, url) {
      entries[at] = { state: clone(state), url: moved(url) };
    },
    back() {
      if (at === 0) return;
      at -= 1;
      // As a browser does: popstate comes later, with the entry's state.
      setImmediate(() => popped.forEach((listener) => listener({ state: clone(entries[at].state) })));
    },
  };
  const location = {
    get href() {
      return entries[at].url.href;
    },
    get pathname() {
      return entries[at].url.pathname;
    },
    get search() {
      return entries[at].url.search;
    },
    get hash() {
      return entries[at].url.hash;
    },
  };
  const section = (screen) => ({ dataset: { screen }, hidden: true, classList: { add() {}, remove() {} }, querySelector: () => null });
  const document = {
    querySelectorAll: () => Object.keys(SCREENS).map(section),
    getElementById: () => null,
    documentElement: { dataset: {} },
    addEventListener() {},
  };
  const answer = async () => {
    if (recovery instanceof Error) throw recovery;
    return structuredClone(recovery);
  };
  const studied = [];
  const browser = runInNewContext(
    `${screens}
    let sessionId = null, recoverable = null, room = null, resumable = null;
    ${home.match(/\nlet opened = [^\n]*\n/)?.[0]}
    ${["openedSession", "findResumable"].map((name) => source(home, name)).join("\n")}
    ${["showRecoverable", "offerRecovery", "screenAddress"].map((name) => source(app, name)).join("\n")}
    // home.js's study(), for the student whose session a reload left open: A05.
    function study(id) {
      studied.push(id);
      go("a05");
    }
    addressFor(screenAddress);
    need("student", () => true);
    need("session", () => room !== null);
    need("ended", () => true);
    onShow("home", () => findResumable());
    onShow("a05", () => offerRecovery());
    ({
      go,
      current,
      setAccount,
      offered: () => recoverable,
      // As app.js's join() and leave() do it.
      join(id) {
        room = {};
        sessionId = id;
        go("session");
      },
      end() {
        room = null;
        sessionId = null;
        go("session-end", { replace: true, fresh: true });
      },
    })`,
    {
      SCREENS, progressAt, URL, performance, history, location, document, studied,
      addEventListener: (type, listener) => type === "popstate" && popped.push(listener),
      window: { scrollTo() {} },
      call: answer,
      fetch: async () => ({ ok: true, json: answer }),
      closing: async () => undefined,
      sessionRequest: () => ({ student_id: "k1" }),
      $: () => ({}),
      write() {},
      writeWords() {},
      recoveryText: (key) => key,
    },
  );
  return Object.assign(browser, {
    history,
    studied,
    entries: () => entries.length,
    address: () => `${location.pathname}${location.search}${location.hash}`,
  });
}

test("the session's id goes into the address once the session exists, by replaceState and with no entry of its own (D41)", async () => {
  const browser = page("https://playground.meetaule.com/session/?src=feria#top");
  browser.setAccount({ signed_in: true });
  browser.go("home", { fresh: true });
  browser.go("a05");
  await tick();
  assert.equal(browser.address(), "/session/?src=feria#top");
  browser.join(SESSION);
  assert.equal(browser.address(), `/session/${SESSION}?src=feria#top`, "the query and the hash stay");
  assert.equal(browser.entries(), 3, "the home, A05 and the session: the id took no entry");
  // Back during a session does nothing, and the address keeps the id.
  browser.history.back();
  await tick();
  assert.equal(browser.current(), "session");
  assert.equal(browser.address(), `/session/${SESSION}?src=feria#top`);
  // Once it is over, the end screen is at the session page's own address.
  browser.end();
  assert.equal(browser.address(), "/session/?src=feria#top");
});

test("reloaded at its address, the family's open session goes straight to A05 to carry it on, and the address keeps it (D41)", async () => {
  const open = { available: true, session_id: SESSION, student_id: "k1", remaining_seconds: 300 };
  const browser = page(`https://playground.meetaule.com/session/${SESSION}`, open);
  browser.setAccount({ signed_in: true, students: [{ id: "k1" }] });
  // As signin.js starts a signed-in family: the home, which asks about the address's session.
  browser.go("home", { fresh: true });
  assert.equal(browser.address(), `/session/${SESSION}`, "left alone while the home asks");
  await tick();
  assert.deepEqual(browser.studied, ["k1"], "its student is chosen, as after a reload");
  assert.equal(browser.current(), "a05");
  assert.equal(browser.offered()?.session_id, SESSION, "A05 offers «Seguir con la sesión»");
  assert.equal(browser.address(), `/session/${SESSION}`);
  browser.join(SESSION);
  assert.equal(browser.address(), `/session/${SESSION}`);
});

test("at any other session's address, or a malformed one, the page is as at /session/ and puts that address back (D41)", async () => {
  // The same for each: what the page asks about is the sign-in's session, never the address's.
  for (const [why, recovery] of [
    ["unknown, or another family's: this sign-in has none open", { available: false }],
    ["ended", { available: false, session_id: SESSION, end_reason: "child_ended", language: "es" }],
    ["the family's open session is another one", { available: true, session_id: OTHER, student_id: "k1", remaining_seconds: 300 }],
    ["the check failed", new Error("offline")],
  ]) {
    const browser = page(`https://playground.meetaule.com/session/${SESSION}?src=feria`, recovery);
    browser.setAccount({ signed_in: true, students: [{ id: "k1" }] });
    browser.go("home", { fresh: true });
    await tick();
    assert.deepEqual(browser.studied, [], why);
    assert.equal(browser.current(), "home", why);
    assert.equal(browser.address(), "/session/?src=feria", why);
  }
  const signedOut = page(`https://playground.meetaule.com/session/${SESSION}`);
  signedOut.setAccount({ signed_in: false, providers: ["email"] });
  signedOut.go("p01");
  assert.equal(signedOut.address(), "/session/", "signed out");
  for (const junk of [SESSION.toUpperCase(), `${SESSION}x`, "not-a-session"]) {
    const browser = page(`https://playground.meetaule.com/session/${junk}`);
    browser.setAccount({ signed_in: true, students: [] });
    browser.go("home", { fresh: true });
    assert.equal(browser.address(), "/session/", junk);
  }
});
