// A document just big enough to run the console's pages under node --test:
// the elements of a page's HTML by their ids, the ones its script makes, and
// their text. It cannot read HTML from a string: a script that tried would
// throw here, as it would be refused by the pages' Trusted Types.

import { readFile } from "node:fs/promises";

const pub = new URL("../public/", import.meta.url);

class Text {
  constructor(data) {
    this.data = String(data);
  }
  get textContent() {
    return this.data;
  }
}

const refused = () => {
  throw new Error("a page may not make HTML from a string");
};

export class Element {
  constructor(tagName, attributes = "") {
    this.tagName = tagName.toUpperCase();
    this.childNodes = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.hidden = /\shidden\b/.test(attributes);
    this.disabled = false;
    this.className = attributes.match(/\sclass="([^"]*)"/)?.[1] ?? "";
    this.value = "";
    this.href = "";
  }
  get textContent() {
    return this.childNodes.map((node) => node.textContent).join("");
  }
  set textContent(value) {
    this.childNodes = [new Text(value ?? "")];
  }
  get children() {
    return this.childNodes.filter((node) => node instanceof Element);
  }
  append(...nodes) {
    for (const node of nodes) this.childNodes.push(typeof node === "string" ? new Text(node) : node);
  }
  replaceChildren(...nodes) {
    this.childNodes = [];
    this.append(...nodes);
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  /** What the browser does when the person acts: the listeners run, and their promises are returned. */
  fire(type) {
    return Promise.all((this.listeners.get(type) ?? []).map((listener) => listener({ type, target: this, preventDefault() {} })));
  }
  focus() {}
  querySelectorAll() {
    return [];
  }
  set innerHTML(_) {
    refused();
  }
  set outerHTML(_) {
    refused();
  }
  insertAdjacentHTML() {
    refused();
  }
}

/** Every element under `root`, itself included, in order. */
export function* walk(root) {
  yield root;
  for (const node of root.childNodes) if (node instanceof Element) yield* walk(node);
}

/** The rows of a table body, each as the text of its cells. */
export const rows = (body) => body.children.map((row) => row.children.map((cell) => cell.textContent));

/** Waits until the page has done what it does without anyone acting. */
export async function settle() {
  for (let round = 0; round < 20; round++) await new Promise((resolve) => setImmediate(resolve));
}

let runs = 0;

/**
 * Runs a page's script against a fake document made from its HTML. `answer`
 * gives what the API answers to each request: `{status, body}`, or a promise
 * of it to answer late. Returns the document and what the script did: what
 * it asked, where it sent the browser, the address it wrote and its timers.
 */
export async function open(page, script, { search = "", answer = () => ({ status: 200, body: {} }), prompts = [], confirms = [] } = {}) {
  const html = await readFile(new URL(page, pub), "utf8");
  const byId = new Map();
  for (const [, tag, attributes] of html.matchAll(/<([a-z][a-z0-9]*)(\s[^>]*)>/g)) {
    const id = attributes.match(/\sid="([\w-]+)"/)?.[1];
    if (id) byId.set(id, new Element(tag, attributes));
  }
  const listeners = new Map();
  const asked = [];
  const moves = [];
  const addresses = [];
  const timers = [];
  const document = {
    visibilityState: "visible",
    getElementById: (id) => byId.get(id) ?? null,
    createElement: (tag) => new Element(tag),
    createTextNode: (data) => new Text(data),
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    fire(type) {
      return Promise.all((listeners.get(type) ?? []).map((listener) => listener({ type })));
    },
  };
  Object.assign(globalThis, {
    document,
    location: { search, replace: (to) => moves.push(to) },
    history: { replaceState: (_state, _title, to) => addresses.push(to) },
    window: { prompt: () => prompts.shift() ?? null, confirm: () => confirms.shift() ?? false },
    fetch: async (path, init = {}) => {
      asked.push({ path, method: init.method ?? "GET", body: init.body ?? null });
      const { status, body } = await answer(path, init);
      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    },
  });
  // The page's timers are kept, not run: a test runs them by hand. Only the
  // pages call setInterval in these tests' processes.
  globalThis.setInterval = (run, ms) => timers.push({ run, ms, cleared: false });
  globalThis.clearInterval = (id) => {
    if (timers[id - 1]) timers[id - 1].cleared = true;
  };
  // A query of its own makes each run a new instance of the page's module.
  await import(`${new URL(script, pub)}?run=${++runs}`);
  await settle();
  return { document, $: (id) => byId.get(id), asked, moves, addresses, timers };
}
