// «Mostrar mi tarea» in two steps (FIGMA.md D31): the page's own handlers, run
// with a stand-in for the room and the camera, so what reaches the room can be
// counted. Nothing of the camera may be published before «Listo», nor ever
// after «Cancelar» or the wait, and «Listo» publishes the camera the child
// pointed, never a second one. The stand-in publishes as livekit-client does:
// the room has the publication only once the publish is done, and
// unpublishTrack waits for a publish still on its way. The keyboard's place is
// never left on «Listo» or «Cancelar», where Space, the talk key, would press them.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const handlers = ["aimCamera", "focusTalk", "stopAiming", "showWork"]
  .map((name) => {
    const source = app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
    assert.ok(source, name);
    return source;
  })
  .join("\n");
const AIM_MS = Number(app.match(/const AIM_MS = ([\d_]+);/)?.[1].replaceAll("_", ""));
const SHOWN_MS = Number(app.match(/const SHOWN_MS = (\d+);/)?.[1]);

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** The handlers with a room, a camera and timers the test holds; `events` is everything that reached them, in order. */
function page() {
  const events = [];
  const published = [];
  const tracks = [];
  const messages = [];
  const elements = new Map();
  const document = { body: { id: "body" }, activeElement: null };
  document.activeElement = document.body;
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        hidden: true,
        disabled: false,
        focused: false,
        scrolled: false,
        words: "",
        focus() {
          if (this.hidden || this.disabled) return;
          if (document.activeElement?.focused !== undefined) document.activeElement.focused = false;
          this.focused = true;
          document.activeElement = this;
        },
        scrollIntoView() {
          this.scrolled = true;
        },
      });
    }
    return elements.get(id);
  };
  // The session's own controls, as they are while it runs with held turns; the camera's line is
  // never hidden, only empty.
  element("talk").hidden = false;
  element("session-title").hidden = false;
  element("camera-aim").hidden = false;
  // The wait for «Listo» is held by the test; the moment after the picture passes at once.
  const timers = new Map();
  let nextTimer = 0;
  const camera = () => {
    const track = {
      source: "camera",
      stopped: false,
      stop() {
        if (!this.stopped) events.push("stop");
        this.stopped = true;
      },
      attach() {},
      detach() {},
    };
    tracks.push(track);
    return track;
  };
  // A publish is done when the test says (`publishing`), or at once; only then does the room have it.
  let publishing = null;
  const pending = new Map();
  const participant = {
    publications: [],
    getTrackPublication(source) {
      return this.publications.find((publication) => publication.source === source);
    },
    publishTrack(track, options) {
      events.push("publish");
      published.push({ track, options });
      const done = (publishing?.promise ?? Promise.resolve()).then(() => {
        const publication = { track, source: options?.source, isMuted: false };
        this.publications.push(publication);
        pending.delete(track);
        return publication;
      });
      pending.set(track, done);
      return done;
    },
    async unpublishTrack(track) {
      if (pending.has(track)) await pending.get(track);
      const publication = this.publications.find((one) => one.track === track);
      // livekit-client warns, and does nothing else, for a track it never published.
      if (!publication) return events.push("unpublish of nothing");
      events.push("unpublish");
      this.publications = this.publications.filter((one) => one !== publication);
    },
    async performRpc({ method }) {
      events.push(`rpc:${method}`);
      return "ok";
    },
  };
  const state = {
    showing: false,
    aiming: false,
    aimTimer: 0,
    aimTrack: null,
    sent: null,
    manualTurns: true,
    document,
    room: { localParticipant: participant },
    tutorIdentity: "synthetic-tutor",
    Track: { Source: { Camera: "camera" } },
    CAMERA: { facingMode: "environment" },
    AIM_MS,
    SHOWN_MS,
    async createLocalVideoTrack() {
      events.push("camera");
      return camera();
    },
    setTimeout(done, ms) {
      if (ms === AIM_MS) {
        nextTimer += 1;
        timers.set(nextTimer, done);
        return nextTimer;
      }
      return setTimeout(done, 0);
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    $: element,
    writeWords(target, key) {
      target.words = key;
    },
    hideKeepingFocus(button) {
      button.hidden = true;
    },
    showCamera() {},
    showCoach() {
      events.push(`coach:${state.aiming ? "waits" : "back"}`);
    },
    showMessage() {},
    showPassingMessage(text) {
      messages.push(text);
    },
    words: (key) => key,
    cameraProblem: (name) => (name === "NotAllowedError" ? "camera_blocked" : "camera_unseen"),
    sessionLanguage: () => "es",
    item: () => ({ dataset: {} }),
    followTranscript() {},
  };
  state.$("transcript").append = () => events.push("transcript");
  runInNewContext(handlers, state);
  /** The wait for «Listo» runs out. */
  const waitRunsOut = async () => {
    for (const [id, done] of timers) {
      timers.delete(id);
      done();
    }
    await tick();
  };
  /** The next publish is done only when `publishing.resolve()` is called. */
  const holdPublish = () => {
    publishing = deferred();
    return publishing;
  };
  return { state, events, published, tracks, messages, element, timers, waitRunsOut, holdPublish, document };
}

const publishes = (events) => events.filter((event) => event === "publish").length;
// The coach's waits and returns, which the camera's steps say on the way.
const camera = (events) => events.filter((event) => !event.startsWith("coach:"));

test("«Mostrar mi tarea» asks for the camera once and shows it here, publishing nothing", async () => {
  const { state, events, element, timers, document } = page();
  await state.aimCamera();
  assert.deepEqual(camera(events), ["camera"], "one camera, and nothing published");
  assert.equal(state.aiming, true);
  assert.ok(state.aimTrack);
  assert.equal(element("cam-send").hidden, false);
  assert.equal(element("cam-cancel").hidden, false);
  // The keyboard's place is the line that says what to do: «Listo» is the next Tab, not the
  // focus, so Space, the talk key, cannot send a picture. «Listo» is scrolled into sight.
  assert.equal(document.activeElement, element("camera-aim"));
  assert.equal(element("cam-send").focused, false);
  assert.equal(element("cam-send").scrolled, true);
  assert.equal(element("camera-aim").words, "camera_aim");
  // The coach waits while the child aims.
  assert.ok(events.includes("coach:waits"));
  assert.equal(timers.size, 1, "the wait for «Listo» has started");
  // Pressed again while the child aims, nothing more is asked for.
  await state.aimCamera();
  assert.deepEqual(camera(events), ["camera"]);
});

test("«Cancelar» turns the camera off without it ever being published, and the keyboard goes back to the talk button", async () => {
  const { state, events, tracks, element, timers, document } = page();
  await state.aimCamera();
  element("cam-cancel").focus();
  await state.stopAiming();
  assert.equal(publishes(events), 0);
  assert.deepEqual(camera(events), ["camera", "stop"], "nothing to take back from the room");
  assert.equal(tracks[0].stopped, true);
  assert.equal(state.aiming, false);
  assert.equal(state.aimTrack, null);
  assert.equal(element("cam-send").hidden, true);
  assert.equal(element("cam-cancel").hidden, true);
  assert.equal(element("camera-aim").words, "", "the status is emptied, not hidden");
  assert.equal(document.activeElement, element("talk"), "the talk button, which Space holds");
  assert.equal(element("cam").focused, false, "not «Mostrar mi tarea», where Space would open the camera again");
  assert.ok(events.indexOf("coach:back") > events.indexOf("coach:waits"), "the coach comes back");
  assert.equal(timers.size, 0, "and the wait is over");
  // «Listo» after that sends nothing.
  await state.showWork();
  assert.equal(publishes(events), 0);
});

test("with an open microphone the keyboard goes back to «Mostrar mi tarea», and to the title when nothing else can take it", async () => {
  const open = page();
  open.state.manualTurns = false;
  open.element("talk").hidden = true;
  await open.state.aimCamera();
  open.element("cam").hidden = false;
  await open.state.stopAiming();
  assert.equal(open.document.activeElement, open.element("cam"));
  const none = page();
  none.element("talk").disabled = true;
  await none.state.aimCamera();
  await none.state.stopAiming();
  assert.equal(none.document.activeElement, none.element("session-title"));
});

test("after 30 seconds with nothing the camera turns off, never published, and the keyboard is moved only from the camera's row", async () => {
  assert.equal(AIM_MS, 30_000);
  const { state, events, tracks, element, waitRunsOut, document } = page();
  await state.aimCamera();
  await waitRunsOut();
  assert.equal(publishes(events), 0);
  assert.equal(tracks[0].stopped, true);
  assert.equal(state.aiming, false);
  assert.equal(document.activeElement, element("talk"), "from the emptied line to the talk button");
  await state.showWork();
  assert.equal(publishes(events), 0, "a late «Listo» sends nothing");
  // A child who went on to type keeps the focus where it is.
  const typing = page();
  await typing.state.aimCamera();
  typing.element("typed").hidden = false;
  typing.element("typed").focus();
  await typing.waitRunsOut();
  assert.equal(typing.document.activeElement, typing.element("typed"));
});

test("«Listo» publishes the same camera, asks the tutor at once, and turns it off after the moment it stays", async () => {
  const { state, events, published, tracks, element, timers } = page();
  await state.showWork();
  assert.deepEqual(events, [], "nothing to send before «Mostrar mi tarea»");
  await state.aimCamera();
  const pointed = state.aimTrack;
  await state.showWork();
  assert.deepEqual(camera(events), ["camera", "publish", "rpc:show_work", "transcript", "unpublish", "stop"]);
  assert.equal(tracks.length, 1, "no second ask for the camera");
  assert.equal(published[0].track, pointed);
  // Made in the page's own realm: compared field by field.
  assert.deepEqual(Object.entries(published[0].options), [["source", "camera"]]);
  assert.equal(state.aimTrack, null);
  assert.equal(state.sent, null, "taken back");
  assert.equal(state.showing, false);
  assert.equal(element("cam-send").disabled, false);
  assert.equal(element("cam-cancel").disabled, false);
  assert.equal(timers.size, 0);
  assert.equal(SHOWN_MS, 1500);
});

test("while «Listo» sends the picture, neither «Listo» nor «Cancelar» can be pressed, and the wait cannot turn the camera off", async () => {
  const { state, events, timers, element } = page();
  const answer = deferred();
  state.room.localParticipant.performRpc = async ({ method }) => {
    events.push(`rpc:${method}`);
    return answer.promise;
  };
  await state.aimCamera();
  const sending = state.showWork();
  await tick();
  assert.equal(timers.size, 0, "the wait ended as «Listo» was pressed");
  assert.equal(element("cam-send").disabled, true);
  assert.equal(element("cam-cancel").disabled, true);
  assert.equal(events.includes("stop"), false);
  answer.resolve("ok");
  await sending;
  assert.deepEqual(camera(events).slice(-2), ["unpublish", "stop"]);
  assert.equal(element("cam-cancel").disabled, false);
});

test("a camera turned off while «Listo» is still publishing it is taken back once it is there, and the tutor is never asked to look", async () => {
  const { state, events, tracks, holdPublish, document, element } = page();
  const publish = holdPublish();
  await state.aimCamera();
  element("cam-send").focus();
  const sending = state.showWork();
  await tick();
  assert.deepEqual(camera(events), ["camera", "publish"], "the publish is on its way");
  // The camera goes off before the room has its publication (as «Cancelar» did, or the session's end).
  const stopping = state.stopAiming();
  await tick();
  assert.equal(events.includes("unpublish"), false, "nothing to take back yet: it waits for the publish");
  publish.resolve();
  await stopping;
  await sending;
  assert.deepEqual(camera(events), ["camera", "publish", "unpublish", "stop"], "taken back once, by the track, and stopped");
  assert.equal(events.some((event) => event.startsWith("rpc:")), false, "the tutor is not asked to look");
  assert.equal(events.includes("unpublish of nothing"), false);
  assert.equal(tracks[0].stopped, true);
  assert.equal(state.room.localParticipant.publications.length, 0, "no publication is left in the room");
  assert.equal(state.sent, null);
  assert.equal(document.activeElement, element("talk"));
});

test("a publish that fails is said as a picture not seen, and nothing is taken back that was never there", async () => {
  const { state, events, messages, tracks } = page();
  state.room.localParticipant.publishTrack = async () => {
    events.push("publish");
    throw new Error("synthetic failure");
  };
  await state.aimCamera();
  await state.showWork();
  assert.deepEqual(messages, ["camera_unseen"]);
  assert.equal(events.some((event) => event.startsWith("unpublish")), false, "livekit-client would warn of a track it never published");
  assert.equal(events.some((event) => event.startsWith("rpc:")), false);
  assert.equal(tracks[0].stopped, true);
  assert.equal(state.sent, null);
});

test("a camera the browser refuses is said as such, and nothing is published", async () => {
  const { state, events, messages, element } = page();
  state.createLocalVideoTrack = async () => {
    events.push("camera");
    throw Object.assign(new Error("refused"), { name: "NotAllowedError" });
  };
  await state.aimCamera();
  assert.deepEqual(messages, ["camera_blocked"]);
  assert.equal(state.aiming, false);
  assert.equal(element("cam-send").hidden, true);
  assert.equal(publishes(events), 0);
});

test("a session that ends while the browser asks for the camera turns it off at once, unshown and unpublished", async () => {
  const { state, events, tracks, element } = page();
  const asked = deferred();
  state.createLocalVideoTrack = () => {
    events.push("camera");
    return asked.promise;
  };
  const pressing = state.aimCamera();
  // teardown(): the room goes and the aim with it.
  state.room = null;
  state.aiming = false;
  const late = { stopped: false, stop() { this.stopped = true; } };
  tracks.push(late);
  asked.resolve(late);
  await pressing;
  assert.equal(late.stopped, true);
  assert.equal(state.aimTrack, null);
  assert.equal(element("cam-send").hidden, true);
  assert.equal(publishes(events), 0);
});

test("a picture the tutor could not see is said, and the camera still goes off", async () => {
  const { state, events, messages } = page();
  state.room.localParticipant.performRpc = async ({ method }) => {
    events.push(`rpc:${method}`);
    return "no_frame";
  };
  await state.aimCamera();
  await state.showWork();
  assert.deepEqual(messages, ["camera_unseen"]);
  assert.deepEqual(camera(events).slice(-2), ["unpublish", "stop"]);
  assert.equal(events.includes("transcript"), false);
});
