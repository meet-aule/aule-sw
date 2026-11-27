// The page's words and the language they are said in. Each language is one
// file of words/ with the same groups and keys (es.js says what each is for);
// to add one, write its file and name it in LANGUAGES here and among the
// server's files (src/server.ts). Nothing else knows how many there are.
//
// Two languages are at work on the page and they are not the same: the
// interface's, which a person picks (language.js) and `t` speaks, and a
// student's or a session's, which the screens a child reads are written in
// (first-steps.js, session-messages.js) and `wordsIn` is asked for by name.
// Pure: nothing here touches the page, so the tests import it as it is.

import es from "./words/es.js";
import en from "./words/en.js";

/** The languages the page has words in, in the order the picker lists them. */
export const LANGUAGES = Object.freeze({ es, en });
/** The language the page is written in: what shows before any other is chosen, and what a missing key falls back to. */
export const SOURCE = "es";

/** The language named by a tag ("en", "en-US", "EN"), when the page has it; null otherwise. */
export function languageNamed(tag) {
  const code = typeof tag === "string" ? tag.trim().toLowerCase().split("-")[0] : "";
  return Object.hasOwn(LANGUAGES, code) ? code : null;
}

/** `language` itself when the page has words in it, else Spanish: the language an element written for it is marked with. */
export function languageOf(language) {
  return Object.hasOwn(LANGUAGES, language) ? language : SOURCE;
}

/**
 * The language a visit shows, in this order: the one its address asks for
 * (`asked`, ?lang=), the one chosen before in this browser (`kept`), the first
 * of the browser's own (`preferred`) that the page has, else Spanish.
 */
export function languageFor({ asked = null, kept = null, preferred = [] } = {}) {
  for (const tag of [asked, kept, ...preferred]) {
    const language = languageNamed(tag);
    if (language) return language;
  }
  return SOURCE;
}

/** A group's words in one language, as it has them; undefined for a key it lacks. */
function found(language, key) {
  if (typeof key !== "string") return undefined;
  const dot = key.indexOf(".");
  const group = LANGUAGES[language][key.slice(0, dot)];
  const name = key.slice(dot + 1);
  return dot > 0 && group && Object.hasOwn(group, name) ? group[name] : undefined;
}

/**
 * The words for `key` ("group.name") in `language`, with each {place} filled
 * from `values`; in Spanish where the language lacks the key, and "" for a key
 * that is not one.
 */
export function wordsIn(language, key, values = {}) {
  const text = found(languageOf(language), key) ?? found(SOURCE, key);
  if (text === undefined) return "";
  // A function, so a name with "$" in it is written as it is.
  return text.replace(/\{(\w+)\}/g, (_, place) => String(values[place] ?? ""));
}

/** The keys of one group of words, as the Spanish has them; every language has the same. */
export function keysOf(group) {
  return Object.freeze(Object.keys(LANGUAGES[SOURCE][group]));
}

/** The locale `language` writes its dates and numbers in. */
export function localeOf(language) {
  return LANGUAGES[languageOf(language)].language.locale;
}

/**
 * The words for `key` that go with the number `n`: the form the language's own
 * plural rule names (`key_one`, `key_other`; some languages have more), or
 * `key_other` where it has no words for that form. {n} is the number.
 */
export function countIn(language, key, n, values = {}) {
  const own = languageOf(language);
  const form = `${key}_${new Intl.PluralRules(localeOf(own)).select(n)}`;
  return wordsIn(own, found(own, form) === undefined ? `${key}_other` : form, { n, ...values });
}

// The interface's language. Spanish until language.js settles it as the page loads.
let current = SOURCE;
const watchers = [];

/** The interface's language now. */
export function language() {
  return current;
}

/** Changes the interface's language to one the page has, and tells each module that draws words. */
export function setLanguage(next) {
  const to = languageNamed(next);
  if (!to || to === current) return;
  current = to;
  for (const watcher of watchers) watcher(current);
}

/** Runs `watcher(language)` each time the interface's language changes, to say again what it drew. */
export function onLanguage(watcher) {
  watchers.push(watcher);
}

/** The words for `key` in the interface's language. */
export const t = (key, values) => wordsIn(current, key, values);
/** The words for `key` that go with `n`, in the interface's language. */
export const count = (key, n, values) => countIn(current, key, n, values);
/** The locale the interface writes dates and numbers in. */
export const locale = () => localeOf(current);
