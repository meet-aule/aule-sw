// Answers the student can tap under Aule's question (contracts/choices,
// FIGMA.md D44). The tutor sends them on their own topic once it has said the
// question, and the page draws them as buttons under that line, in the
// conversation. Tapping one is the student's turn: its words go to the tutor as
// typed words do (`send`), so they pass its input gates like anything typed.
// Where several may be marked, «Listo» sends them as one turn, joined by
// commas, in the order they were offered. Once answered, or once the
// conversation has moved on, the buttons stay to be read and cannot be pressed.
// Nothing here reaches the network by itself, and nothing is kept.

export const TOPIC = "aule.choices";

// The contract's limits: what is outside them is not drawn.
const MOST = 4;
const LONGEST = 40;

/** The choices in what the tutor sent, or null when they are not choices a screen can offer. */
export function choicesOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).some((key) => key !== "options" && key !== "multiple")) return null;
  const { options, multiple = false } = value;
  if (!Array.isArray(options) || options.length < 1 || options.length > MOST || typeof multiple !== "boolean") return null;
  const fits = (option) => typeof option === "string" && option.trim() !== "" && [...option].length <= LONGEST;
  if (!options.every(fits) || new Set(options).size !== options.length) return null;
  return { options: [...options], multiple };
}

/** What tells one set of choices from another: the same options offered the same way. */
export const keyOf = (choices) => (choices ? JSON.stringify([choices.options, choices.multiple]) : "");

/**
 * Whether the answers to tap that the engine's step carries are drawn from it.
 * The tutor sends them once it has said its question, but a page that was
 * reloaded, or that missed that message, has none. They are drawn when the
 * same question has waited for two looks at the step (`looks`), Aule is
 * listening (`state`), nothing to tap is showing, and they were not already
 * drawn on this page (`drawn`): a question answered a moment ago still shows
 * in the step until the engine has heard the answer.
 */
export function restores({ key, looks, showing, drawn, state }) {
  return key !== "" && looks >= 2 && !showing && key !== drawn && state === "listening";
}

/** The turn a selection sends: what was marked, in the order it was offered, joined by commas. */
export function turnOf(options, marked) {
  return options.filter((option) => marked.has(option)).join(", ");
}

// Each list of several says how it works in a line of its own, which its group names.
let notes = 0;

/**
 * The buttons for `choices`, as an item of the conversation (`item`), and
 * `close` for when the conversation moves on. `send(text)` sends the student's
 * turn and resolves true once it has gone: from the tap until then the buttons
 * cannot be pressed, and if it did not go they can be again. `say(key)` gives
 * the page's words (first-steps.js) in the session's `language`.
 */
export function choicesItem(document, choices, { language, say, send }) {
  const item = document.createElement("li");
  item.className = "choices";
  item.lang = language;
  const group = document.createElement("div");
  group.className = "choices-options";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", say("choices_label"));
  const marked = new Set();
  // "open", "sending" while a tap is on its way, then "closed".
  let state = "open";
  let done = null;

  const buttons = choices.options.map((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "choice-option";
    button.textContent = option;
    if (choices.multiple) button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => (choices.multiple ? toggle(option, button) : answer(new Set([option]))));
    return button;
  });
  group.append(...buttons);

  if (choices.multiple) {
    const note = document.createElement("p");
    note.className = "choices-note";
    note.id = `choices-note-${++notes}`;
    note.textContent = say("choices_several");
    group.setAttribute("aria-describedby", note.id);
    // Botón/Negro «Listo», as the camera's: it sends what is marked, once something is.
    done = document.createElement("button");
    done.type = "button";
    done.className = "ink-button send choices-done";
    done.textContent = say("choices_done");
    done.disabled = true;
    done.addEventListener("click", () => answer(marked));
    item.append(note, group, done);
  } else {
    item.append(group);
  }

  function toggle(option, button) {
    if (state !== "open") return;
    if (marked.has(option)) marked.delete(option);
    else marked.add(option);
    button.setAttribute("aria-pressed", String(marked.has(option)));
    done.disabled = marked.size === 0;
  }

  function lock() {
    for (const button of buttons) button.disabled = true;
    if (done) done.disabled = true;
  }

  async function answer(chosen) {
    if (state !== "open" || chosen.size === 0) return;
    state = "sending";
    lock();
    // What was chosen stays marked, as a tile of A04 does.
    buttons.forEach((button, i) => button.setAttribute("aria-pressed", String(chosen.has(choices.options[i]))));
    const sent = await send(turnOf(choices.options, chosen));
    if (sent || state !== "sending") {
      state = "closed";
      return;
    }
    // It did not go: the buttons can be pressed again, as they were.
    state = "open";
    buttons.forEach((button, i) => {
      button.disabled = false;
      if (choices.multiple) button.setAttribute("aria-pressed", String(marked.has(choices.options[i])));
      else button.removeAttribute("aria-pressed");
    });
    if (done) done.disabled = marked.size === 0;
  }

  return {
    item,
    /** Whether a tap can still answer. */
    get open() {
      return state === "open";
    },
    /** The conversation moved on: the buttons stay to be read, and cannot be pressed. */
    close() {
      state = "closed";
      lock();
    },
  };
}
