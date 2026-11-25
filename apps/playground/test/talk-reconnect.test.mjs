import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
// Run the actual page handlers with controllable microphone/RPC promises. This
// exercises races without a browser, a real microphone or an outside service.
const handlers = ["turn", "startTalking", "stopTalking", "showConnection", "syncMicrophone", "showTalk"]
  .map(name => {
    const source = app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
    assert.ok(source, name);
    return source;
  }).join("\n");
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

function page() {
  const mic = [], rpc = [], messages = [];
  const button = { setAttribute() {} };
  const state = {
    manualTurns: true, talking: false, tutorReady: true, tutorIdentity: "synthetic-tutor",
    wanted: { mic: true }, connectionLost: false, turnGeneration: 0,
    talkStarted: Promise.resolve(false), closingTurn: false,
    heldAt: 0, talkVoice: null, heldLines: [], touchOnly: true,
    performance, setTimeout, TALK_TAIL_MS: 5, ParticipantKind: { AGENT: 4 },
    room: {
      remoteParticipants: new Map([["tutor", { kind: 4 }]]),
      localParticipant: {
        async setMicrophoneEnabled(on) { mic.push(on); },
        async performRpc({ method }) { rpc.push(method); },
      },
    },
    $: () => button, document: { querySelector: () => ({ classList: { toggle() {} } }) },
    writeWords() {}, showCoach() {}, coachAfter() {}, startTalkMeter() {}, stopTalkMeter() {},
    watchTutor() {}, setTutorState() {}, showMessage: message => messages.push(message),
  };
  runInNewContext(handlers, state);
  return { state, mic, rpc, messages, button };
}

test("a signalling cut mutes immediately, cancels the held turn and needs a fresh press", async () => {
  const { state, mic, rpc, button } = page();
  await state.startTalking();
  assert.deepEqual(rpc, ["start_turn"]);
  await state.showConnection(true);
  assert.equal(mic.at(-1), false);
  assert.equal(state.talking, false);
  assert.equal(button.disabled, true);
  await state.startTalking();
  await tick();
  assert.deepEqual(rpc, ["start_turn"], "no RPC can commit partial speech while offline");
  await state.showConnection(false);
  assert.deepEqual(rpc, ["start_turn", "cancel_turn"]);
  assert.equal(button.disabled, false);
  assert.equal(mic.at(-1), false, "reconnect must not reopen a held microphone");
  await state.startTalking();
  await state.stopTalking();
  assert.deepEqual(rpc, ["start_turn", "cancel_turn", "start_turn", "end_turn"]);
  assert.equal(mic.at(-1), false);
});

test("a microphone opening after the cut is muted without starting or ending a turn", async () => {
  const { state, mic, rpc } = page();
  const opening = deferred();
  state.room.localParticipant.setMicrophoneEnabled = async on => {
    mic.push(on);
    if (on) await opening.promise;
  };
  const pressed = state.startTalking();
  await state.showConnection(true);
  opening.resolve();
  await pressed;
  await tick();
  assert.equal(mic.at(-1), false);
  assert.deepEqual(rpc, []);
  await state.showConnection(false);
  assert.deepEqual(rpc, ["cancel_turn"]);
});

test("a delayed start RPC cannot send an end turn after the network is lost", async () => {
  const { state, rpc, mic } = page();
  const starting = deferred();
  state.room.localParticipant.performRpc = async ({ method }) => {
    rpc.push(method);
    if (method === "start_turn") await starting.promise;
  };
  const pressed = state.startTalking();
  await tick();
  const released = state.stopTalking();
  await state.showConnection(true);
  starting.resolve();
  await Promise.all([pressed, released]);
  await state.showConnection(false);
  assert.deepEqual(rpc, ["start_turn", "cancel_turn"]);
  assert.equal(mic.at(-1), false);
});

test("a cut during the final audio tail cancels the queued end", async () => {
  const { state, rpc } = page();
  const tail = deferred();
  state.setTimeout = done => tail.promise.then(done);
  await state.startTalking();
  const released = state.stopTalking();
  await tick();
  await state.showConnection(true);
  tail.resolve();
  await released;
  await state.showConnection(false);
  assert.deepEqual(rpc, ["start_turn", "cancel_turn"]);
});

test("another cut while clearing the old turn keeps controls disabled", async () => {
  const { state, button } = page();
  await state.showConnection(true);
  const cancel = deferred();
  state.room.localParticipant.performRpc = () => cancel.promise;
  const reconnect = state.showConnection(false);
  await tick();
  await state.showConnection(true);
  cancel.resolve();
  await reconnect;
  assert.equal(state.connectionLost, true);
  assert.equal(button.disabled, true);
});

test("a failed start cannot commit an end, and the child can try a fresh press", async () => {
  const { state, rpc, mic, messages } = page();
  state.room.localParticipant.performRpc = async ({ method }) => {
    rpc.push(method);
    if (method === "start_turn") throw new Error("synthetic failure");
  };
  const pressed = state.startTalking();
  await tick();
  await state.stopTalking();
  await pressed;
  assert.deepEqual(rpc, ["start_turn"]);
  assert.equal(mic.at(-1), false);
  assert.equal(messages.length, 1);
  assert.equal(state.talking, false);
  assert.equal(state.closingTurn, false);
});

test("automatic turns respect the microphone switch when reconnecting", async () => {
  const { state, mic, rpc } = page();
  state.manualTurns = false;
  state.wanted.mic = false;
  await state.showConnection(true);
  await state.showConnection(false);
  assert.equal(mic.at(-1), false);
  assert.deepEqual(rpc, []);
  state.wanted.mic = true;
  await state.showConnection(true);
  assert.equal(mic.at(-1), false);
  await state.showConnection(false);
  assert.equal(mic.at(-1), true);
});
