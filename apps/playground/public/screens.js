// One screen shows at a time: a <section data-screen> of index.html, each a
// frame of the Figma «Login-Aule» v8 (steps.js says which). This module shows
// it and moves between them. A step forward is an entry in the browser's
// history, so its Back and «← Atrás» go to the step before. During a session
// Back does nothing: a session started by mistake costs a family its day, and
// a phone's back swipe is easy to make by accident.
//
// The account the page read from api/account is kept here too, so the
// modules that draw the screens share it without importing each other.

import { SCREENS, progressAt } from "./steps.js";

const sections = new Map(
  [...document.querySelectorAll("section[data-screen]")].map((section) => [section.dataset.screen, section]),
);
const message = document.getElementById("message");
const shownHandlers = new Map();
const hiddenHandlers = new Map();
const needs = new Map();
const watchers = [];

// Clicks are ignored this long after a student's screen shows (Notas A04 and
// A05): a late tap must not land on the next screen's button. A05 waits
// longest, as the device does until its refresh ends (1.5 s): a second tap on
// «Seguir» or on a tile of A04 must not start a session a family cannot undo.
const INK_SETTLE_MS = 300;
const SETTLE_MS = { a05: 1200 };

let showing = null;
let shownAt = 0;
// The history entry the screen showing belongs to, to tell Back from Forward.
let shownN = 0;
// "new" while a family signs up, "back" when it comes back: P02 and P03 then
// show the plain line, since a returning parent is not onboarding.
let flow = "new";
let account = { signed_in: false };
// This load of the page. An entry from an earlier load is not stepped back into.
const visit = Math.random().toString(36).slice(2);
// The first entry «← Atrás» may step back to. The ones before it belong to a
// part of the visit that is over: signing in, a profile already created.
let floor = 1;

const ours = (state) => (state?.visit === visit ? state : null);
const signedIn = () => account.signed_in === true;

/** Whether a screen can show now: the right side of signing in, and what it needs is held. */
function allowed(id) {
  const screen = SCREENS[id];
  if (!screen || !sections.has(id)) return false;
  if (screen.auth === "in" && !signedIn()) return false;
  if (screen.auth === "out" && signedIn()) return false;
  return !screen.needs || needs.get(screen.needs)?.() === true;
}

/** Where a visit lands: the family's students, C01's question, or nothing without a way to sign in. */
export function landing() {
  if (signedIn()) return "home";
  return account.google_client_id || account.providers?.length ? "c01" : null;
}

/** The screen itself if it can show, else the first one back from it that can. */
function settle(id) {
  for (let next = id, hops = 0; next && hops < 12; next = SCREENS[next]?.back ?? null, hops += 1) {
    if (allowed(next)) return next;
  }
  const land = landing();
  return land && allowed(land) ? land : null;
}

function setMessage(text, tone) {
  if (!message) return;
  message.textContent = text ?? "";
  message.hidden = !text;
  message.dataset.tone = tone ?? "error";
}

// The progress header (Barra de progreso/Base 160:1415): three named parts
// whose fill grows with the steps, or the plain line outside the onboarding.
function drawProgress(section, parts) {
  const bar = section.querySelector("ol.progress");
  if (!bar) return;
  bar.classList.toggle("plain", !parts);
  if (!parts) {
    bar.replaceChildren();
    bar.setAttribute("aria-hidden", "true");
    return;
  }
  bar.removeAttribute("aria-hidden");
  bar.replaceChildren(
    ...parts.map((part) => {
      const item = document.createElement("li");
      item.className = "segment";
      if (part.current) item.setAttribute("aria-current", "step");
      const track = document.createElement("span");
      track.className = "track";
      const fill = document.createElement("span");
      fill.className = "fill";
      fill.style.width = `${(part.done / part.steps) * 100}%`;
      track.append(fill);
      const name = document.createElement("span");
      name.className = "segment-name";
      name.textContent = part.name;
      if (part.current) {
        const where = document.createElement("span");
        where.className = "sr-only";
        where.textContent = `: paso ${part.done} de ${part.steps}`;
        name.append(where);
      }
      item.append(track, name);
      return item;
    }),
  );
}

// Paper screens come up from below, as the Figma's phone prototype moves in;
// going back they come down. Student screens change at once, as e-ink does.
function animate(section, direction) {
  section.classList.remove("arrive", "return");
  if (SCREENS[section.dataset.screen]?.surface !== "paper" || direction === "none") return;
  void section.offsetWidth;
  section.classList.add(direction === "back" ? "return" : "arrive");
}

function show(id, direction) {
  const before = showing;
  if (before && before !== id) for (const handler of hiddenHandlers.get(before) ?? []) handler(id);
  showing = id;
  for (const [key, section] of sections) section.hidden = key !== id;
  const root = document.documentElement;
  if (!id) {
    delete root.dataset.screen;
    root.dataset.surface = "paper";
    return;
  }
  const section = sections.get(id);
  root.dataset.screen = id;
  root.dataset.surface = SCREENS[id].surface;
  document.title = `Aule · ${SCREENS[id].name}`;
  drawProgress(section, progressAt(id, flow));
  // The one message line goes where this screen shows it.
  if (message) (section.querySelector("[data-message]") ?? section.querySelector(".screen-body, .ink-body") ?? section).append(message);
  shownAt = performance.now();
  for (const handler of shownHandlers.get(id) ?? []) handler();
  animate(section, direction);
  window.scrollTo(0, 0);
  // Each screen change puts the focus on its title, as a page change would.
  section.querySelector("h2[tabindex]")?.focus({ preventScroll: true });
}

/**
 * Shows a screen. replace: in place of this step rather than after it;
 * fresh: what came before is over, so «← Atrás» and Back do not go into it;
 * message, tone: what the message line says ("error" or "info"), cleared otherwise;
 * flow: "new" or "back"; direction: "forward", "back", or "none" for no motion.
 */
export function go(id, { replace = false, fresh = false, message: text = "", tone, flow: next, direction = "forward" } = {}) {
  if (next) flow = next;
  const target = settle(id);
  const at = ours(history.state);
  const n = !at ? 1 : replace ? at.n : at.n + 1;
  const state = { visit, screen: target, n, flow };
  if (!at || replace) history.replaceState(state, "");
  else history.pushState(state, "");
  if (fresh || !at) floor = n;
  shownN = n;
  // The message first: a screen's own handlers may say something of theirs.
  setMessage(text, tone);
  show(target, at ? direction : "none");
}

/** «← Atrás»: the step before in this visit if there is one, else the screen's own way back. */
export function back() {
  const at = ours(history.state);
  if (at && at.n > floor) return history.back();
  go(SCREENS[showing]?.back ?? landing(), { replace: true, direction: "back" });
}

addEventListener("popstate", (event) => {
  const state = ours(event.state);
  // A session stays where it is: its entry goes back on top.
  if (showing === "session" && allowed("session")) {
    history.pushState({ visit, screen: "session", n: (state?.n ?? shownN - 1) + 1, flow }, "");
    return;
  }
  const n = state?.n ?? 0;
  const direction = state && n < shownN ? "back" : "forward";
  if (state?.flow) flow = state.flow;
  // Going back, a step that no longer makes sense (a profile already saved, a
  // session already over) is passed by, as if it were not there; the floor's
  // own entry too (P12 once its child is saved and the home has shown).
  if (state && n >= floor && direction === "back" && !allowed(state.screen)) {
    history.back();
    return;
  }
  // The steps behind the floor are over (signing in, a child already made):
  // going back they are crossed in one move to the visit's first entry, so
  // the landing shows once and the next Back leaves the page.
  if (state && direction === "back" && n < floor && n > 1) {
    history.go(1 - n);
    return;
  }
  const behind = !state || n < floor;
  const target = behind ? settle(landing()) : settle(state.screen);
  if (behind || target !== state.screen) {
    const at = behind ? (state?.n ?? 1) : n;
    history.replaceState({ visit, screen: target, n: at, flow }, "");
    if (behind) floor = at;
  }
  shownN = state?.n ?? 1;
  setMessage("");
  show(target, direction);
});

// «← Atrás» and «Volver» on any screen.
document.addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-back]");
  if (!button || !sections.get(showing)?.contains(button)) return;
  event.preventDefault();
  back();
});

// The settling time of a student's screen: a click too soon is dropped.
document.addEventListener(
  "click",
  (event) => {
    if (SCREENS[showing]?.surface !== "ink" || performance.now() - shownAt >= (SETTLE_MS[showing] ?? INK_SETTLE_MS)) return;
    if (!sections.get(showing)?.contains(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  },
  true,
);

/** The screen showing now, or null. */
export function current() {
  return showing;
}

/** Runs `handler` each time the screen shows; at once if it is showing already. */
export function onShow(id, handler) {
  shownHandlers.set(id, [...(shownHandlers.get(id) ?? []), handler]);
  if (showing === id) handler();
}

/** Runs `handler(next)` each time the screen gives way to another. */
export function onHide(id, handler) {
  hiddenHandlers.set(id, [...(hiddenHandlers.get(id) ?? []), handler]);
}

/** Says how to tell whether something a screen needs (steps.js `needs`) is held. */
export function need(name, held) {
  needs.set(name, held);
}

/** The account as api/account last said it. */
export function getAccount() {
  return account;
}

/** Keeps the account, and tells each module that watches it. */
export function setAccount(next) {
  account = next ?? { signed_in: false };
  for (const watcher of watchers) watcher(account);
}

export function onAccount(watcher) {
  watchers.push(watcher);
}
