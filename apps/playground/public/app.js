// The playground page: lets the person check their camera and microphone,
// asks the server for a room token, joins the room, and shows what the tutor
// is doing.

import { onEnter, sessionRequest } from "./signin.js";
import { TOPIC as VISUAL_TOPIC, renderVisual } from "./visuals.js";
import { endedMessage, recoveryMessage } from "./session-messages.js";

const { Room, RoomEvent, Track, ParticipantKind, DisconnectReason } = LivekitClient;

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
// How long the microphone stays open after the button is let go, so the last
// syllable is not cut.
const TALK_TAIL_MS = 200;
const TUTOR_WAIT_MS = 15_000;

const STATE_TEXT = {
  waiting: "Esperando a Aule…",
  initializing: "Aule se está preparando…",
  listening: "Te escucho",
  thinking: "Pensando…",
  speaking: "Hablando",
  missing:
    "Aule no pudo entrar a la sesión. Inténtalo otra vez en un momento.",
  left: "Aule salió de la sesión.",
  reconnecting: "Se perdió la conexión. Reconectando…",
};

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

// Why the family's plan has no session now, as the platform says it.
const PLAN_LIMITS = {
  trial_day_used: "Hoy ya usaste la sesión de tu prueba gratis. Vuelve mañana.",
  week_used: "Ya usaste las sesiones de tu plan de estos 7 días. Cada una vuelve a los 7 días de usarla.",
  trial_over: "Tu prueba gratis de 7 días terminó. Suscríbete para seguir con Aule.",
};

const ERRORS = {
  daily_limit: "Ya usaste las sesiones de hoy. Vuelve mañana.",
  not_signed_in: "Tu sesión se cerró. Vuelve a entrar.",
  session_active: "Todavía hay una sesión en curso. Elige al mismo alumno para continuarla o cerrarla.",
  session_changed: "La sesión cambió en otra pestaña. Vuelve a elegir al alumno.",
  recovery_unavailable: "No pudimos comprobar la sesión. Espera un momento y vuelve a intentarlo.",
};

const $ = (id) => document.getElementById(id);
// Everything shown before a session: signing in and choosing the student.
const entry = $("welcome");
const lobby = $("lobby");
const stage = $("stage");
const message = $("message");

// What the person chose before joining. Both start on.
const wanted = { mic: true, cam: true };
let preview = null;
let meter = null;

// Push-to-talk, when the tutor works that way.
let tutorIdentity = null;
// The tutor takes a picture when asked, so the camera is off between pictures.
let photos = false;
let showing = false;
// True once the tutor is in the session and has said how turns work. Until
// then the microphone stays closed: nobody is listening yet, and the page does
// not know whether it should be open at all.
let tutorReady = false;
let manualTurns = false;
let talking = false;

let room = null;
let clock = null;
let tutorTimer = null;
let stepTimer = null;
// What the card last showed, so a poll that changes nothing leaves a
// half-written answer alone.
let cardShown = "";
// The platform's id for the session being shown, when there is one.
let sessionId = null;
let recoverable = null;
const recoveryText = (key) => recoveryMessage(key, sessionRequest()?.language);

async function sessionAction(action, body) {
  const response = await fetch(`api/session/${action}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const answer = await response.json();
  if (!response.ok) throw new Error(recoveryText(answer.error));
  return answer;
}

async function offerRecovery() {
  const student = sessionRequest()?.student_id;
  recoverable = null;
  $("resume").textContent = recoveryText("resume");
  $("resume").hidden = true;
  $("resume").disabled = false;
  $("join").textContent = recoveryText("start");
  $("recovery-note").hidden = true;
  try {
    const response = await fetch("api/session/recovery");
    if (!response.ok) throw new Error("unavailable");
    const answer = await response.json();
    if (student !== sessionRequest()?.student_id || room) return;
    if (answer.available && answer.student_id === student) {
      recoverable = answer;
      $("resume").hidden = false;
      $("join").textContent = recoveryText("restart");
      $("recovery-note").textContent = recoveryText("available");
      $("recovery-note").hidden = false;
    }
  } catch {
    if (student !== sessionRequest()?.student_id || room) return;
    $("recovery-note").textContent = recoveryText("check_failed");
    $("recovery-note").hidden = false;
  }
}

async function explainClose(id, connectionLost) {
  for (const delay of [0, 500, 1500]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (room || !id) return;
    try {
      const response = await fetch("api/session/recovery");
      if (!response.ok) break;
      const answer = await response.json();
      if (room || (answer.session_id && answer.session_id !== id)) return;
      if (answer.available) {
        showMessage(recoveryText("lost"));
        return;
      }
      if (answer.end_reason) return showMessage(endedMessage(answer.end_reason, answer.language));
    } catch { break; }
  }
  if (!room) showMessage(connectionLost
    ? recoveryText("lost_unknown")
    : endedMessage(null, sessionRequest()?.language));
}

function finishSession(message = endedMessage("child_ended", sessionRequest()?.language)) {
  const id = sessionId;
  leave(message);
  if (id) sessionAction("end", { session_id: id }).catch(() => {
    if (!room) showMessage(recoveryText("close_failed"));
  });
}

function showMessage(text) {
  message.textContent = text;
  message.hidden = !text;
}

// For something that went wrong once and can be tried again: it does not stay
// on the screen for the rest of the session.
const PASSING_MS = 8000;
function showPassingMessage(text) {
  showMessage(text);
  setTimeout(() => {
    if (message.textContent === text) showMessage("");
  }, PASSING_MS);
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
// that cannot run it, the dot stays.
customElements.whenDefined("wobnimo-mascot").then(() => $("tutor").classList.add("has-mascot"));

function setTutorState(state) {
  $("tutor").dataset.state = state;
  $("tutor-state").textContent = STATE_TEXT[state] ?? state;
  $("mascot").setAttribute("state", MASCOT_STATE[state] ?? "idle");
}

function setToggle(button, label, on) {
  button.setAttribute("aria-pressed", String(on));
  // "Cámara apagada", "Micrófono apagado": the word follows the thing's gender.
  const off = label.split(" ")[0].endsWith("a") ? "apagada" : "apagado";
  button.textContent = on ? label : `${label} ${off}`;
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
    line.dataset.name = mine ? "Tú" : "Aule";
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
  document.querySelector(".work").classList.remove("with-card");
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
  document.querySelector(".work").classList.toggle("with-card", Boolean(card));
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
  // the one before does not stay next to it.
  $("board").hidden = true;
  boardShows = null;
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
    // What they wrote is part of the conversation too.
    const line = item(explanation ? `${written}. ${explanation}` : written);
    line.dataset.who = "you";
    line.dataset.name = "Tú (escrito)";
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

// The tutor describes what to show; the page draws it.
// The ink screen shows what the device would: the drawing, or else the
// exercise in hand, which the card shows in words and the board skips. So the
// last exercise is kept, and the screen says so when there is nothing yet. It
// starts on: it is how a family sees what the device would show.
let inkMode = true;
let lastExercise = null;
// What the board shows: a drawing's kind, "waiting", or null when empty.
let boardShows = null;

function draw(visual) {
  $("board").innerHTML = renderVisual(visual);
  $("board").hidden = false;
  boardShows = visual.kind;
  // The panel flashes when it redraws.
  $("board").classList.remove("redraw");
  void $("board").offsetWidth;
  $("board").classList.add("redraw");
}

function showInk() {
  if (boardShows && boardShows !== "waiting") return;
  if (lastExercise) return draw(lastExercise);
  const waiting = document.createElement("p");
  waiting.className = "ink-waiting";
  waiting.textContent = "Aquí aparece lo que mostraría la pantalla de tinta: los dibujos de Aule y el ejercicio del momento.";
  $("board").replaceChildren(waiting);
  $("board").hidden = false;
  boardShows = "waiting";
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
    setToggle($("mic"), "Micrófono", true);
  }
  manualTurns = manual;
  tutorReady = ready;
  talking = false;
  showTalk();
  syncMicrophone();
}

// While the connection is down the tutor neither hears nor is heard, and the
// last state it reported would be shown as if it were still true.
function showConnection(lost) {
  if (lost) return setTutorState("reconnecting");
  const tutor = [...(room?.remoteParticipants.values() ?? [])].find(
    (participant) => participant.kind === ParticipantKind.AGENT,
  );
  if (tutor) watchTutor(tutor);
  else setTutorState("left");
}

// Open only when the tutor is there and turns end by themselves; with a talk
// button the microphone is closed between turns.
function syncMicrophone() {
  return room?.localParticipant.setMicrophoneEnabled(wanted.mic && tutorReady && !manualTurns);
}

// A phone has no space bar to mention.
const touchOnly = matchMedia("(pointer: coarse)").matches && !matchMedia("(pointer: fine)").matches;

// Without the talk button the switch is the microphone's mute; with it, the
// talk button is the only microphone button.
function showTalk() {
  $("talk").hidden = !manualTurns;
  $("mic").hidden = manualTurns;
  // On a phone the button then stays at the bottom of the screen (style.css).
  document.querySelector("main").classList.toggle("push-to-talk", manualTurns);
  $("talk").disabled = !wanted.mic;
  $("talk").setAttribute("aria-pressed", String(talking));
  $("talk").textContent = !wanted.mic
    ? "El micrófono está apagado"
    : talking
      ? "Te escucho… suelta para enviar"
      : touchOnly
        ? "Mantén apretado para hablar"
        : "Mantén apretado para hablar (o la barra espaciadora)";
}

function turn(method) {
  return room.localParticipant.performRpc({ destinationIdentity: tutorIdentity, method, payload: "" });
}

async function startTalking() {
  if (!room || !manualTurns || talking || !wanted.mic || !tutorIdentity) return;
  talking = true;
  heldLines = [];
  showTalk();
  try {
    await room.localParticipant.setMicrophoneEnabled(true);
    await turn("start_turn");
  } catch {
    await stopTalking("cancel_turn");
    showMessage("No se pudo avisar a Aule que estás hablando. Inténtalo otra vez.");
  }
}

async function stopTalking(method = "end_turn") {
  if (!talking) return;
  talking = false;
  showTalk();
  const speaking = room;
  if (method === "end_turn") await new Promise((done) => setTimeout(done, TALK_TAIL_MS));
  if (!speaking || speaking !== room) return;
  try {
    await turn(method);
  } catch {
    if (method === "end_turn") showMessage("Aule no lo escuchó. Mantén apretado el botón y dilo otra vez.");
  }
  if (!talking) await speaking.localParticipant.setMicrophoneEnabled(false);
}

function showCamera() {
  const publication = room.localParticipant.getTrackPublication(Track.Source.Camera);
  const on = Boolean(publication?.track) && !publication.isMuted;
  if (on) publication.track.attach($("camera"));
  $("camera").hidden = !on;
  $("camera-off").hidden = on;
  $("camera-off").textContent = photos ? "La cámara se enciende solo cuando muestras tu tarea" : "Cámara apagada";
  if (photos) {
    $("cam").setAttribute("aria-pressed", String(showing));
    $("cam").textContent = showing ? "Mostrando…" : "Mostrar mi tarea";
    $("cam").disabled = showing;
  } else {
    $("cam").disabled = false;
    setToggle($("cam"), "Cámara", on);
  }
}

// With a tutor that takes pictures, nothing is filmed between them.
function usePhotos(on) {
  if (on === photos || !room) return;
  photos = on;
  if (on && !showing) room.localParticipant.setCameraEnabled(false).then(showCamera, showCamera);
  else showCamera();
}

// One picture of the work: the camera goes on, the tutor is told to look, and
// the camera goes off again.
async function showWork() {
  if (showing || !room || !tutorIdentity) return;
  showing = true;
  showMessage("");
  try {
    await room.localParticipant.setCameraEnabled(true);
    showCamera();
    // The default timeout on purpose: the tutor waits up to two seconds for a
    // frame, and a shorter limit here would cut that wait.
    const seen = await room.localParticipant.performRpc({
      destinationIdentity: tutorIdentity,
      method: "show_work",
      payload: "",
    });
    if (seen !== "ok") throw new Error("no frame");
    // The tutor hears a fixed line for this; the page writes the same one.
    const line = item("Mira mi trabajo.");
    line.dataset.who = "you";
    line.dataset.name = "Tú";
    $("transcript").append(line);
    followTranscript(true);
    await new Promise((resolve) => setTimeout(resolve, SHOWN_MS));
  } catch {
    showPassingMessage("Aule no pudo ver la cámara. Acerca la hoja e inténtalo otra vez.");
  } finally {
    showing = false;
    await room?.localParticipant.setCameraEnabled(false).catch(() => undefined);
    if (room) showCamera();
  }
}

async function join(session) {
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
    // The camera is for showing work: the one facing the table when there are
    // two, and sharp enough to read handwriting.
    videoCaptureDefaults: { facingMode: "environment", resolution: { width: 1280, height: 720 } },
  });

  const connectedRoom = room;
  room
    .on(RoomEvent.ParticipantConnected, watchTutor)
    .on(RoomEvent.ParticipantAttributesChanged, (_changed, participant) => watchTutor(participant))
    .on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (participant.kind === ParticipantKind.AGENT) setTutorState("left");
    })
    .on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) $("audio").append(track.attach());
    })
    .on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((el) => el.remove()))
    .on(RoomEvent.LocalTrackPublished, showCamera)
    .on(RoomEvent.TrackMuted, showCamera)
    .on(RoomEvent.TrackUnmuted, showCamera)
    .on(RoomEvent.Reconnecting, () => showConnection(true))
    .on(RoomEvent.SignalReconnecting, () => showConnection(true))
    .on(RoomEvent.Reconnected, () => showConnection(false))
    .on(RoomEvent.Disconnected, (reason) => {
      if (room !== connectedRoom) return;
      const id = sessionId;
      leave(recoveryText("checking"));
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
  tutorTimer = setTimeout(() => setTutorState("missing"), TUTOR_WAIT_MS);
  room.remoteParticipants.forEach(watchTutor);
  sessionId = session.session_id ?? null;
  startClock(session.expiresInSeconds);
  if (session.session_id && session.engine === true) followSteps(session.session_id);
  lobby.hidden = true;
  stage.hidden = false;
  if (inkMode) showInk();
  play(hello);
  // The layout of a session hangs on this class, not on :has(), which older
  // Firefox and Safari do not know.
  document.querySelector("main").classList.toggle("in-session", true);

  await syncMicrophone();
  setToggle($("mic"), "Micrófono", wanted.mic);
  showTalk();
  try {
    await room.localParticipant.setCameraEnabled(wanted.cam);
  } catch {
    // No camera, or the person said no: the tutor still works by voice.
  }
  showCamera();
}

function stopPreview() {
  cancelAnimationFrame(meter?.frame);
  meter?.context.close().catch(() => undefined);
  meter = null;
  preview?.getTracks().forEach((track) => track.stop());
  preview = null;
  $("preview").srcObject = null;
}

function showPreview() {
  const video = preview?.getVideoTracks()[0];
  const audio = preview?.getAudioTracks()[0];
  if (video) video.enabled = wanted.cam;
  if (audio) audio.enabled = wanted.mic;
  const seen = Boolean(video) && wanted.cam;
  $("preview").hidden = !seen;
  $("preview-off").hidden = seen;
  $("level").hidden = !(audio && wanted.mic);
  setToggle($("lobby-mic"), "Micrófono", wanted.mic);
  setToggle($("lobby-cam"), "Cámara", wanted.cam);
}

// Moves a bar with the loudness of the microphone, so the person can tell it
// hears them before they join.
function startMeter(stream) {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  const bar = $("level").firstElementChild;
  meter = { context, frame: 0 };
  const draw = () => {
    analyser.getByteTimeDomainData(samples);
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample - 128));
    bar.style.width = `${Math.min(100, Math.round((peak / 128) * 250))}%`;
    if (meter) meter.frame = requestAnimationFrame(draw);
  };
  draw();
}

async function openLobby() {
  wanted.mic = true;
  wanted.cam = true;
  $("lobby-note").textContent = "";
  entry.hidden = true;
  lobby.hidden = false;
  // Joining waits until the devices have answered, so only one thing holds them.
  $("join").disabled = true;
  let usable = true;
  try {
    preview = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: { facingMode: { ideal: "environment" } },
    });
  } catch {
    // No camera, or only the camera was refused: try the microphone alone.
    wanted.cam = false;
    try {
      preview = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      $("lobby-note").textContent = "No se encontró o no se permitió la cámara. Igual puedes entrar con voz.";
    } catch {
      wanted.mic = false;
      $("lobby-note").textContent =
        "El navegador bloqueó el micrófono. Permítelo en la barra de direcciones y vuelve a intentarlo.";
      usable = false;
    }
  }
  if (lobby.hidden) return stopPreview();
  $("join").disabled = !usable;
  if (preview) {
    $("preview").srcObject = preview;
    if (preview.getAudioTracks().length) startMeter(preview);
  }
  showPreview();
}

function closeLobby() {
  stopPreview();
  lobby.hidden = true;
  entry.hidden = false;
}

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

function leave(reason) {
  if (!room) return;
  const leaving = room;
  room = null;
  play(goodbye);
  clearInterval(clock);
  clearTimeout(tutorTimer);
  stopSteps();
  tutorIdentity = null;
  photos = false;
  showing = false;
  tutorReady = false;
  manualTurns = false;
  talking = false;
  showTalk();
  leaving.disconnect();
  $("audio").replaceChildren();
  $("board").replaceChildren();
  $("board").hidden = true;
  boardShows = null;
  lastExercise = null;
  stage.hidden = true;
  document.querySelector("main").classList.toggle("in-session", false);
  lobby.hidden = true;
  entry.hidden = false;
  showMessage(reason ?? "");
  sessionId = null;
}

// A signed-in person who has chosen a student goes to the lobby.
onEnter(() => {
  showMessage("");
  openLobby();
  offerRecovery();
});

$("lobby-mic").addEventListener("click", () => {
  wanted.mic = !wanted.mic;
  showPreview();
});

$("lobby-cam").addEventListener("click", () => {
  if (!preview?.getVideoTracks().length) return;
  wanted.cam = !wanted.cam;
  showPreview();
});

$("back").addEventListener("click", closeLobby);

$("join").addEventListener("click", async () => {
  readySounds();
  $("join").disabled = true;
  $("transcript").replaceChildren();
  following = true;
  lines.clear();
  try {
    if (recoverable) {
      await sessionAction("end", { session_id: recoverable.session_id });
      recoverable = null;
      $("resume").hidden = true;
    }
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
    const text =
      error?.name === "NotAllowedError"
        ? "El navegador bloqueó el micrófono. Permítelo y empieza otra vez."
        : (error?.message ?? "No se pudo empezar la sesión.");
    if (room) leave(text);
    else {
      closeLobby();
      showMessage(text);
    }
  }
});

$("resume").addEventListener("click", async () => {
  if (!recoverable || room) return;
  $("resume").disabled = true;
  $("join").disabled = true;
  readySounds();
  try {
    const session = await sessionAction("resume", {
      session_id: recoverable.session_id, student_id: sessionRequest()?.student_id,
    });
    if (!session.token) throw new Error(endedMessage(session.end_reason, session.language));
    stopPreview();
    $("transcript").replaceChildren();
    lines.clear();
    following = true;
    await join(session);
  } catch (error) {
    if (room) leave(error?.message);
    else showMessage(error?.message ?? recoveryText("failed"));
    $("resume").disabled = false;
    $("join").disabled = false;
  }
});

$("mic").addEventListener("click", async () => {
  wanted.mic = !wanted.mic;
  setToggle($("mic"), "Micrófono", wanted.mic);
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
const typing = (target) => ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(target?.tagName);
document.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat || !manualTurns || stage.hidden || typing(event.target)) return;
  event.preventDefault();
  startTalking();
});
document.addEventListener("keyup", (event) => {
  if (event.code === "Space" && talking) stopTalking();
});
// A turn nobody is holding any more is dropped, not sent.
window.addEventListener("blur", () => stopTalking("cancel_turn"));

$("device").addEventListener("click", () => {
  inkMode = !inkMode;
  $("board").classList.toggle("device", inkMode);
  setToggle($("device"), "Modo tinta", inkMode);
  if (inkMode) return showInk();
  // Back to the page's own board: no waiting note, and no exercise next to its card.
  if (boardShows === "waiting" || (boardShows === "exercise" && !$("card").hidden)) {
    $("board").replaceChildren();
    $("board").hidden = true;
    boardShows = null;
  }
});

$("cam").addEventListener("click", async () => {
  if (photos) return showWork();
  await room.localParticipant.setCameraEnabled(!room.localParticipant.isCameraEnabled);
  showCamera();
});

$("type").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("typed").value.trim();
  if (!text || !room) return;
  $("typed").value = "";
  try {
    await room.localParticipant.sendText(text, { topic: CHAT_TOPIC });
    // Typed words are not transcribed back, so the page writes them itself.
    const line = item(text);
    line.dataset.who = "you";
    line.dataset.name = "Tú (escrito)";
    $("transcript").append(line);
    // Their own message: back to the end, wherever they had scrolled to.
    followTranscript(true);
  } catch {
    showMessage("No se pudo enviar el mensaje.");
  }
});

$("end").addEventListener("click", () => finishSession());
