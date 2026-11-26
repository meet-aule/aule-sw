// The answers a student can tap under Aule's question (public/choices.js,
// FIGMA.md D44): what is drawn from what the tutor sent, what a tap sends, and
// how the session's page puts them in the conversation and closes them. The
// page's own functions run against a stand-in for the few elements they touch.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { TOPIC, choicesItem, choicesOf, turnOf } from "../public/choices.js";
import { words } from "../public/first-steps.js";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const css = await readFile(new URL("../public/style.css", import.meta.url), "utf8");
const examples = new URL("../../../contracts/choices/examples/", import.meta.url);

/** An element of the stand-in page: a disabled button is not clicked, as in a browser. */
function element(tagName) {
  const listeners = {};
  return {
    tagName: tagName.toUpperCase(),
    className: "",
    id: "",
    lang: "",
    type: "",
    disabled: false,
    textContent: "",
    attributes: {},
    dataset: {},
    children: [],
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    addEventListener(type, listener) {
      (listeners[type] ??= []).push(listener);
    },
    click() {
      if (this.disabled) return;
      for (const listener of listeners.click ?? []) listener();
    },
  };
}
const document = { createElement: element };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The buttons for `choices`, and every turn they sent; `goes` says whether a send goes. */
function draw(choices, { goes = () => true, language = "es" } = {}) {
  const sent = [];
  const view = choicesItem(document, choices, {
    language,
    say: (key) => words(key, language),
    send: async (text) => {
      sent.push(text);
      return goes(text);
    },
  });
  const part = (name) => view.item.children.find((child) => child.className.split(" ").includes(name)) ?? null;
  const group = part("choices-options");
  return { view, group, options: group.children, done: part("choices-done"), note: part("choices-note"), sent };
}

const pressed = (buttons) => buttons.map((button) => button.getAttribute("aria-pressed"));

test("what the tutor sends is drawn only when it follows the contract", () => {
  assert.equal(TOPIC, "aule.choices");
  const files = readdirSync(examples);
  assert.ok(files.length > 0);
  for (const file of files) {
    const example = JSON.parse(readFileSync(new URL(file, examples), "utf8"));
    assert.deepEqual(choicesOf(example), { options: example.options, multiple: example.multiple ?? false }, file);
  }
  for (const wrong of [
    null,
    "Sí o no",
    [],
    {},
    { options: [] },
    { options: ["a", "b", "c", "d", "e"] },
    { options: ["Sí", "Sí"] },
    { options: ["Sí", "  "] },
    { options: ["x".repeat(41)] },
    { options: [1, 2] },
    { options: ["Sí", "No"], multiple: "yes" },
    { options: ["Sí", "No"], html: "<b>Sí</b>" },
  ]) {
    assert.equal(choicesOf(wrong), null, JSON.stringify(wrong));
  }
});

test("one answer is a tap: its words are the turn, and then nothing can be pressed (D44)", async () => {
  const { view, group, options, done, note, sent } = draw({ options: ["Sí", "No"], multiple: false });
  // An item of the conversation, in the session's language, with a named group of buttons.
  assert.equal(view.item.tagName, "LI");
  assert.equal(view.item.className, "choices");
  assert.equal(view.item.lang, "es");
  assert.equal(group.getAttribute("role"), "group");
  assert.equal(group.getAttribute("aria-label"), "Toca tu respuesta");
  assert.deepEqual(
    options.map((button) => [button.tagName, button.type, button.className, button.textContent]),
    [
      ["BUTTON", "button", "choice-option", "Sí"],
      ["BUTTON", "button", "choice-option", "No"],
    ],
  );
  assert.equal(done, null);
  assert.equal(note, null);
  assert.deepEqual(pressed(options), [null, null]);

  options[1].click();
  options[0].click();
  await settle();
  assert.deepEqual(sent, ["No"]);
  assert.ok(options.every((button) => button.disabled));
  // What was chosen stays marked, as A04's tiles are.
  assert.deepEqual(pressed(options), ["false", "true"]);
  options[0].click();
  await settle();
  assert.deepEqual(sent, ["No"]);
});

test("several are marked and sent together with «Listo», in the order they were offered", async () => {
  const { group, options, done, note, sent } = draw({ options: ["1/2", "2/4", "3/5"], multiple: true });
  assert.deepEqual(pressed(options), ["false", "false", "false"]);
  assert.equal(done.textContent, "Listo");
  assert.ok(done.className.includes("ink-button") && done.className.includes("send"));
  assert.equal(done.disabled, true, "nothing marked, nothing to send");
  assert.equal(note.textContent, "Puedes tocar varias y luego «Listo».");
  assert.equal(group.getAttribute("aria-describedby"), note.id);
  assert.ok(note.id);

  options[1].click();
  options[0].click();
  options[2].click();
  options[2].click();
  assert.deepEqual(pressed(options), ["true", "true", "false"]);
  assert.equal(done.disabled, false);
  assert.deepEqual(sent, [], "marking sends nothing");
  done.click();
  await settle();
  assert.deepEqual(sent, ["1/2, 2/4"]);
  assert.ok([...options, done].every((button) => button.disabled));
  assert.deepEqual(pressed(options), ["true", "true", "false"]);
  assert.equal(turnOf(["a", "b", "c"], new Set(["c", "a"])), "a, c");
});

test("a turn that did not go leaves the buttons as they were, to try again", async () => {
  let goes = false;
  const one = draw({ options: ["Sí", "No"] }, { goes: () => goes });
  one.options[0].click();
  await settle();
  assert.ok(one.options.every((button) => !button.disabled));
  assert.deepEqual(pressed(one.options), [null, null]);
  goes = true;
  one.options[0].click();
  await settle();
  assert.deepEqual(one.sent, ["Sí", "Sí"]);
  assert.ok(one.options.every((button) => button.disabled));

  const several = draw({ options: ["1/2", "2/4"], multiple: true }, { goes: () => false });
  several.options[1].click();
  several.done.click();
  await settle();
  assert.deepEqual(pressed(several.options), ["false", "true"], "what was marked stays marked");
  assert.equal(several.done.disabled, false);
});

test("once the conversation moves on the buttons stay to be read and cannot be pressed", async () => {
  const { view, options, done, sent } = draw({ options: ["1/2", "2/4"], multiple: true });
  options[0].click();
  view.close();
  assert.ok([...options, done].every((button) => button.disabled));
  options[1].click();
  done.click();
  await settle();
  assert.deepEqual(sent, []);

  // Moved on while a tap was on its way: closed, even if that tap did not go.
  let release;
  const late = choicesItem(document, { options: ["Sí", "No"], multiple: false }, {
    language: "es",
    say: (key) => words(key, "es"),
    send: () => new Promise((resolve) => (release = resolve)),
  });
  const buttons = late.item.children[0].children;
  buttons[0].click();
  late.close();
  release(false);
  await settle();
  assert.ok(buttons.every((button) => button.disabled));
});

test("an English session gets its own words; the options are the tutor's own", () => {
  const { view, group, done, note } = draw({ options: ["Yes", "No"], multiple: true }, { language: "en" });
  assert.equal(view.item.lang, "en");
  assert.equal(group.getAttribute("aria-label"), "Tap your answer");
  assert.equal(done.textContent, "Done");
  assert.equal(note.textContent, "You can tap more than one, then “Done”.");
});

// --- the session's page ------------------------------------------------------------

/** A function of app.js, as written there. */
function source(name) {
  const found = app.match(new RegExp(`\\n(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(found, name);
  return found;
}

/** The page's answers to tap with a stand-in room: what it sent, wrote and said went wrong. */
function page({ fails = false } = {}) {
  const transcript = element("ol");
  const sent = [];
  const messages = [];
  const context = {
    document,
    choicesOf,
    choicesItem,
    words,
    CHAT_TOPIC: "lk.chat",
    choicesNow: null,
    room: {
      localParticipant: {
        sendText: async (text, { topic }) => {
          if (fails) throw new Error("gone");
          sent.push([text, topic]);
        },
      },
    },
    sessionLanguage: () => "es",
    $: (id) => (id === "transcript" ? transcript : element("p")),
    followTranscript: () => {},
    showMessage: (text) => messages.push(text),
  };
  runInNewContext(["item", "closeChoices", "onChoices", "sendTyped"].map(source).join("\n"), context);
  const offer = (value) => context.onChoices({ readAll: async () => (typeof value === "string" ? value : JSON.stringify(value)) });
  return { context, transcript, sent, messages, offer };
}

test("the page puts what the tutor offered under its line, and a tap is the student's typed turn", async () => {
  const { context, transcript, sent, offer } = page();
  await offer({ options: ["Saltos de estrella", "Respiración del globo"], multiple: false });
  const [choices] = transcript.children;
  assert.equal(choices.className, "choices");
  const buttons = choices.children[0].children;
  buttons[1].click();
  await settle();
  // Sent as typed words are, word for word, and written in the conversation as the student's.
  assert.deepEqual(sent, [["Respiración del globo", "lk.chat"]]);
  const line = transcript.children[1];
  assert.deepEqual([line.textContent, line.dataset.who, line.dataset.name], ["Respiración del globo", "you", "Tú"]);
  assert.equal(context.choicesNow, null);
  assert.ok(buttons.every((button) => button.disabled));
});

test("newer answers to tap close the ones before, and what is not choices is not drawn", async () => {
  const { context, transcript, sent, offer } = page();
  await offer({ options: ["Sí"] });
  await offer({ options: ["1/2", "2/4"], multiple: true });
  const [first, second] = transcript.children;
  assert.ok(first.children[0].children.every((button) => button.disabled));
  assert.ok(second.children.find((child) => child.className === "choices-options").children.every((button) => !button.disabled));
  await offer({ options: ["Sí", "Sí"] });
  await offer("not json");
  assert.equal(transcript.children.length, 2);
  // A typed message is the student's turn too: it closes them.
  assert.equal(await context.sendTyped("ya sé", "you_typed"), true);
  assert.deepEqual(sent, [["ya sé", "lk.chat"]]);
  assert.equal(transcript.children[2].dataset.name, "Tú (escrito)");
  assert.equal(context.choicesNow, null);
  assert.ok(second.children.find((child) => child.className === "choices-options").children.every((button) => button.disabled));
});

test("a tap that cannot be sent says so and can be tried again", async () => {
  const { context, transcript, messages, offer } = page({ fails: true });
  await offer({ options: ["Sí", "No"] });
  const buttons = transcript.children[0].children[0].children;
  buttons[0].click();
  await settle();
  assert.deepEqual(messages, ["No se pudo enviar el mensaje."]);
  assert.equal(transcript.children.length, 1, "nothing is written as said");
  assert.ok(buttons.every((button) => !button.disabled));
  assert.ok(context.choicesNow);
});

test("any new line of the conversation closes them, and a session's end forgets them", () => {
  const transcription = source("onTranscription");
  const opened = transcription.indexOf("if (!line) {");
  const closed = transcription.indexOf("closeChoices();");
  assert.ok(opened !== -1 && opened < closed && closed < transcription.indexOf('line = document.createElement("li");'));
  assert.match(source("join"), /room\.registerTextStreamHandler\(CHOICES_TOPIC, \(reader\) => \{\s*onChoices\(reader\);\s*\}\);/);
  assert.match(source("forgetWords"), /choicesNow = null;/);
  // The student's own line closes them only once it was sent.
  const typed = source("sendTyped");
  assert.ok(typed.indexOf("await sending.localParticipant.sendText(") < typed.indexOf("closeChoices();"));
});

test("each answer is a big target in the device's ink, and what was not chosen is dashed once answered", () => {
  const rule = (selector) => css.match(new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";
  const option = rule(".choice-option");
  assert.match(option, /min-height: 56px;/);
  assert.match(option, /min-width: 88px;/);
  assert.match(option, /border: 2px solid var\(--device-ink\);/);
  assert.match(rule('.choice-option[aria-pressed="true"]'), /background: var\(--device-ink\);/);
  assert.match(rule('.choice-option:disabled:not([aria-pressed="true"])'), /border-style: dashed;/);
  assert.match(rule("#transcript li.choices::before"), /content: none;/);
  assert.match(rule(".choices-options"), /flex-wrap: wrap;/);
});
