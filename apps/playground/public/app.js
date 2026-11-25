// The playground page: lets the person check their microphone, on this device
// only, and their camera (A05 Antes de empezar), asks the server for a room
// token, joins the room, and shows what the tutor is doing (A15 La sesión
// empezó, or A16 Hola, soy Aule on a first run): Aule's face on a stage, which
// a drawing or the camera takes while it shows (D30, D31).

import { firstRun, purposeAsked, sessionRequest } from "./home.js";
import { back, current, getAccount, go, need, onAccount, onHide, onShow } from "./screens.js";
import { TOPIC as VISUAL_TOPIC, renderVisual } from "./visuals.js";
import { endedMessage, languageOf, recoveryMessage } from "./session-messages.js";
import { COACH_HOLD_MS, HINTS_MS, VOICE, WINDOW_MS, cameraProblem, heard, isTap, levelOf, micProblem, words } from "./first-steps.js";
import { cuy } from "./cuy.js";
import { pixelate } from "./pixels.js";

const { Room, RoomEvent, Track, ParticipantKind, DisconnectReason, createLocalVideoTrack } = LivekitClient;

const TRANSCRIPTION_TOPIC = "lk.transcription";
const AGENT_STATE = "lk.agent.state";
// Set by the tutor when a turn lasts while a button is held, like on the
// device, instead of ending when the person goes quiet.
const TURNS = "aule.turns";
// Set by the tutor when it can be shown a piece of work on request. The camera
// is then for one picture at a time, not for watching.
const SHOW_WORK = "aule.show_work";
// The picture is taken from the first frame after the request; the camera
// stays on a moment longer so the student sees what was shown.
const SHOWN_MS = 1500;
// How long the camera waits for «Listo» once «Mostrar mi tarea» turned it on.
const AIM_MS = 30_000;
// The camera is for showing work: the one facing the table when there are
// two, and sharp enough to read handwriting.
const CAMERA = { facingMode: "environment", resolution: { width: 1280, height: 720 } };
// How long the microphone stays open after the button is let go, so the last
// syllable is not cut.
const TALK_TAIL_MS = 200;
// How long the page waits for the tutor before it says Aule did not arrive.
const TUTOR_WAIT_MS = 15_000;
// How long a new session waits for an attempt that is still closing (see retry-session),
// and after how long of that wait A05 says «Un momento…».
const ENDING_WAIT_MS = 8000;
const CLOSING_NOTE_MS = 300;

// The tutor's states that the line under Aule's face has words for, in the
// student's language (first-steps.js state_*); Aule not arriving is said in
// session-messages.js's.
const STATE_KEYS = ["waiting", "initializing", "listening", "thinking", "speaking", "left", "reconnecting"];

// Ways a session ends that nobody asked for.
const LOST = new Set([
  DisconnectReason.JOIN_FAILURE,
  DisconnectReason.SIGNAL_CLOSE,
  DisconnectReason.STATE_MISMATCH,
  DisconnectReason.CONNECTION_TIMEOUT,
  DisconnectReason.MEDIA_FAILURE,
]);

// How often the page asks where an engine-run session stands. The tutor's own
// words arrive by voice; this only keeps the strip and the card in step.
const STEP_POLL_MS = 3000;
// Typed messages go to the tutor on the topic LiveKit agents read.
const CHAT_TOPIC = "lk.chat";

// Why the family's plan has no session now, as the platform says it, in the
// plan's own words (steps.js's planLine): the team activates the plan of a
// family who writes in, since nobody can pay in the app yet.
const PLAN_LIMITS = {
  trial_day_used: "Hoy ya usaste la sesión de tu prueba gratis. Vuelve mañana.",
  week_used: "Ya usaste las sesiones del plan Aule de estos 7 días. Cada una vuelve a los 7 días de usarla.",
  trial_over: "Tu prueba gratis de 7 días terminó. Para seguir, escríbenos a admin@meetaule.com y te activamos el plan Aule.",
};

const ERRORS = {
  daily_limit: "Ya usaste las sesiones de hoy. Vuelve mañana.",
  not_signed_in: "Tu sesión se cerró. Vuelve a entrar.",
  session_active: "Todavía hay una sesión en curso. Elige al mismo alumno para continuarla o cerrarla.",
  session_changed: "La sesión cambió en otra pestaña. Vuelve a elegir al alumno.",
  recovery_unavailable: "No pudimos comprobar la sesión. Espera un momento y vuelve a intentarlo.",
};

const $ = (id) => document.getElementById(id);
const message = $("message");

// What the person chose before joining. The microphone starts on; the camera
// starts off and is asked for only when it is turned on (D12). A05's camera
// only shows what it sees: the session never turns the camera on for it.
const wanted = { mic: true, cam: false };
// A05's microphone, its meter, and the camera when it was turned on there.
let preview = null;
let meter = null;
let lobbyCamera = null;

// Push-to-talk, when the tutor works that way.
let tutorIdentity = null;
// The tutor takes a picture when asked, so the camera is off between pictures.
let photos = false;
let showing = false;
// «Mostrar mi tarea» turned the camera on and the child is pointing it (D31):
// a track of this device only until «Listo» publishes it; «Cancelar», or AIM_MS
// with nothing, turns it off.
let aiming = false;
let aimTimer = 0;
let aimTrack = null;
// How long «La cámara se apagó.» stays once the wait for «Listo» is over.
let aimNoteTimer = 0;
// The camera «Listo» published, or is publishing, and the room it went to, until it is taken back.
let sent = null;
// True once the tutor is in the session and has said how turns work. Until
// then the microphone stays closed: nobody is listening yet, and the page does
// not know whether it should be open at all.
let tutorReady = false;
let manualTurns = false;
let talking = false;
let connectionLost = false;
let turnGeneration = 0;
let talkStarted = Promise.resolve(false);
let closingTurn = false;
// Whether the tutor has come into this session at all; until it has, the clock
// does not show and the session's «Cámara» cannot be pressed.
let tutorCame = false;
// Whether Aule did not arrive in time (tutorMissing): the session says so until it does.
let tutorLate = false;
// A first run (home.js firstRun()): A16's words in the title, and the coach.
let firstSession = false;
// An attempt Aule did not arrive at, while the platform closes it.
let ending = Promise.resolve();
// Until that close is done, or for ENDING_WAIT_MS at most: the platform starts no other
// session until then, and the closing one must not be offered to carry on.
const closing = () => Promise.race([ending, new Promise((resolve) => setTimeout(resolve, ENDING_WAIT_MS))]);

let room = null;
let clock = null;
let tutorTimer = null;
let stepTimer = null;
// What the card last showed, so a poll that changes nothing leaves a
// half-written answer alone.
let cardShown = "";
// The platform's id for the session being shown, when there is one.
let sessionId = null;
// A session a reload left open, as api/session/recovery offers it; null when there is none.
let recoverable = null;
// Whether A05's devices have answered and can be used.
let mediaReady = false;
// The language a session's words are in: the student's, when the page has
// words in it, else Spanish, the page's own.
const sessionLanguage = () => languageOf(sessionRequest()?.language);
// The words for how a session ends or goes on, in that language unless another is given.
const recoveryText = (key, language = sessionLanguage()) => recoveryMessage(key, language);

/**
 * Writes words of session-messages.js into an element and marks it with the
 * language they are in, so a screen reader reads English words in English on
 * a page that is otherwise Spanish (WCAG 3.1.2).
 */
function write(element, text, language = sessionLanguage()) {
  element.textContent = text;
  element.lang = languageOf(language);
}

/** first-steps.js's words for `key`, in the session's language, written as write() does. */
function writeWords(element, key) {
  const language = sessionLanguage();
  write(element, words(key, language), language);
}

// Carrying on or closing a session; what went wrong is always one of the fixed
// messages, never the browser's or a server's own words.
async function sessionAction(action, body) {
  let response;
  let answer;
  try {
    response = await fetch(`api/session/${action}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    answer = await response.json();
  } catch {
    throw new Error(recoveryText("failed"));
  }
  if (!response.ok) throw new Error(recoveryText(answer.error));
  return answer;
}

/**
 * A05, or its web-only state when this student's session is still open:
 * «¿Seguimos donde nos quedamos?», what carrying on keeps, «Seguir con la
 * sesión» where «Empezar la sesión» was, and a link to start another. Both
 * titles are in the student's language.
 */
function showRecoverable(answer) {
  recoverable = answer;
  const open = answer !== null;
  if (open) write($("a05-title"), recoveryText("resume_title"));
  else writeWords($("a05-title"), "a05_title");
  $("a05-text").hidden = open;
  // The status line is never hidden, only empty, so it is in the accessibility
  // tree before its words arrive and a screen reader reads them as they come
  // (empty, style.css takes it out of the flow).
  write($("recovery-note"), open ? recoveryText("available") : "");
  $("join").hidden = open;
  $("resume").hidden = !open;
  $("restart").hidden = !open;
}

async function offerRecovery() {
  const student = sessionRequest()?.student_id;
  showRecoverable(null);
  write($("join"), recoveryText("start"));
  write($("resume"), recoveryText("resume"));
  write($("restart"), recoveryText("restart"));
  // An answer for another student, or one that comes after A05 was left, is not shown.
  const stale = () => student !== sessionRequest()?.student_id || room || current() !== "a05";
  // An attempt Aule did not arrive at is not offered to carry on while it closes.
  await closing();
  if (stale()) return;
  try {
    const response = await fetch("api/session/recovery");
    if (!response.ok) throw new Error("unavailable");
    const answer = await response.json();
    if (stale()) return;
    if (answer.available && answer.student_id === student) {
      // The title took the focus as A05 showed, still «Antes de empezar»: it
      // takes it again, so a screen reader names the state A05 is in now.
      const title = $("a05-title");
      const focused = document.activeElement === title;
      showRecoverable(answer);
      if (focused) {
        title.blur();
        title.focus({ preventScroll: true });
      }
    }
  } catch {
    if (stale()) return;
    write($("recovery-note"), recoveryText("check_failed"));
  }
}

// Why a session that was not ended here ended, or whether it can still go on.
// A session the platform did not start has nothing to ask about.
async function explainClose(id, connectionLost) {
  for (const delay of id ? [0, 500, 1500] : []) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (room) return;
    try {
      const response = await fetch("api/session/recovery");
      if (!response.ok) break;
      const answer = await response.json();
      if (room) return;
      // Another session is this sign-in's now: this one's reason is not known here.
      if (answer.session_id && answer.session_id !== id) break;
      if (answer.available) return tellEnded(recoveryText("lost_title"), recoveryText("lost"), { resumable: true });
      if (answer.end_reason) {
        // In the session's language as the platform kept it: the title and the line alike.
        const language = answer.language ?? sessionRequest()?.language;
        return tellEnded(recoveryText("ended", language), endedMessage(answer.end_reason, language), { language });
      }
    } catch { break; }
  }
  if (room) return;
  if (connectionLost) tellEnded(recoveryText("lost_title"), recoveryText("lost_unknown"));
  else tellEnded(recoveryText("ended"), endedMessage(null, sessionRequest()?.language));
}

// «Terminar», or the time is up: the platform is told, and the end screen says
// so. A session Aule never came to says that it does not count, and it does
// not: the platform counts only a session that started (plans.rs).
function finishSession(line) {
  const id = sessionId;
  leave(line ?? (tutorCame ? endedMessage("child_ended", sessionRequest()?.language) : recoveryText("no_tutor")));
  if (id) sessionAction("end", { session_id: id }).catch(() => {
    if (!room) tellEnded(recoveryText("ended"), recoveryText("close_failed"));
  });
}

// `language`: given when the words are session-messages.js's, in the session's
// language. They go in a span marked with it, which leaves with them as soon as
// anything else writes the line (screens.js, students.js), so the mark never
// outlives its words.
function showMessage(text, tone = "error", language) {
  // The adult's line under a camera's problem goes with the line it is under.
  writeWords($("session-help"), "");
  if (text && language) {
    const words = document.createElement("span");
    write(words, text, language);
    message.replaceChildren(words);
  } else {
    message.textContent = text;
  }
  message.hidden = !text;
  message.dataset.tone = tone;
}

// For something that went wrong once and can be tried again: it does not stay
// on the screen for the rest of the session.
const PASSING_MS = 8000;
function showPassingMessage(text, language) {
  showMessage(text, "error", language);
  setTimeout(() => {
    if (message.textContent === text) showMessage("");
  }, PASSING_MS);
}

/**
 * A camera the session could not use, by the browser's error: the child's line
 * on the message line and, under it in smaller type and not live, what an adult
 * can do (first-steps.js camera_*_help; none for a camera that is merely
 * missing), as A05 does for the microphone (D33). Both pass.
 */
function cameraTrouble(errorName) {
  const key = cameraProblem(errorName);
  const language = sessionLanguage();
  showPassingMessage(words(key, language), language);
  writeWords($("session-help"), `${key}_help`);
}

/**
 * Hides a button that goes when what it offers is done. If it has the focus,
 * the screen's title takes it, so the keyboard's place is not lost to the page.
 */
function hideKeepingFocus(button, title) {
  if (button.hidden) return;
  if (document.activeElement === button) title.focus({ preventScroll: true });
  button.hidden = true;
}

// --- Aule's mouth moves while Aule's voice sounds ------------------------------
//
// The tutor says it is speaking for the whole of an answer, its pauses too. A
// meter on the voice that is being played tells when it really sounds, so the
// face talks then and rests in between. Like A05's meter it reads a level, in
// this browser only: nothing it hears is kept or sent. Until the meter has
// heard the voice once, the face talks for the whole of «speaking», as it does
// in a browser where the voice cannot be measured.

// The level a voice has, and how long the mouth keeps going after it: the gap
// in a word is not a pause.
const AULE_VOICE = 0.05;
const AULE_PAUSE_MS = 220;
let voiceMeter = null;
let voiceAt = -Infinity;
let voiceSounds = false;

function followVoice(track) {
  forgetVoice();
  voiceMeter = startMeter(new MediaStream([track.mediaStreamTrack]), null, (level, now) => {
    if (level >= AULE_VOICE) voiceAt = now;
    const sounds = now - voiceAt < AULE_PAUSE_MS;
    if (sounds === voiceSounds) return;
    voiceSounds = sounds;
    setTutorState();
  });
}

function forgetVoice() {
  stopMeter(voiceMeter);
  voiceMeter = null;
  voiceAt = -Infinity;
  voiceSounds = false;
}

// What Aule's face does in each state of the session.
const MASCOT_STATE = {
  waiting: "sleeping",
  initializing: "thinking",
  listening: "listening",
  thinking: "thinking",
  speaking: "speaking",
  missing: "sad",
  left: "sleeping",
  reconnecting: "surprised",
};

// The face takes the dot's place once its script has loaded; in a browser
// that cannot run it, the dot stays, and A05's check does without a face.
// Aule is a cuy (cuy.js), shown in pixel art (pixels.js).
customElements.whenDefined("wobnimo-mascot").then(() => {
  for (const face of [$("mascot"), $("check-face"), $("ended-face")]) {
    face.spec = cuy;
    pixelate(face);
  }
  $("tutor").classList.add("has-mascot");
  $("mic-check").classList.add("has-mascot");
  $("ended-face").parentElement.classList.add("ready");
});

/**
 * Aule's face and the one line under it, for the tutor's state; with no state,
 * the one it has again, for a hold that started or ended. With held turns the
 * line says «Tu turno» until the button is held, then «Te escucho» until Aule
 * has the turn (the tail after letting go and end_turn included: until then
 * it is not the child's turn again); with an open microphone, «Te escucho».
 * Each is written only when it changes, so the status is said once.
 */
function setTutorState(state = $("tutor").dataset.state) {
  $("tutor").dataset.state = state;
  const line = $("tutor-state");
  if (state === "missing") {
    // Said once, politely, in the title and the line under it (showIntro): under
    // the sad face the line says nothing more.
    line.setAttribute("aria-live", "off");
    write(line, "");
  } else {
    line.removeAttribute("aria-live");
    const key = state === "listening" && manualTurns && !talking && !closingTurn ? "your_turn" : STATE_KEYS.includes(state) ? state : "waiting";
    const language = sessionLanguage();
    const text = words(`state_${key}`, language);
    if (line.textContent !== text || line.lang !== language) write(line, text, language);
  }
  // The tutor is speaking for a whole answer; the mouth moves while its voice sounds.
  const pause = state === "speaking" && Number.isFinite(voiceAt) && !voiceSounds;
  const face = pause ? "idle" : (MASCOT_STATE[state] ?? "idle");
  if ($("mascot").getAttribute("state") !== face) $("mascot").setAttribute("state", face);
}

// The icon a compact toggle (Botón/Compacto 191:1396) shows beside its label,
// crossed when it is off, as on A05; one without an icon says it in words only.
const TOGGLE_ICONS = { Cámara: "videocam" };

/** An icon of Íconos · Aparato 190:995, in the colour of the control it is in. */
function iconOf(name) {
  const icon = document.createElement("span");
  icon.className = "icon";
  icon.dataset.icon = name;
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

function setToggle(button, label, on) {
  button.setAttribute("aria-pressed", String(on));
  // "Cámara apagada", "Modo tinta apagado": the word follows the thing's gender.
  const off = label.split(" ")[0].endsWith("a") ? "apagada" : "apagado";
  const words = on ? label : `${label} ${off}`;
  const base = TOGGLE_ICONS[label];
  if (!base) {
    button.textContent = words;
    return;
  }
  button.replaceChildren(iconOf(on ? base : CROSSED[base]), words);
}

// A round control (Botón/Micrófono 193:709): black with its icon when on,
// white with the icon crossed when off. Its name stays («Micrófono»,
// «Cámara»); the sentence next to it, which describes it, says which: «Tu
// micrófono está encendido.», in the student's language (its data-on and
// data-off name the words).
const CROSSED = { mic: "mic_off", videocam: "videocam_off" };
function setRound(button, on) {
  button.setAttribute("aria-pressed", String(on));
  const icon = button.querySelector(".icon");
  const base = icon.dataset.icon.replace("_off", "");
  icon.dataset.icon = on ? base : CROSSED[base];
  const says = $(button.getAttribute("aria-describedby"));
  writeWords(says, on ? says.dataset.on : says.dataset.off);
}

/** A round control's name (`key`, first-steps.js), in the student's language. */
function nameRound(button, key) {
  const language = sessionLanguage();
  button.setAttribute("aria-label", words(key, language));
  button.lang = language;
}

function startClock(seconds) {
  const endsAt = Date.now() + seconds * 1000;
  const tick = () => {
    const left = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
    $("clock").textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    if (left === 0) finishSession(endedMessage("budget_reached", sessionRequest()?.language));
  };
  tick();
  clock = setInterval(tick, 1000);
}

// One line per transcription segment; a segment is streamed, so its line grows.
const lines = new Map();
// The person's lines since they last pressed the talk button. A hold's words can
// arrive twice, once as the turn is sent and again when the speech service
// finishes late, so a line that only repeats another is not shown.
let heldLines = [];

function showHeldLines() {
  const texts = heldLines.map((line) => line.textContent.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""));
  heldLines.forEach((line, i) => {
    line.hidden = texts.some(
      (other, j) => j !== i && other.startsWith(texts[i]) && (other.length > texts[i].length || j < i),
    );
  });
}

async function onTranscription(reader, participant) {
  const attributes = reader.info.attributes ?? {};
  const id = attributes["lk.segment_id"] ?? reader.info.id;
  const local = room?.localParticipant;
  // The agent may publish the person's words itself, naming the track it heard.
  const mine =
    participant.identity === local?.identity ||
    [...(local?.trackPublications.values() ?? [])].some(
      (publication) => publication.trackSid === attributes["lk.transcribed_track_id"],
    );
  let line = lines.get(id);
  if (!line) {
    line = document.createElement("li");
    line.dataset.who = mine ? "you" : "tutor";
    line.dataset.name = mine ? words("you", sessionLanguage()) : "Aule";
    lines.set(id, line);
    if (mine && manualTurns) heldLines.push(line);
    $("transcript").append(line);
    followTranscript();
  }
  // The person's speech arrives as whole revisions; the tutor's as increments.
  let text = "";
  for await (const chunk of reader) {
    text += chunk;
    line.textContent = text;
    if (heldLines.includes(line)) showHeldLines();
    followTranscript();
  }
}

// The page stays where the person left it; only the conversation's own column
// follows the newest words. It stops following when the person scrolls up to
// read something earlier, and starts again when they come back to the end.
let following = true;
let followFrame = 0;

$("transcript").addEventListener("scroll", () => {
  const list = $("transcript");
  following = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
});

function followTranscript(always = false) {
  if (always) following = true;
  if (!following || followFrame) return;
  // Once per frame, after the new words have their height.
  followFrame = requestAnimationFrame(() => {
    followFrame = 0;
    const list = $("transcript");
    list.scrollTop = list.scrollHeight;
  });
}

// --- a session run by the engine: its stages and the exercise in hand ---------

const ROUTE_STATE = { done: "Hecho", current: "Ahora", pending: "Después" };

function stopSteps() {
  clearInterval(stepTimer);
  stepTimer = null;
  cardShown = "";
  $("route").hidden = true;
  $("card").hidden = true;
}

function followSteps(id) {
  stopSteps();
  const ask = () => showStep(id).catch(() => undefined);
  ask();
  stepTimer = setInterval(ask, STEP_POLL_MS);
}

async function engineCall(path, id, more = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // A family is known by its sign-in.
    body: JSON.stringify({ session_id: id, ...more }),
  });
  if (response.status === 409) return null;
  if (!response.ok) throw new Error("step");
  return response.json();
}

async function showStep(id, given) {
  const step = given ?? (await engineCall("api/step", id));
  if (id !== sessionId) return;
  // Not the engine's session, or it is over: nothing more to follow.
  if (!step) return stopSteps();

  $("route").replaceChildren(
    ...(step.route ?? []).map((stop) => {
      const line = document.createElement("li");
      line.dataset.state = stop.state;
      const name = document.createElement("strong");
      name.textContent = stop.name;
      const detail = document.createElement("span");
      detail.textContent = stop.detail ?? "";
      line.append(name, detail);
      line.setAttribute("aria-label", `${stop.name}: ${ROUTE_STATE[stop.state] ?? ""}`);
      if (stop.state === "current") line.setAttribute("aria-current", "step");
      return line;
    }),
  );
  $("route").hidden = !(step.route ?? []).length;

  const card = step.card;
  const shown = card ? `${card.title}|${card.statement}` : "";
  if (shown === cardShown) return;
  cardShown = shown;
  $("card").hidden = !card;
  if (!card) return;
  $("card-title").textContent = card.title ?? "";
  $("card-statement").textContent = card.statement ?? "";
  $("answer").hidden = !card.asks_answer;
  $("explanation-line").hidden = !card.asks_explanation;
  $("card-help").textContent = card.format_help ?? "";
  $("card-help").hidden = !card.format_help;
  $("answer-text").value = "";
  $("explanation-text").value = "";
  // A new exercise brings its own drawing, or an empty board: the drawing of
  // the one before does not stay next to it, and the stage shows Aule again.
  $("board").hidden = true;
  boardShows = null;
  showStage();
  if (card.visual?.kind === "exercise") lastExercise = card.visual;
  if (card.visual && (card.visual.kind !== "exercise" || inkMode)) {
    try {
      draw(card.visual);
    } catch {
      // A drawing the page cannot make is simply not shown.
    }
  }
  if (inkMode) showInk();
}

$("answer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = sessionId;
  const written = $("answer-text").value.trim();
  if (!id || !written) return;
  $("answer-send").disabled = true;
  showMessage("");
  try {
    const explanation = $("explanation-text").value.trim();
    const next = await engineCall("api/answer", id, explanation ? { answer: written, explanation } : { answer: written });
    // The session ended while the answer was on its way: its words went with it.
    if (id !== sessionId) return;
    // What they wrote is part of the conversation too.
    const line = item(explanation ? `${written}. ${explanation}` : written);
    line.dataset.who = "you";
    line.dataset.name = words("you_typed", sessionLanguage());
    $("transcript").append(line);
    followTranscript(true);
    // The tutor says what the engine answered: tell it there is something waiting.
    if (room && tutorIdentity) {
      room.localParticipant
        .performRpc({ destinationIdentity: tutorIdentity, method: "answered", payload: "" })
        .catch(() => undefined);
    }
    cardShown = "";
    await showStep(id, next ?? undefined);
  } catch {
    showMessage("No se pudo enviar tu respuesta. Inténtalo otra vez o dila en voz alta.");
  } finally {
    $("answer-send").disabled = false;
  }
});

function item(text) {
  const element = document.createElement("li");
  element.textContent = text;
  return element;
}

// The tutor describes what to show; the page draws it on the stage, where it
// stays until the next drawing, a new exercise or the end of the session, as
// on the device's panel.
// «Modo tinta», the team's device simulator (D32), shows what the device would:
// the drawing, or else the exercise in hand, which the card shows in words and
// the board skips. So the last exercise is kept. It is on for the team and off,
// and never shown, for families (join).
let inkMode = false;
let lastExercise = null;
// What the board shows: a drawing's kind, or null when empty.
let boardShows = null;

/** What the stage shows (D30): the camera while it is on, else a drawing, else Aule's face. */
function showStage() {
  $("stage").dataset.shows = !$("camera-view").hidden ? "camera" : !$("board").hidden ? "drawing" : "face";
}

function draw(visual) {
  $("board").innerHTML = renderVisual(visual);
  $("board").hidden = false;
  boardShows = visual.kind;
  // The panel flashes when it redraws.
  $("board").classList.remove("redraw");
  void $("board").offsetWidth;
  $("board").classList.add("redraw");
  showStage();
}

// The team's ink screen, on an empty board: the exercise in hand, when there is one.
function showInk() {
  if (boardShows) return;
  if (lastExercise) draw(lastExercise);
}

async function onVisual(reader) {
  try {
    const visual = JSON.parse(await reader.readAll());
    if (visual.kind === "exercise") lastExercise = visual;
    // With the exercise card on the screen its statement is already there:
    // the board is for drawings, not for the same words again.
    if (visual.kind === "exercise" && !$("card").hidden && !inkMode) return;
    draw(visual);
  } catch {
    // A description this page cannot draw is skipped; the voice carries on.
  }
}

function watchTutor(participant) {
  if (participant.kind !== ParticipantKind.AGENT) return;
  clearTimeout(tutorTimer);
  tutorIdentity = participant.identity;
  if (!tutorCame) tutorArrived();
  const state = participant.attributes[AGENT_STATE] ?? "initializing";
  setTutorState(state);
  usePhotos(participant.attributes[SHOW_WORK] === "rpc");
  const manual = participant.attributes[TURNS] === "manual";
  const ready = state !== "initializing";
  if (manual === manualTurns && ready === tutorReady) return;
  // With the talk button nothing is heard unless it is held, so it is the one
  // microphone button: the switch goes away, and the hold button works even if
  // the microphone was switched off in the lobby.
  if (manual && !manualTurns) {
    wanted.mic = true;
    setRound($("mic"), true);
  }
  manualTurns = manual;
  tutorReady = ready;
  talking = false;
  showTalk();
  // «Mostrar mi tarea» shows once the tutor is ready to look.
  if (room) showCamera();
  syncMicrophone();
}

// While the connection is down the tutor neither hears nor is heard, and the
// last state it reported would be shown as if it were still true.
async function showConnection(lost) {
  const connectedRoom = room;
  if (lost) {
    connectionLost = true;
    turnGeneration += 1;
    // Mute locally before any RPC: a signalling outage need not stop media.
    room?.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
    stopTalking("cancel_turn");
    showTalk();
    return setTutorState("reconnecting");
  }
  const generation = turnGeneration;
  if (connectionLost) {
    await talkStarted;
    if (room !== connectedRoom || generation !== turnGeneration) return;
    // A short signalling interruption may not trigger the agent's departure
    // handler. Clear its partial turn before another press can begin.
    if (manualTurns && tutorIdentity) await turn("cancel_turn").catch(() => undefined);
    if (room !== connectedRoom || generation !== turnGeneration) return;
    connectionLost = false;
  }
  showTalk();
  syncMicrophone();
  const tutor = [...(room?.remoteParticipants.values() ?? [])].find(
    (participant) => participant.kind === ParticipantKind.AGENT,
  );
  if (tutor) watchTutor(tutor);
  else setTutorState("left");
}

// Open only when the tutor is there and turns end by themselves; with a talk
// button the microphone is closed between turns.
function syncMicrophone() {
  return room?.localParticipant.setMicrophoneEnabled(!connectionLost && wanted.mic && tutorReady && !manualTurns);
}

// A phone has no space bar to mention.
const touchOnly = matchMedia("(pointer: coarse)").matches && !matchMedia("(pointer: fine)").matches;

// Without the talk button the switch is the microphone's mute; with it, the
// talk button is the only microphone button. The switch waits for the tutor to
// be ready: nothing is heard before.
function showTalk() {
  $("talk").hidden = !manualTurns;
  $("mic-group").hidden = manualTurns || !tutorReady;
  // On a phone the button then stays at the bottom of the screen (style.css).
  document.querySelector("main").classList.toggle("push-to-talk", manualTurns);
  $("talk").disabled = !wanted.mic || !tutorReady || connectionLost || closingTurn;
  $("talk").setAttribute("aria-pressed", String(talking));
  // The label has a span of its own: the level bar sits next to it, in the
  // button. In the student's language, like the coach above it.
  writeWords($("talk-label"), !wanted.mic ? "talk_off" : talking ? "talk_listening" : touchOnly ? "talk_hold" : "talk_hold_key");
  // The line under Aule's face follows the hold: «Tu turno», then «Te escucho».
  setTutorState();
  showCoach();
}

// --- The talk button's coach (a web-only state of the talk button) -------------
//
// Holding is taught where it is used, at the first turns: on a first run a line
// above the button says how, until a hold long enough to carry a voice; in any
// session, a press too short to carry one gets a hint, three times at most.
// What the button sends does not change. The line is a status, in the
// student's language, never hidden, only empty.

const COACH_DONE_MS = 2000;
const TAP_HINT_MS = 4000;
const TAP_HINTS = 3;
let coaching = false;
// A passing line (a tap's hint, or «Eso es.») over the coach's own, and how many taps were hinted.
let coachHint = null;
let coachTimer = 0;
let taps = 0;

function showCoach() {
  // While the child aims the camera, and while the camera's line says anything («La cámara se
  // apagó.»), the coach waits: on a small phone its shelf would cover «Listo», or that line.
  const key = manualTurns && tutorReady && wanted.mic && !aiming && !$("camera-aim").textContent ? (coachHint ?? (coaching ? "coach" : "")) : "";
  const line = $("talk-coach");
  const text = words(key, sessionLanguage());
  if (line.textContent !== text) write(line, text);
  // On a phone the line sits over the page, above the fixed button: the session leaves it room.
  document.querySelector("main").classList.toggle("coached", Boolean(text));
}

function coachSays(key, ms) {
  clearTimeout(coachTimer);
  coachHint = key;
  coachTimer = setTimeout(() => {
    coachHint = null;
    showCoach();
  }, ms);
  showCoach();
}

/** Looks at a hold of the talk button once it is let go: `voiced` is null when nothing could measure it. */
function coachAfter(held, voiced) {
  if (isTap(held, voiced === true)) {
    if (taps < TAP_HINTS) {
      taps += 1;
      coachSays("coach_tap", TAP_HINT_MS);
    }
    return;
  }
  if (coaching && held >= COACH_HOLD_MS && voiced !== false) {
    coaching = false;
    coachSays("coach_done", COACH_DONE_MS);
  }
}

function stopCoach() {
  clearTimeout(coachTimer);
  coachHint = null;
  coaching = false;
  taps = 0;
}

// While the button is held, a bar in it follows the microphone's level: the
// session's own track, measured in this browser as A05's is.
let heldAt = 0;
// Whether the hold had a voice in it; null when nothing measured it.
let talkVoice = null;
let talkMeter = null;

function startTalkMeter() {
  stopTalkMeter();
  const track = room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
  if (!track) return;
  talkMeter = startMeter(new MediaStream([track]), $("talk-bar"), (level) => {
    if (level >= VOICE) talkVoice = true;
  });
  if (talkMeter && talkVoice === null) talkVoice = false;
}

function stopTalkMeter() {
  stopMeter(talkMeter);
  talkMeter = null;
  $("talk-bar").style.width = "0%";
}

function turn(method) {
  return room.localParticipant.performRpc({ destinationIdentity: tutorIdentity, method, payload: "" });
}

async function startTalking() {
  if (!room || !manualTurns || talking || !wanted.mic || !tutorReady || !tutorIdentity || connectionLost || closingTurn) return;
  const speaking = room;
  const generation = ++turnGeneration;
  talking = true;
  heldAt = performance.now();
  talkVoice = null;
  heldLines = [];
  showTalk();
  talkStarted = (async () => {
    try {
      await speaking.localParticipant.setMicrophoneEnabled(true);
      if (room !== speaking || generation !== turnGeneration || !talking || connectionLost) {
        await speaking.localParticipant.setMicrophoneEnabled(false);
        return false;
      }
      await turn("start_turn");
      if (generation === turnGeneration && talking) startTalkMeter();
      return room === speaking && generation === turnGeneration && !connectionLost;
    } catch {
      await speaking.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
      if (room !== speaking || generation !== turnGeneration) return false;
      turnGeneration += 1;
      talking = false;
      stopTalkMeter();
      showTalk();
      if (!connectionLost) {
        const language = sessionLanguage();
        showMessage(words("talk_not_started", language), "error", language);
      }
      return false;
    }
  })();
  await talkStarted;
}

async function stopTalking(method = "end_turn") {
  if (!talking) return;
  talking = false;
  closingTurn = true;
  const generation = turnGeneration;
  // Let go: the coach looks at the hold as it was, before the tail.
  if (method === "end_turn") coachAfter(performance.now() - heldAt, talkVoice);
  stopTalkMeter();
  showTalk();
  const speaking = room;
  if (method !== "end_turn") speaking?.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
  try {
    if (method === "end_turn") await new Promise((done) => setTimeout(done, TALK_TAIL_MS));
    // Releasing the button closes capture even if the start RPC is still slow.
    await speaking?.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
    if (!await talkStarted) return;
    if (!speaking || speaking !== room || generation !== turnGeneration || connectionLost) return;
    await turn(method);
  } catch {
    if (method === "end_turn" && !connectionLost && room === speaking) {
      const language = sessionLanguage();
      showMessage(words("turn_unheard", language), "error", language);
    }
  } finally {
    await speaking?.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
    if (room === speaking) {
      closingTurn = false;
      showTalk();
    }
  }
}

/**
 * The camera on the stage while it is on: the one the child is pointing, which
 * nobody else sees until «Listo», or the camera a tutor that takes no pictures
 * watches. «Mostrar mi tarea» shows once the tutor is ready; while the child
 * aims, «Listo» and «Cancelar» take its place.
 */
function showCamera() {
  const publication = room.localParticipant.getTrackPublication(Track.Source.Camera);
  // A camera that was stopped is off, even while its publication is still being taken back.
  const on = Boolean(publication?.track) && !publication.isMuted && publication.track.mediaStreamTrack?.readyState !== "ended";
  const shown = aimTrack ?? (on ? publication.track : null);
  if (shown) shown.attach($("camera"));
  $("camera-view").hidden = !shown;
  showStage();
  $("cam").hidden = !tutorReady || aiming;
  if (photos) {
    // An action, not a switch: it opens the camera, with its icon.
    $("cam").removeAttribute("aria-pressed");
    $("cam").removeAttribute("lang");
    const label = document.createElement("span");
    writeWords(label, "show_work");
    $("cam").replaceChildren(iconOf("videocam"), label);
    $("cam").disabled = showing;
  } else {
    // Nothing is filmed for a room the tutor has not reached.
    $("cam").disabled = !tutorCame;
    $("cam").removeAttribute("lang");
    setToggle($("cam"), "Cámara", on);
  }
}

// With a tutor that takes pictures, nothing is filmed between them. The camera
// never goes on by itself: not as the session joins, nor as the tutor comes in
// or says how it works, since a tutor says it takes pictures only at the end
// of its start-up, and until then every tutor looks like one that takes none.
// It goes on when the child asks: «Mostrar mi tarea», or, with a tutor that
// takes no pictures, the session's «Cámara» once the tutor is in.
function usePhotos(on) {
  if (!room || on === photos) return;
  photos = on;
  if (on && !showing) room.localParticipant.setCameraEnabled(false).then(showCamera, showCamera);
  else showCamera();
}

// The tutor is in: the clock shows, the session's «Cámara» can be pressed, and
// a session that said Aule did not arrive says what it says when Aule does.
function tutorArrived() {
  tutorCame = true;
  $("clock").hidden = false;
  hideKeepingFocus($("retry-session"), $("session-title"));
  if (tutorLate) {
    tutorLate = false;
    showIntro();
  }
  if (room) showCamera();
}

// Aule did not arrive in time: its tile says so, the line under A15's title
// says it is nobody's fault, and «Intentar otra vez» goes back to A05.
function tutorMissing() {
  if (!room || tutorCame) return;
  // The title says what happened: on it, a screen reader hears it again, as on A05's web-only state.
  const title = $("session-title");
  const focused = document.activeElement === title;
  tutorLate = true;
  setTutorState("missing");
  showIntro();
  if (focused) {
    title.blur();
    title.focus({ preventScroll: true });
  }
  writeWords($("retry-session"), "retry");
  $("retry-session").hidden = false;
}

/**
 * The session's title and the lines under it: A15's «La sesión empezó.», or on
 * a first run A16's «Hola, soy Aule», «Soy tu tutor. Soy una inteligencia
 * artificial.» and «Tu papá o mamá recibe un resumen de lo que hacemos.», all
 * in the student's language. While Aule does not arrive, «Aule no pudo llegar»
 * and «No es tu culpa.» (a web-only state): A16's words wait for Aule. The
 * first line is a status, never hidden, only empty, so that Aule not arriving
 * is said once, and politely; the second is not one.
 */
function showIntro() {
  if (tutorLate) {
    write($("session-title"), recoveryText("missing_title"));
    write($("session-intro"), recoveryText("tutor_missing"));
  } else if (firstSession) {
    writeWords($("session-title"), "intro_title");
    writeWords($("session-intro"), "intro_line");
  } else {
    // A15's «La sesión empezó.», in the student's language too.
    write($("session-title"), recoveryText("started"));
    write($("session-intro"), "", "es");
  }
  // True for every family: the home shows a summary of each session (D35).
  writeWords($("session-parent"), firstSession && !tutorLate ? "intro_parent" : "");
}

// «Mostrar mi tarea» in two steps (D31). First the camera turns on and the stage
// shows what it sees, on this device only: the child points it at their work.
// This may be the first time the browser is asked for the camera, and it is the
// only time in the two steps: «Listo» publishes this same track, since a phone
// that holds the camera may refuse a second ask. What the browser says is said
// as such (first-steps.js cameraProblem).
async function aimCamera() {
  if (showing || aiming || !room || !tutorIdentity) return;
  const aimed = room;
  aiming = true;
  showMessage("");
  // «La cámara se apagó.» from the last wait goes as the camera is asked for again.
  clearTimeout(aimNoteTimer);
  writeWords($("camera-aim"), "");
  let track;
  try {
    track = await createLocalVideoTrack(CAMERA);
  } catch (error) {
    aiming = false;
    cameraTrouble(error?.name);
    if (room) showCamera();
    return;
  }
  // The session ended while the browser asked: the camera goes off at once.
  if (room !== aimed || !aiming) {
    track.stop();
    return;
  }
  aimTrack = track;
  clearTimeout(aimNoteTimer);
  writeWords($("camera-aim"), "camera_aim");
  writeWords($("cam-send"), "camera_send");
  writeWords($("cam-cancel"), "camera_cancel");
  $("cam-send").hidden = false;
  $("cam-cancel").hidden = false;
  showCamera();
  // The coach waits while the child aims (showCoach): its shelf leaves «Listo» in sight.
  showCoach();
  // The keyboard's place is the line that says what to do, right before «Listo» in
  // the order: not «Listo» itself, where Space, the talk key, would send a picture.
  // «Listo» is scrolled into sight, clear of the fixed talk button's shelf.
  $("camera-aim").focus({ preventScroll: true });
  $("cam-send").scrollIntoView({ block: "nearest" });
  aimTimer = setTimeout(() => stopAiming({ waited: true }), AIM_MS);
}

// Where the keyboard goes once the camera is off: the talk button, which Space
// holds, or with an open microphone «Mostrar mi tarea»; the title when neither
// can take it now. Never «Listo» or «Cancelar», which are gone.
function focusTalk() {
  const to = [manualTurns ? $("talk") : null, $("cam")].find((one) => one && !one.hidden && !one.disabled);
  (to ?? $("session-title")).focus({ preventScroll: true });
}

/**
 * Turns off the camera the child was pointing: never published after
 * «Cancelar» or the wait, and taken back after «Listo»'s picture, also one
 * still on its way to the room (livekit-client's unpublishTrack waits for the
 * publish it is part of). The keyboard's place, if it was on the camera's row
 * (or lost as «Listo» went dashed), goes back to talking (focusTalk).
 * `waited`: the 30 s are over, and the line says the camera went off, for a moment.
 */
async function stopAiming({ waited = false } = {}) {
  clearTimeout(aimTimer);
  aiming = false;
  const placed = [document.body, $("camera-aim"), $("cam-send"), $("cam-cancel")].includes(document.activeElement);
  const track = aimTrack;
  aimTrack = null;
  writeWords($("camera-aim"), waited ? "camera_off" : "");
  if (waited) {
    aimNoteTimer = setTimeout(() => {
      writeWords($("camera-aim"), "");
      showCoach();
    }, PASSING_MS);
  }
  if (room) {
    showCamera();
    showCoach();
    if (placed) focusTalk();
  }
  hideKeepingFocus($("cam-send"), $("session-title"));
  hideKeepingFocus($("cam-cancel"), $("session-title"));
  if (track) {
    if (sent?.track === track) {
      const taken = sent.room;
      sent = null;
      await taken.localParticipant.unpublishTrack(track).catch(() => undefined);
    }
    track.stop();
    track.detach($("camera"));
  }
  if (room) showCamera();
}

// «Listo»: the camera the child pointed is published, and the tutor is asked at
// once to look, as one tap did before: it takes the first frame that arrives
// after the request (apps/agent camera.py). The camera stays on a moment so the
// child sees what was shown, then goes off.
async function showWork() {
  if (!aiming || showing || !aimTrack || !room || !tutorIdentity) return;
  const sending = room;
  const track = aimTrack;
  showing = true;
  // The wait is over once the picture is on its way, and the picture is not taken
  // back: neither «Listo» nor «Cancelar» can be pressed while it goes.
  clearTimeout(aimTimer);
  $("cam-send").disabled = true;
  $("cam-cancel").disabled = true;
  writeWords($("camera-aim"), "showing_work");
  showMessage("");
  try {
    sent = { track, room: sending };
    // A publish that fails left nothing in the room to take back.
    await sending.localParticipant.publishTrack(track, { source: Track.Source.Camera }).catch((error) => {
      sent = null;
      throw error;
    });
    // The camera went off while it was being published (the session ended): the
    // tutor is not asked to look at it.
    if (!aiming || aimTrack !== track || room !== sending) return;
    // The default timeout on purpose: the tutor waits up to two seconds for a
    // frame, and a shorter limit here would cut that wait.
    const seen = await sending.localParticipant.performRpc({
      destinationIdentity: tutorIdentity,
      method: "show_work",
      payload: "",
    });
    if (seen !== "ok") throw new Error("no frame");
    // The session ended while the tutor looked: its conversation went with it.
    if (room !== sending) return;
    // The tutor hears a fixed line for this; the page writes the same one.
    const line = item("");
    writeWords(line, "shown_work");
    line.dataset.who = "you";
    line.dataset.name = words("you", sessionLanguage());
    $("transcript").append(line);
    followTranscript(true);
    await new Promise((resolve) => setTimeout(resolve, SHOWN_MS));
  } catch {
    const language = sessionLanguage();
    if (room === sending) showPassingMessage(words("camera_unseen", language), language);
  } finally {
    showing = false;
    $("cam-send").disabled = false;
    $("cam-cancel").disabled = false;
    await stopAiming();
  }
}

async function join(session, { resumed = false } = {}) {
  // The clock shows once the tutor is in, counting to the same deadline: it may
  // come in while the room connects.
  tutorCame = false;
  tutorLate = false;
  $("clock").hidden = true;
  $("retry-session").hidden = true;
  // A session carried on after a reload has had its first turns already.
  firstSession = !resumed && firstRun();
  coaching = firstSession;
  sessionWords();
  // «Modo tinta» is the team's device simulator: on for the team, and never
  // shown to a family (D32).
  const team = getAccount().team === true;
  inkMode = team;
  $("device").hidden = !team;
  $("board").classList.toggle("device", team);
  setToggle($("device"), "Modo tinta", team);
  room = new Room({
    adaptiveStream: true,
    dynacast: true,
    // At home there is a television and other people. The browser's own
    // clean-up costs nothing; voice isolation only acts where the system has it.
    audioCaptureDefaults: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      voiceIsolation: true,
    },
    videoCaptureDefaults: CAMERA,
  });

  const connectedRoom = room;
  room
    .on(RoomEvent.ParticipantConnected, watchTutor)
    .on(RoomEvent.ParticipantAttributesChanged, (_changed, participant) => watchTutor(participant))
    .on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (participant.kind === ParticipantKind.AGENT) setTutorState("left");
    })
    .on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (track.kind !== Track.Kind.Audio) return;
      $("audio").append(track.attach());
      if (participant?.kind === ParticipantKind.AGENT) followVoice(track);
    })
    .on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
      track.detach().forEach((el) => el.remove());
      if (track.kind === Track.Kind.Audio && participant?.kind === ParticipantKind.AGENT) forgetVoice();
    })
    .on(RoomEvent.LocalTrackPublished, showCamera)
    .on(RoomEvent.TrackMuted, showCamera)
    .on(RoomEvent.TrackUnmuted, showCamera)
    .on(RoomEvent.Reconnecting, () => showConnection(true))
    .on(RoomEvent.SignalReconnecting, () => showConnection(true))
    .on(RoomEvent.Reconnected, () => showConnection(false))
    .on(RoomEvent.Disconnected, (reason) => {
      if (room !== connectedRoom) return;
      const id = sessionId;
      // The end screen waits on why while the page asks the platform.
      leave(recoveryText("checking"), recoveryText("checking_title"));
      explainClose(id, LOST.has(reason));
    });
  room.registerTextStreamHandler(TRANSCRIPTION_TOPIC, (reader, participant) => {
    onTranscription(reader, participant).catch(() => undefined);
  });

  room.registerTextStreamHandler(VISUAL_TOPIC, (reader) => {
    onVisual(reader);
  });

  await room.connect(session.serverUrl, session.token);
  await room.startAudio();
  setTutorState("waiting");
  // Until the tutor is in, after a while, the page says Aule did not arrive.
  tutorTimer = setTimeout(tutorMissing, TUTOR_WAIT_MS);
  showIntro();
  room.remoteParticipants.forEach(watchTutor);
  sessionId = session.session_id ?? null;
  startClock(session.expiresInSeconds);
  if (session.session_id && session.engine === true) followSteps(session.session_id);
  // A15: «La sesión empezó.» (A16 on a first run), with the microphone as A05 left it.
  go("session");
  if (inkMode) showInk();
  play(hello);

  await syncMicrophone();
  nameRound($("mic"), "mic_label");
  setRound($("mic"), wanted.mic);
  showTalk();
  // The camera stays off: it goes on only when the child asks (usePhotos).
  showCamera();
}

// --- A05: the microphone, checked on this device only --------------------------
//
// The level of A05's own microphone moves the bar; once a voice has been heard
// for long enough (first-steps.js heard()), the status line says «Te escucho.»
// and Aule's face answers. An AnalyserNode reads the stream and is never
// connected to the speakers; the page keeps the last moments' levels, numbers
// only, while A05 shows. Nothing reaches a room, a server or a recording. The
// check never holds back «Empezar la sesión».

// How long Aule's face speaks when «Te escucho.» appears, and listens after the last voice.
const FACE_SPEAKS_MS = 1200;
const FACE_LISTENS_MS = 400;
// hello() and its echo, then a little more: the chime cannot pass the check for the child.
const HELLO_MS = 1600;
const AFTER_CHIME_MS = 300;

// The check while A05's microphone works: its levels, since when it listens,
// the last voice, and whether one was heard (once per showing).
let check = null;
// Why the microphone cannot be used (a key of first-steps.js), or null.
let micTrouble = null;
// What the status line says now, a key of first-steps.js.
let checkLine = null;
let faceSpeaksUntil = 0;

function startCheck() {
  check = { levels: [], since: performance.now(), voiceAt: null, heard: false, quietUntil: 0 };
}

function onLobbyLevel(level, now) {
  if (!check) return;
  // Nothing counts while the microphone is off, nor while the chime plays.
  const counted = wanted.mic && now >= check.quietUntil ? level : 0;
  check.levels.push({ at: now, level: counted });
  while (check.levels.length && check.levels[0].at < now - WINDOW_MS - 200) check.levels.shift();
  if (counted >= VOICE) check.voiceAt = now;
  if (!check.heard && heard(check.levels, now)) {
    check.heard = true;
    faceSpeaksUntil = Math.max(faceSpeaksUntil, now + FACE_SPEAKS_MS);
  }
  showCheck(now);
}

// The status line, «Intentar otra vez» and Aule's face, as things stand: one
// line at a time, each written once.
function showCheck(now = performance.now()) {
  let key = "";
  if (micTrouble) key = micTrouble;
  else if (check && wanted.mic) {
    const quiet = now - (check.voiceAt ?? check.since);
    if (check.heard) key = "check_heard";
    else if (quiet >= HINTS_MS[1]) key = "check_other_app";
    else if (quiet >= HINTS_MS[0]) key = "check_quiet";
    else key = "check_prompt";
  }
  if (key !== checkLine) {
    checkLine = key;
    writeWords($("check-status"), key);
    // Under the child's line, what an adult can do about it (first-steps.js *_help).
    writeWords($("check-help"), micTrouble ? `${micTrouble}_help` : "");
  }
  // It runs on every frame of the meter: only what changes is written. Once the
  // microphone works, «Intentar otra vez» goes, and its focus to A05's title.
  const retry = Boolean(micTrouble) || key === "check_other_app";
  if (!retry) hideKeepingFocus($("mic-retry"), $("a05-title"));
  else if ($("mic-retry").hidden) $("mic-retry").hidden = false;
  const listening = check?.voiceAt != null && now - check.voiceAt < FACE_LISTENS_MS;
  const face = now < faceSpeaksUntil ? "speaking" : listening ? "listening" : "idle";
  if ($("check-face").getAttribute("state") !== face) $("check-face").setAttribute("state", face);
}

function stopLobbyMicrophone() {
  stopMeter(meter);
  meter = null;
  check = null;
  preview?.getTracks().forEach((track) => track.stop());
  preview = null;
}

function stopLobbyCamera() {
  lobbyCamera?.getTracks().forEach((track) => track.stop());
  lobbyCamera = null;
  $("preview").srcObject = null;
}

function stopPreview() {
  stopLobbyMicrophone();
  stopLobbyCamera();
}

function showPreview() {
  const audio = preview?.getAudioTracks()[0];
  if (audio) audio.enabled = wanted.mic;
  // What the camera sees, while it is on; off, the sentence says so.
  $("preview-frame").hidden = !(Boolean(lobbyCamera?.getVideoTracks()[0]) && wanted.cam);
  // The bar and its line, while there is a microphone on to measure.
  const measured = Boolean(audio) && wanted.mic;
  $("level").hidden = !measured;
  $("level-line").hidden = !measured;
  // A microphone that cannot be used is neither on nor off: its button cannot
  // be pressed (dashed, D14), and its sentence says so.
  setRound($("lobby-mic"), wanted.mic && !micTrouble);
  $("lobby-mic").disabled = Boolean(micTrouble);
  if (micTrouble) writeWords($("lobby-mic-text"), "mic_unavailable");
  setRound($("lobby-cam"), wanted.cam);
}

/**
 * Moves `bar`, where there is one, with the loudness of a stream and tells
 * `onLevel` each frame's level, 0 to 1. The analyser is not connected to the
 * speakers, and nothing it hears is kept or sent. Null where the browser
 * cannot measure.
 */
function startMeter(stream, bar, onLevel) {
  let context = null;
  try {
    context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const running = { context, frame: 0, stopped: false };
    const draw = () => {
      if (running.stopped) return;
      analyser.getByteTimeDomainData(samples);
      const level = levelOf(samples);
      if (bar) bar.style.width = `${Math.round(level * 100)}%`;
      onLevel(level, performance.now());
      running.frame = requestAnimationFrame(draw);
    };
    context.resume().catch(() => undefined);
    draw();
    return running;
  } catch {
    context?.close().catch(() => undefined);
    return null;
  }
}

function stopMeter(running) {
  if (!running) return;
  running.stopped = true;
  cancelAnimationFrame(running.frame);
  running.context.close().catch(() => undefined);
}

// Each ask for the microphone, and each showing of A05: an answer that comes
// after another ask, or after A05 was left, lets its device go.
let lobbyAsked = 0;
let lobbyShown = 0;
let cameraAsking = false;

function openLobby() {
  wanted.mic = true;
  wanted.cam = false;
  faceSpeaksUntil = 0;
  writeWords($("lobby-note"), "");
  writeWords($("sound-line"), "");
  // A05's words, in the student's language; nothing of the last showing's.
  writeWords($("a05-text"), "a05_line");
  nameRound($("lobby-mic"), "mic_label");
  nameRound($("lobby-cam"), "cam_label");
  writeWords($("lobby-back"), "back");
  writeWords($("level-line"), "check_line");
  writeWords($("mic-retry"), "retry");
  writeWords($("sound-test"), "sound_test");
  writeWords($("lobby-cam-note"), "camera_note");
  checkLine = null;
  showCheck();
  showPreview();
  askMicrophone();
}

// The microphone alone: the camera is asked for only when it is turned on.
async function askMicrophone() {
  const asked = ++lobbyAsked;
  stopLobbyMicrophone();
  mediaReady = false;
  micTrouble = null;
  checkLine = null;
  // Joining, carrying on and starting another wait until the microphone has
  // answered, so only one thing holds it.
  for (const id of ["join", "resume", "restart"]) $(id).disabled = true;
  let stream = null;
  let trouble = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    trouble = micProblem(error?.name);
  }
  // Left while the browser asked, or asked again since: nothing keeps this microphone.
  if (asked !== lobbyAsked || current() !== "a05") {
    stream?.getTracks().forEach((track) => track.stop());
    return;
  }
  preview = stream;
  micTrouble = trouble;
  mediaReady = !trouble;
  for (const id of ["join", "resume", "restart"]) $(id).disabled = !mediaReady;
  if (preview) {
    startCheck();
    meter = startMeter(preview, $("level").firstElementChild, onLobbyLevel);
    if (!meter) check = null;
  }
  showPreview();
  showCheck();
}

// A microphone the browser refused may be allowed in its settings meanwhile:
// A05 asks again when the page comes back into view, and as soon as the
// browser says it is allowed, where the browser says so.
function askAgain() {
  if (current() === "a05" && micTrouble) askMicrophone();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") askAgain();
});

try {
  navigator.permissions
    ?.query({ name: "microphone" })
    .then((status) => {
      status.addEventListener("change", () => {
        if (status.state === "granted") askAgain();
      });
    })
    .catch(() => undefined);
} catch {
  // A browser that does not know this permission: «Intentar otra vez» and coming back still ask.
}

// A05 shows the devices each time it shows, and asks whether a session this
// student had is still open; leaving it lets the devices go.
onShow("a05", () => {
  lobbyShown += 1;
  openLobby();
  offerRecovery();
});
onHide("a05", () => {
  lobbyShown += 1;
  mediaReady = false;
  micTrouble = null;
  stopPreview();
});

// Joining and leaving have their sound, as in a video call, and it is a
// video game's: synths through resonant filters, a sub bass, an echo and a
// glitch or two, drawn in code with the browser's own audio, so there is no
// file to fetch. The audio is unlocked when the person joins, since browsers
// only play after a click.
let sounds = null;
let mix = null;

function readySounds() {
  try {
    if (!sounds) {
      sounds = new AudioContext();
      // A gentle limiter at the end, and an echo with its highs taken off.
      const limiter = sounds.createDynamicsCompressor();
      const level = sounds.createGain();
      level.gain.value = 0.55;
      limiter.connect(level).connect(sounds.destination);
      mix = sounds.createGain();
      mix.connect(limiter);
      const echo = sounds.createDelay(1);
      const dark = sounds.createBiquadFilter();
      const again = sounds.createGain();
      const wet = sounds.createGain();
      echo.delayTime.value = 0.13;
      dark.type = "lowpass";
      dark.frequency.value = 2500;
      again.gain.value = 0.32;
      wet.gain.value = 0.35;
      mix.connect(echo);
      echo.connect(dark).connect(again).connect(echo);
      dark.connect(wet).connect(limiter);
    }
    sounds.resume();
  } catch {
    // Without audio the session still starts and ends; just quietly.
  }
}

// One synth note: two detuned oscillators through a resonant low-pass filter
// that snaps open and closes again. It can slide to another pitch.
function synth(when, hz, length, options = {}) {
  const { wave = "sawtooth", loud = 0.08, spread = 8, open = 3000, close = 600, q = 6, pan = 0, slide } = options;
  const filter = sounds.createBiquadFilter();
  const level = sounds.createGain();
  const panner = sounds.createStereoPanner();
  filter.type = "lowpass";
  filter.Q.value = q;
  filter.frequency.setValueAtTime(close, when);
  filter.frequency.exponentialRampToValueAtTime(open, when + 0.03);
  filter.frequency.exponentialRampToValueAtTime(close, when + length);
  level.gain.setValueAtTime(0.0001, when);
  level.gain.exponentialRampToValueAtTime(loud, when + 0.008);
  level.gain.exponentialRampToValueAtTime(0.0001, when + length);
  panner.pan.value = pan;
  filter.connect(level).connect(panner).connect(mix);
  for (const cents of [-spread, spread]) {
    const tone = sounds.createOscillator();
    tone.type = wave;
    tone.detune.value = cents;
    tone.frequency.setValueAtTime(hz, when);
    if (slide) tone.frequency.exponentialRampToValueAtTime(slide, when + length);
    tone.connect(filter);
    tone.start(when);
    tone.stop(when + length + 0.05);
  }
}

// A rush of noise through a narrow filter that climbs: the sound of powering up.
function sweep(when, length, from, to, loud) {
  const buffer = sounds.createBuffer(1, Math.round(sounds.sampleRate * length), sounds.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const noise = sounds.createBufferSource();
  const filter = sounds.createBiquadFilter();
  const level = sounds.createGain();
  noise.buffer = buffer;
  filter.type = "bandpass";
  filter.Q.value = 3;
  filter.frequency.setValueAtTime(from, when);
  filter.frequency.exponentialRampToValueAtTime(to, when + length);
  level.gain.setValueAtTime(0.0001, when);
  level.gain.exponentialRampToValueAtTime(loud, when + length * 0.9);
  level.gain.exponentialRampToValueAtTime(0.0001, when + length);
  noise.connect(filter).connect(level).connect(mix);
  noise.start(when);
}

// A minor, up the keyboard.
const A2 = 110, A3 = 220, E4 = 329.63, A4 = 440, C5 = 523.25, E5 = 659.25, A5 = 880, B5 = 987.77, E6 = 1318.51;

// Joining, a boot-up: noise rushing up, a fast arpeggio bouncing left and
// right, and a landing on a wide chord over a sub bass, with a glitch and a
// last glint.
function hello(t) {
  sweep(t, 0.4, 300, 5000, 0.08);
  [A4, C5, E5, A5, B5, E6].forEach((hz, i) =>
    synth(t + i * 0.065, hz, 0.12, { wave: "square", loud: 0.06, open: 4000, close: 900, pan: i % 2 ? 0.4 : -0.4 }),
  );
  for (const hz of [A3, E4, A4, C5]) synth(t + 0.45, hz, 0.7, { loud: 0.05, spread: 12, open: 3500, close: 500, q: 4 });
  synth(t + 0.45, A2, 0.6, { wave: "sine", loud: 0.18, spread: 0, open: 600, close: 400, q: 0.7 });
  synth(t + 0.5, E6, 0.03, { wave: "square", loud: 0.05, open: 6000, close: 3000 });
  synth(t + 0.56, E6, 0.03, { wave: "square", loud: 0.05, open: 6000, close: 3000 });
  synth(t + 0.62, A5 * 2, 0.15, { wave: "square", loud: 0.03, open: 7000, close: 2000, pan: 0.5 });
}

// Leaving, a power-down: the arpeggio comes back down, then the machine winds
// off in one deep falling note with a thump under it, and two last blips.
function goodbye(t) {
  [E5, C5, A4, E4].forEach((hz, i) =>
    synth(t + i * 0.07, hz, 0.12, { wave: "square", loud: 0.06, open: 3500, close: 800, pan: i % 2 ? -0.4 : 0.4 }),
  );
  synth(t + 0.3, A5, 0.45, { loud: 0.07, open: 2500, close: 200, q: 8, slide: A2 / 2 });
  synth(t + 0.3, A2, 0.3, { wave: "sine", loud: 0.18, spread: 0, open: 500, close: 300, q: 0.7, slide: A2 / 2 });
  synth(t + 0.78, 1200, 0.02, { wave: "square", loud: 0.04, open: 6000, close: 3000 });
  synth(t + 0.82, 1200, 0.02, { wave: "square", loud: 0.04, open: 6000, close: 3000 });
}

function play(tune) {
  if (!sounds) return;
  try {
    tune(sounds.currentTime + 0.05);
  } catch {
    // A tune that cannot play is skipped; nothing depends on it.
  }
}

/**
 * Closes the room and clears what the session showed; false when there was
 * none. `quiet`: without the goodbye, for an attempt Aule never came to.
 */
function teardown({ quiet = false } = {}) {
  if (!room) return false;
  const leaving = room;
  room = null;
  turnGeneration += 1;
  connectionLost = false;
  closingTurn = false;
  if (!quiet) play(goodbye);
  clearInterval(clock);
  clearTimeout(tutorTimer);
  stopSteps();
  stopTalkMeter();
  stopCoach();
  tutorIdentity = null;
  tutorCame = false;
  tutorLate = false;
  photos = false;
  showing = false;
  // A camera the child was pointing goes off with the session, and one «Listo»
  // published goes with the room.
  clearTimeout(aimTimer);
  aiming = false;
  aimTrack?.stop();
  aimTrack?.detach($("camera"));
  aimTrack = null;
  sent = null;
  clearTimeout(aimNoteTimer);
  writeWords($("session-help"), "");
  $("camera-view").hidden = true;
  $("cam-send").hidden = true;
  $("cam-send").disabled = false;
  $("cam-cancel").hidden = true;
  $("cam-cancel").disabled = false;
  writeWords($("camera-aim"), "");
  tutorReady = false;
  manualTurns = false;
  talking = false;
  showTalk();
  $("retry-session").hidden = true;
  leaving.disconnect();
  forgetVoice();
  $("audio").replaceChildren();
  $("board").replaceChildren();
  $("board").hidden = true;
  boardShows = null;
  lastExercise = null;
  showStage();
  forgetWords();
  sessionId = null;
  return true;
}

/**
 * Empties what a session held of the student's words: the conversation, the
 * exercise card and its route, and anything half typed. None of it stays in
 * the page once the session is over, nor for the next family on this tab; the
 * end screen never shows it, and a new or resumed session starts its own.
 */
function forgetWords() {
  $("transcript").replaceChildren();
  lines.clear();
  heldLines = [];
  for (const id of ["typed", "answer-text", "explanation-text"]) $(id).value = "";
  for (const id of ["card-title", "card-statement", "card-help"]) $(id).textContent = "";
  $("route").replaceChildren();
}

/** A session that ended: the end screen says how, in place of the session. */
function leave(line, title = recoveryText("ended")) {
  if (!teardown()) return;
  tellEnded(title, line);
  // The session is over: Back steps neither into it nor into the lobby before it.
  go("session-end", { replace: true, fresh: true });
}

/**
 * A session that could not start: back to the family's students, with why
 * (the plan, the browser); `language` when the words are session-messages.js's.
 */
function joinFailed(text, language) {
  const opened = teardown();
  go("home", { replace: opened, message: text });
  if (language) showMessage(text, "error", language);
}

// --- The end screen (web-only, after A15) ------------------------------------------------

// What the end screen shows; null until a session of this page has ended.
let ended = null;
need("ended", () => ended !== null);

/**
 * Writes the end screen: its title and line, from session-messages.js, in
 * `language` (the session's unless the platform said another), and whether
 * the session can still go on. One that can offers «Seguir con la sesión»,
 * which leads to A05 and its web-only state; «Volver» then becomes the link.
 */
function tellEnded(title, line, { resumable = false, language = sessionLanguage() } = {}) {
  ended = { resumable };
  write($("ended-title"), title, language);
  write($("ended-text"), line, language);
  write($("ended-resume"), recoveryText("resume", language), language);
  $("ended-resume").hidden = !resumable;
  $("ended-back").hidden = !resumable;
  $("ended-spacer").hidden = resumable;
  $("ended-home").hidden = resumable;
}

// The student is still chosen, so A05 asks again whether the session is open.
$("ended-resume").addEventListener("click", () => go("a05"));

// Back at the family's students, or signed out, the end screen has nothing to
// say; signed out, nothing a session held stays either (plan §4.6).
onShow("home", () => {
  ended = null;
});
onAccount((account) => {
  if (account.signed_in === true) return;
  ended = null;
  forgetWords();
});

// A session can show only while its room is open.
need("session", () => room !== null);

/**
 * The session's own words around the stage, in the student's language and
 * marked with it, as the line under Aule's face is: «Terminar», the clock's
 * name, the typed message and «Enviar», and the conversation, whose lines are
 * then read in that language. The exercise card stays the engine's Spanish.
 */
function sessionWords() {
  const language = sessionLanguage();
  writeWords($("end"), "end_session");
  writeWords($("type-send"), "send");
  for (const [element, attribute, key] of [
    [$("clock"), "aria-label", "clock_label"],
    [$("typed"), "aria-label", "type_label"],
    [$("typed"), "placeholder", "type_placeholder"],
    [$("transcript"), "aria-label", "conversation"],
  ]) {
    element.setAttribute(attribute, words(key, language));
    element.lang = language;
  }
}

$("lobby-mic").addEventListener("click", () => {
  if (micTrouble) return;
  wanted.mic = !wanted.mic;
  // On again, the hints count from now.
  if (wanted.mic && check) {
    check.since = performance.now();
    check.voiceAt = null;
  }
  showPreview();
  showCheck();
});

$("mic-retry").addEventListener("click", () => askMicrophone());

// The camera, asked for only now that it is turned on; off, it is let go, so
// its light goes out.
$("lobby-cam").addEventListener("click", async () => {
  if (wanted.cam) {
    wanted.cam = false;
    stopLobbyCamera();
    return showPreview();
  }
  if (cameraAsking) return;
  cameraAsking = true;
  const shown = lobbyShown;
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } });
  } catch {
    // No camera, or the person said no: the tutor still works by voice.
  }
  cameraAsking = false;
  if (shown !== lobbyShown || current() !== "a05") {
    stream?.getTracks().forEach((track) => track.stop());
    return;
  }
  writeWords($("lobby-note"), stream ? "" : "camera_none");
  if (stream) {
    lobbyCamera = stream;
    $("preview").srcObject = stream;
    wanted.cam = true;
  }
  showPreview();
});

// «Probar el sonido»: the chime Aule joins with, drawn here, and the line that
// says so. Aule's face speaks while it plays, and the check does not count it.
$("sound-test").addEventListener("click", () => {
  readySounds();
  play(hello);
  const now = performance.now();
  if (check) check.quietUntil = now + HELLO_MS + AFTER_CHIME_MS;
  faceSpeaksUntil = now + HELLO_MS;
  writeWords($("sound-line"), "sound_line");
  showCheck(now);
  setTimeout(() => {
    if (current() === "a05") showCheck();
  }, HELLO_MS + 50);
});

// «Empezar la sesión», and in A05's web-only state «Empezar otra sesión»,
// which closes the open session first. An A05 reached past A04 (a session a
// reload left open, or one that closed since) has not asked what a new
// session is for: A04 asks it, in A05's place, before any session is asked for.
async function startSession() {
  readySounds();
  for (const id of ["join", "resume", "restart"]) $(id).disabled = true;
  $("transcript").replaceChildren();
  following = true;
  lines.clear();
  if (recoverable) {
    try {
      await sessionAction("end", { session_id: recoverable.session_id });
    } catch (error) {
      // Still on A05: what went wrong is said here, and either way can be tried again.
      showMessage(error.message, "error", sessionLanguage());
      for (const id of ["join", "resume", "restart"]) $(id).disabled = !mediaReady;
      return;
    }
    showRecoverable(null);
  }
  if (!purposeAsked()) return go("a04", { replace: true });
  // An attempt Aule did not arrive at may still be closing: the platform starts
  // no other session until it has. If that takes a moment, A05's status line
  // says so, so the disabled buttons are not a silent wait.
  const note = $("recovery-note");
  const waiting = setTimeout(() => write(note, recoveryText("checking_title")), CLOSING_NOTE_MS);
  await closing();
  clearTimeout(waiting);
  if (note.textContent === recoveryText("checking_title")) write(note, "");
  if (current() !== "a05") return;
  try {
    const response = await fetch("api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sessionRequest()),
    });
    const body = await response.json();
    if (!response.ok) {
      const why = body.error === "plan_limit" ? PLAN_LIMITS[body.reason] : ERRORS[body.error];
      throw new Error(why ?? body.message ?? "No se pudo empezar la sesión.");
    }
    // The room opens the devices itself, with what was chosen here.
    stopPreview();
    await join(body);
  } catch (error) {
    joinFailed(
      error?.name === "NotAllowedError"
        ? "El navegador bloqueó el micrófono. Permítelo y empieza otra vez."
        : (error?.message ?? "No se pudo empezar la sesión."),
    );
  }
}

$("join").addEventListener("click", startSession);
$("restart").addEventListener("click", startSession);

// «Seguir con la sesión»: the same room, its tutor and the time that was left.
$("resume").addEventListener("click", async () => {
  if (!recoverable || room || !mediaReady) return;
  for (const id of ["join", "resume", "restart"]) $(id).disabled = true;
  readySounds();
  let session;
  try {
    session = await sessionAction("resume", {
      session_id: recoverable.session_id, student_id: sessionRequest()?.student_id,
    });
  } catch (error) {
    showMessage(error?.message ?? recoveryText("failed"), "error", sessionLanguage());
    for (const id of ["join", "resume", "restart"]) $(id).disabled = !mediaReady;
    return;
  }
  // It ended in the meantime: the end screen says why.
  if (!session.token) {
    showRecoverable(null);
    const language = session.language ?? sessionRequest()?.language;
    tellEnded(recoveryText("ended", language), endedMessage(session.end_reason, language), { language });
    return go("session-end", { replace: true, fresh: true });
  }
  stopPreview();
  $("transcript").replaceChildren();
  lines.clear();
  following = true;
  try {
    await join(session, { resumed: true });
  } catch (error) {
    if (error?.name === "NotAllowedError") joinFailed("El navegador bloqueó el micrófono. Permítelo y empieza otra vez.");
    else joinFailed(recoveryText("failed"), sessionLanguage());
  }
});

$("mic").addEventListener("click", async () => {
  wanted.mic = !wanted.mic;
  setRound($("mic"), wanted.mic);
  if (manualTurns) {
    if (!wanted.mic) await stopTalking("cancel_turn");
    showTalk();
  } else {
    await syncMicrophone();
  }
});

$("talk").addEventListener("pointerdown", (event) => {
  event.preventDefault();
  $("talk").setPointerCapture(event.pointerId);
  startTalking();
});
$("talk").addEventListener("pointerup", () => stopTalking());
$("talk").addEventListener("pointercancel", () => stopTalking("cancel_turn"));
$("talk").addEventListener("contextmenu", (event) => event.preventDefault());

// The space bar is the button too, except while typing or on another control.
// On the talk button it holds it; on «Mostrar mi tarea», «Listo» and «Cancelar»
// it still talks, and never opens the camera or sends a picture (Enter presses
// them): a child who talks with it presses it wherever the focus happens to be.
const SPACE_TALKS = ["talk", "cam", "cam-send", "cam-cancel"];
const typing = (target) => ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(target?.tagName) && !SPACE_TALKS.includes(target.id);
const spaceTalks = (event) => event.code === "Space" && manualTurns && current() === "session" && !typing(event.target);
document.addEventListener("keydown", (event) => {
  if (!spaceTalks(event)) return;
  // Held down, the key repeats: none of it scrolls the page or presses the button under it.
  event.preventDefault();
  if (!event.repeat) startTalking();
});
document.addEventListener("keyup", (event) => {
  if (spaceTalks(event)) event.preventDefault();
  if (event.code === "Space" && talking) stopTalking();
});
// A turn nobody is holding any more is dropped, not sent.
window.addEventListener("blur", () => stopTalking("cancel_turn"));

$("device").addEventListener("click", () => {
  inkMode = !inkMode;
  $("board").classList.toggle("device", inkMode);
  setToggle($("device"), "Modo tinta", inkMode);
  if (inkMode) return showInk();
  // Back to the page's own board: no exercise next to its card.
  if (boardShows === "exercise" && !$("card").hidden) {
    $("board").replaceChildren();
    $("board").hidden = true;
    boardShows = null;
    showStage();
  }
});

// «Mostrar mi tarea» turns the camera on for the child to point it; «Listo»
// sends one picture, «Cancelar» turns it off. With a tutor that takes no
// pictures, the button turns the camera on and off.
$("cam-send").addEventListener("click", () => showWork());
$("cam-cancel").addEventListener("click", () => stopAiming());
$("cam").addEventListener("click", async () => {
  if (photos) return aimCamera();
  const turning = room;
  if (!turning) return;
  try {
    await turning.localParticipant.setCameraEnabled(!turning.localParticipant.isCameraEnabled);
  } catch (error) {
    cameraTrouble(error?.name);
  }
  if (turning === room) showCamera();
});

$("type").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("typed").value.trim();
  const sending = room;
  if (!text || !sending) return;
  $("typed").value = "";
  try {
    await sending.localParticipant.sendText(text, { topic: CHAT_TOPIC });
    // The session ended while the message was on its way: its words went with it.
    if (sending !== room) return;
    // Typed words are not transcribed back, so the page writes them itself.
    const line = item(text);
    line.dataset.who = "you";
    line.dataset.name = words("you_typed", sessionLanguage());
    $("transcript").append(line);
    // Their own message: back to the end, wherever they had scrolled to.
    followTranscript(true);
  } catch {
    const language = sessionLanguage();
    showMessage(words("message_failed", language), "error", language);
  }
});

$("end").addEventListener("click", () => finishSession());

// «Intentar otra vez» when Aule did not arrive: this attempt is closed with the
// platform, without the goodbye, and A05 shows again with the same purpose. It
// never started, so the plan does not count it. A new session waits for the
// close (startSession), since the platform starts no other until then.
$("retry-session").addEventListener("click", () => {
  const id = sessionId;
  if (tutorCame || !teardown({ quiet: true })) return;
  if (id) ending = sessionAction("end", { session_id: id }).catch(() => undefined);
  back();
});
