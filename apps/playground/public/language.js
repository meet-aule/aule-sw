// Which language the page shows, and the control to change it. First of the
// page's scripts (index.html): it settles the language and writes the markup's
// words in it before any screen shows, so nothing is drawn in Spanish first.
//
// The markup holds the Spanish, as what shows if the scripts fail. An element
// names the key of its words in data-i18n, and of an attribute's in
// data-i18n-attr ("placeholder:entry.email_placeholder", one or several); the
// words a script says, it asks i18n.js for and says again when the language
// changes (onLanguage).

import { LANGUAGES, language, languageFor, languageNamed, onLanguage, setLanguage, t } from "./i18n.js";

// The language a person chose, kept in this browser so the next visit shows
// it. It is a preference the page needs to do what was asked of it, like
// «Entendido» on the cookie notice (signin.js): written only when the person
// picks a language, or leaves to sign in with the one their link asked for,
// read by this page alone and never sent anywhere.
const KEPT = "aule.language";

function kept() {
  try {
    return localStorage.getItem(KEPT);
  } catch {
    return null;
  }
}

function keep(code) {
  try {
    localStorage.setItem(KEPT, code);
  } catch {
    // Not kept: the next visit shows the browser's own language.
  }
}

// The language the page's address asks for (?lang=en, as a link from the
// landing does), until the person picks another.
let linked = languageNamed(new URLSearchParams(location.search).get("lang"));

/** Writes the markup's words in the interface's language, and says which it is to the browser. */
function write() {
  document.documentElement.lang = language();
  for (const element of document.querySelectorAll("[data-i18n]")) element.textContent = t(element.dataset.i18n);
  for (const element of document.querySelectorAll("[data-i18n-attr]")) {
    for (const named of element.dataset.i18nAttr.split(" ")) {
      const [attribute, key] = named.split(":");
      element.setAttribute(attribute, t(key));
    }
  }
  for (const picker of document.querySelectorAll("[data-language] details")) namePicker(picker);
}

// --- The picker --------------------------------------------------------------------
//
// One in each place the page leaves for it (data-language): the entry's corner
// and the home's account links. Closed, it says the language showing; open,
// each language by its own name, whatever the interface's.

function drawPicker(place) {
  const picker = document.createElement("details");
  const summary = document.createElement("summary");
  summary.className = "link";
  const label = document.createElement("span");
  label.className = "sr-only";
  summary.append(label, document.createElement("span"));
  const list = document.createElement("ul");
  for (const [code, words] of Object.entries(LANGUAGES)) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.code = code;
    button.lang = code;
    button.textContent = words.language.name;
    button.addEventListener("click", () => choose(code, picker));
    item.append(button);
    list.append(item);
  }
  picker.append(summary, list);
  place.replaceChildren(picker);
  place.hidden = false;
}

/** What a picker says closed: «Idioma: » for a screen reader, then the language showing, by its own name. */
function namePicker(picker) {
  const [label, name] = picker.querySelector("summary").children;
  label.textContent = `${t("language.label")}: `;
  name.textContent = LANGUAGES[language()].language.name;
  for (const button of picker.querySelectorAll("button")) {
    if (button.dataset.code === language()) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
}

function close(picker, focus = false) {
  if (!picker.open) return;
  picker.open = false;
  if (focus) picker.querySelector("summary").focus();
}

function choose(code, picker) {
  close(picker, true);
  keep(code);
  // The address no longer asks for another language: a reload shows the one just chosen.
  const address = new URL(location.href);
  if (address.searchParams.has("lang")) {
    address.searchParams.delete("lang");
    history.replaceState(history.state, "", address);
  }
  linked = null;
  setLanguage(code);
}

// Escape, or a press anywhere else, closes an open picker, as it does the entry's help.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const picker of document.querySelectorAll("[data-language] details")) close(picker, picker.contains(document.activeElement));
});
document.addEventListener("pointerdown", (event) => {
  for (const picker of document.querySelectorAll("[data-language] details")) {
    if (!picker.contains(event.target)) close(picker);
  }
});

// GitHub's, Apple's and Facebook's sign-in leave the page and come back to its
// bare address (src/server.ts codeSignIn), where a ?lang= is gone: the
// language a link asked for is kept as the person leaves, so they come back
// to it.
document.addEventListener("click", (event) => {
  if (linked && event.target.closest?.("a[data-provider][href]")) keep(linked);
});

setLanguage(languageFor({ asked: linked, kept: kept(), preferred: navigator.languages ?? [] }));
for (const place of document.querySelectorAll("[data-language]")) drawPicker(place);
// Before any other module's: the markup is in the new language when each says its own words again.
onLanguage(write);
write();
