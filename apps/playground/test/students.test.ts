import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";

import { readSettings } from "../src/config.ts";
import { createPlayground } from "../src/server.ts";
import { objectiveFrom, profileFrom } from "../src/students.ts";
import { COMPLETE } from "./fixtures.ts";
import { teachingResource } from "../public/teaching-resources.js";

const TOKEN = "cd".repeat(32);
const LIAM = "01a1f5f4-ede7-7028-a524-9d8e2f36b92c";
const SOFIA = "02a1f5f4-ede7-7028-a524-9d8e2f36b92c";
const NEW = "03a1f5f4-ede7-7028-a524-9d8e2f36b92c";
const MEMORY = "04a1f5f4-ede7-7028-a524-9d8e2f36b92c";
const SUBJECTS = ["matematica", "comunicacion", "ciencia", "personal_social", "ingles"];

// Stands in for the platform: one family with two students. Sofía cannot be
// read, as when the platform is slow or the student was just removed.
const seen: { method: string; path: string; auth: string | undefined; body: unknown }[] = [];
let keepsSubjects = true;
// The platform's reviews answer 503 while this is set.
let failReviews = false;
const liam = () => ({
  id: LIAM,
  family_id: "fam-1",
  nickname: "Liam",
  birth_year: 2016,
  grade: "P4",
  language: "es",
  interests: ["fútbol", "robots"],
  notes: "from the team",
  tutor_name: "Aule",
  tutor_persona: "aventurero",
  tutor_persona_note: "Ve despacio.",
  ...(keepsSubjects ? { subjects: ["matematica", "latin"] } : {}),
});
const platform = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  const body = text ? JSON.parse(text) : null;
  const path = request.url ?? "";
  const method = request.method ?? "";
  seen.push({ method, path, auth: request.headers.authorization, body });
  const answer = (status: number, value: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  };
  if (path === "/v1/auth/google") return answer(200, { client_id: "client-1" });
  if (request.headers.authorization !== `Bearer ${TOKEN}`) return answer(401, { error: { message: "who?" } });
  if (path === "/v1/me") {
    return answer(200, {
      guardian: { name: "Ana" },
      family_id: "fam-1",
      children: [
        { id: LIAM, nickname: "Liam" },
        { id: SOFIA, nickname: "Sofía" },
      ],
      ...(keepsSubjects ? { subjects: SUBJECTS } : {}),
    });
  }
  if (path === `/v1/children/${LIAM}` && method === "GET") {
    return answer(200, { child: liam(), consent: { voice: true, memory: true, transcripts: false }, relationship: "GRMTH" });
  }
  if (path === `/v1/children/${LIAM}` && method === "PUT") return answer(200, liam());
  if (path === "/v1/families/fam-1/children") return answer(201, { id: NEW, nickname: body.nickname });
  if (path.endsWith("/consents")) return answer(201, {});
  if (path === `/v1/children/${LIAM}/skills`) {
    return answer(200, {
      ability: -0.8,
      skills: [
        { skill_id: "a", attempts: 3, mastered: true },
        { skill_id: "b", attempts: 2, mastered: false },
        { skill_id: "c", attempts: 0, mastered: false },
      ],
      next: [
        { skill_id: "b", name: "Comparar fracciones", p_now: 0.4 },
        { skill_id: "d", name: null },
        { skill_id: "e", name: "Fracciones equivalentes" },
      ],
    });
  }
  if (path === `/v1/children/${LIAM}/memories?limit=20`) {
    return answer(200, {
      memories: [{ id: MEMORY, kind: "preference", content: "Le gusta el fútbol.", created_at: "2026-11-15T10:00:00Z" }],
    });
  }
  if (path === `/v1/children/${LIAM}/reviews`) {
    if (failReviews) return answer(503, { error: { message: "unavailable" } });
    return answer(200, {
      reviews: [
        { session_id: "s-0", summary: "Practicó fracciones.", next_step: "Sigue comparar.", flags: [], created_at: "2026-11-17T23:10:00Z" },
      ],
    });
  }
  if (path === `/v1/children/${LIAM}/memories/${MEMORY}` && method === "DELETE") return answer(204, {});
  if (path === `/v1/children/${LIAM}/sessions/facts?limit=3`) return answer(200, { sessions: LATEST });
  if (path === "/v1/sessions") return answer(201, { session_id: "s-1", serverUrl: "wss://x", token: "jwt", room: "r" });
  answer(404, { error: { message: "no such path" } });
});

// What the platform's GET /v1/children/{id}/sessions/facts could send, with what the page must never show.
const MARK = "written-by-the-child";
const LATEST = [
  {
    started_at: "2026-11-24T15:10:00Z",
    seconds: 372.4,
    end_reason: "child_ended",
    breaks: 1,
    objective: { kind: "homework", subject: "matematica", topic: MARK, due: "2026-11-27" },
    exercises: { tried: 4, right: 3 },
    skills: ["Sumar hasta 20", "x".repeat(81), 7, "Restar hasta 10", "Contar hasta 100"],
    id: "s-1",
    child_turns: 22,
    guardian_summary: MARK,
  },
  {
    started_at: "2026-11-23T20:00:00Z",
    seconds: null,
    end_reason: "a_reason_from_a_newer_platform",
    breaks: -1,
    objective: { kind: "play", subject: "latin" },
    exercises: { tried: -2, right: 5 },
    skills: "Sumar hasta 20",
  },
  { started_at: "2026-11-22T20:00:00Z", seconds: 12, end_reason: "idle", breaks: 99, objective: null, exercises: { tried: 2, right: 3 }, skills: [] },
  { started_at: "yesterday", seconds: 60, end_reason: "idle" },
  { started_at: "2026-11-20T20:00:00Z", seconds: 60, end_reason: "error", objective: { kind: "explore", subject: "other" } },
];

let base = "";
let server: ReturnType<typeof createPlayground>;

before(async () => {
  await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;
  server = createPlayground(readSettings({ ...COMPLETE, AULE_PLATFORM_URL: url, AULE_ADMIN_TOKEN: "admin" }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/playground`;
});
after(() => {
  server.close();
  platform.close();
});
beforeEach(() => {
  seen.length = 0;
  keepsSubjects = true;
});

const COOKIE = `aule_guardian=${TOKEN}`;
const post = (path: string, body: unknown, cookie: string | null = COOKIE) =>
  fetch(`${base}/api/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
const PROFILE = {
  name: "Liam",
  grade: "P5",
  language: "es",
  interests: ["fútbol", "ajedrez"],
  tone: "tranquilo",
  note: "",
  subjects: ["matematica", "ingles"],
  remembers: true,
  keeps_transcripts: false,
};

test("a profile is a name and, at most, what the page offers", () => {
  // What was not chosen is not kept: remembering needs an explicit yes.
  assert.deepEqual(profileFrom({ name: " Liam " }), {
    name: "Liam",
    grade: null,
    language: "es",
    interests: [],
    tone: "calido",
    note: "",
    subjects: null,
    remembers: false,
    keepsTranscripts: false,
    relationship: null,
  });
  assert.equal(profileFrom({ name: "Liam", remembers: true })?.remembers, true);
  assert.deepEqual(profileFrom({ name: "Liam", interests: [" fútbol ", "fútbol"] })?.interests, ["fútbol"]);
  assert.equal(profileFrom({ name: "Liam", grade: "" })?.grade, null, "the grade can be left out");
  assert.equal(profileFrom({ name: "Liam", relationship: "" })?.relationship, null, "so can the relationship");
  assert.equal(profileFrom({ name: "Liam", relationship: "MTH" })?.relationship, "MTH");
  for (const wrong of [
    {},
    { name: "x".repeat(41) },
    { name: "Liam", grade: "P7" },
    { name: "Liam", tone: "estricto" },
    { name: "Liam", interests: Array(11).fill("a").map((text, index) => `${text}${index}`) },
    { name: "Liam", interests: ["x".repeat(41)] },
    { name: "Liam", interests: "fútbol" },
    { name: "Liam", note: "x".repeat(201) },
    { name: "Liam", subjects: ["latin"] },
    { name: "Liam", remembers: "yes" },
    { name: "Liam", relationship: "MOM" },
  ]) {
    assert.equal(profileFrom(wrong), null, JSON.stringify(wrong).slice(0, 60));
  }
});

test("what a session is for is one of four kinds, a subject, and a real day", () => {
  assert.equal(objectiveFrom(undefined), undefined);
  assert.deepEqual(objectiveFrom({ kind: "homework", subject: "matematica", topic: " fracciones ", due: "2026-11-27" }), {
    kind: "homework",
    subject: "matematica",
    topic: "fracciones",
    due: "2026-11-27",
  });
  assert.deepEqual(objectiveFrom({ kind: "explore", subject: "other" }), {
    kind: "explore",
    subject: "other",
    topic: "",
    due: null,
  });
  for (const wrong of [
    "homework",
    { kind: "play", subject: "matematica" },
    { kind: "homework", subject: "latin" },
    { kind: "homework", subject: "matematica", topic: "x".repeat(201) },
    { kind: "homework", subject: "matematica", due: "2026-02-30" },
    { kind: "homework", subject: "matematica", due: "mañana" },
  ]) {
    assert.equal(objectiveFrom(wrong), null, JSON.stringify(wrong).slice(0, 60));
  }
});

test("the account lists each student as the family set them up, and the subjects the platform keeps", async () => {
  const response = await fetch(`${base}/api/account`, { headers: { Cookie: COOKIE } });

  const body = await response.json();
  assert.deepEqual(body.subjects, SUBJECTS);
  assert.deepEqual(body.students, [
    {
      id: LIAM,
      name: "Liam",
      grade: "P4",
      language: "es",
      interests: ["fútbol", "robots"],
      tone: "aventurero",
      note: "Ve despacio.",
      // A subject the page does not know is left out.
      subjects: ["matematica"],
      remembers: true,
      keepsTranscripts: false,
      relationship: "GRMTH",
    },
    // A student that cannot be read is still there to choose.
    { id: SOFIA, name: "Sofía" },
  ]);
  // The team's notes and the year of birth are not the page's to show.
  assert.ok(!JSON.stringify(body).includes("from the team"));
  assert.ok(!JSON.stringify(body).includes("2016"));
  assert.ok(seen.slice(1).every((call) => call.auth === `Bearer ${TOKEN}`), "every call is the guardian's own");
});

test("a platform that keeps no subjects is shown as one", async () => {
  keepsSubjects = false;

  const body = await (await fetch(`${base}/api/account`, { headers: { Cookie: COOKIE } })).json();

  assert.equal(body.subjects, null);
  assert.equal(body.students[0].subjects, null);
});

test("a new student carries the profile and the consents the guardian chose", async () => {
  assert.equal((await post("student", { ...PROFILE, name: "Mateo", consent: true }, null)).status, 401);
  assert.equal((await post("student", { ...PROFILE, name: "Mateo" })).status, 400, "not without the guardian's yes");
  assert.equal((await post("student", { ...PROFILE, grade: "P7", consent: true })).status, 400);
  seen.length = 0;

  const response = await post("student", {
    ...PROFILE,
    name: "Mateo",
    remembers: false,
    keeps_transcripts: true,
    relationship: "FTH",
    consent: true,
  });

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: NEW, name: "Mateo" });
  assert.deepEqual(seen.find((call) => call.path.endsWith("/children"))?.body, {
    nickname: "Mateo",
    grade: "P5",
    language: "es",
    interests: ["fútbol", "ajedrez"],
    tutor_persona: "tranquilo",
    tutor_persona_note: "",
    relationship: "FTH",
    subjects: ["matematica", "ingles"],
  });
  assert.deepEqual(
    seen.filter((call) => call.path.endsWith("/consents")).map((call) => call.body),
    [
      { purpose: "voice", granted: true, policy_version: "playground-2026-11-v8" },
      { purpose: "memory", granted: false, policy_version: "playground-2026-11-v8" },
      { purpose: "transcripts", granted: true, policy_version: "playground-2026-11-v8" },
    ],
  );
  assert.ok(seen.every((call) => call.auth === `Bearer ${TOKEN}`), "every call is the guardian's own");
});

test("a student made in the onboarding carries its answers, and the consents follow its creation", async () => {
  seen.length = 0;
  // What p10-name sends: the interview's note, grade and likes (the six
  // options in lower case, then what was typed), and P04's two choices.
  const response = await post("student", {
    consent: true,
    name: "Mati",
    grade: "P4",
    language: "es",
    interests: ["deportes", "espacio y ciencia", "dinosaurios", "ajedrez"],
    tone: "calido",
    note: "Que le ayude con las tareas sin darle las respuestas.",
    remembers: true,
    keeps_transcripts: false,
  });

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: NEW, name: "Mati" });
  const made = seen.findIndex((call) => call.path.endsWith("/children"));
  assert.deepEqual(seen[made]?.body, {
    nickname: "Mati",
    grade: "P4",
    language: "es",
    interests: ["deportes", "espacio y ciencia", "dinosaurios", "ajedrez"],
    tutor_persona: "calido",
    tutor_persona_note: "Que le ayude con las tareas sin darle las respuestas.",
    relationship: "",
  });
  const consents = seen.map((call, index) => ({ ...call, index })).filter((call) => call.path.endsWith("/consents"));
  assert.ok(consents.every((call) => call.index > made), "the consents come after the child");
  assert.deepEqual(
    consents.map((call) => [call.path, call.body]),
    ["voice", "memory", "transcripts"].map((purpose) => [
      `/v1/children/${NEW}/consents`,
      { purpose, granted: purpose !== "transcripts", policy_version: "playground-2026-11-v8" },
    ]),
  );
});

test("saving keeps what the page does not show and records only the consent that changed", async () => {
  assert.equal((await post("student/save", { student_id: LIAM, ...PROFILE }, null)).status, 401);
  assert.equal((await post("student/save", { student_id: "nope", ...PROFILE })).status, 400);
  assert.equal((await post("student/save", { student_id: LIAM, ...PROFILE, tone: "estricto" })).status, 400);
  seen.length = 0;

  const response = await post("student/save", { student_id: LIAM, ...PROFILE, remembers: false });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, LIAM);
  assert.deepEqual(seen.find((call) => call.method === "PUT")?.body, {
    nickname: "Liam",
    grade: "P5",
    language: "es",
    interests: ["fútbol", "ajedrez"],
    tutor_persona: "tranquilo",
    // An empty note removes the one that was there; so does an empty relationship.
    tutor_persona_note: "",
    relationship: "",
    subjects: ["matematica", "ingles"],
    birth_year: 2016,
    notes: "from the team",
  });
  assert.deepEqual(
    seen.filter((call) => call.path.endsWith("/consents")).map((call) => call.body),
    [{ purpose: "memory", granted: false, policy_version: "playground-2026-11-v8" }],
  );
  assert.ok(seen.every((call) => call.auth === `Bearer ${TOKEN}`), "every call is the guardian's own");
});

test("subjects are not sent to a platform that does not keep them", async () => {
  keepsSubjects = false;

  await post("student/save", { student_id: LIAM, ...PROFILE });

  const sent = seen.find((call) => call.method === "PUT")?.body as Record<string, unknown>;
  assert.equal("subjects" in sent, false);
});

test("what is kept about a student is short enough to read, and one memory can be forgotten", async () => {
  assert.equal((await post("student/known", { student_id: LIAM }, null)).status, 401);

  const known = await post("student/known", { student_id: LIAM });

  assert.deepEqual(await known.json(), {
    mastered: 1,
    practising: 1,
    next: ["Comparar fracciones", "Fracciones equivalentes"],
    memories: [{ id: MEMORY, text: "Le gusta el fútbol." }],
    sessions: [{ day: "2026-11-17", summary: "Practicó fracciones.", next: "Sigue comparar." }],
  });

  assert.equal((await post("student/forget", { student_id: LIAM, memory_id: "nope" })).status, 400);
  const forgotten = await post("student/forget", { student_id: LIAM, memory_id: MEMORY });
  assert.equal(forgotten.status, 200);
  assert.deepEqual(seen.at(-1), {
    method: "DELETE",
    path: `/v1/children/${LIAM}/memories/${MEMORY}`,
    auth: `Bearer ${TOKEN}`,
    body: null,
  });
});

test("a student's latest sessions are facts the page can show, and nothing else the platform sent", async () => {
  assert.equal((await post("student/sessions", { student_id: LIAM }, null)).status, 401);
  assert.equal((await post("student/sessions", { student_id: "nope" })).status, 400);
  seen.length = 0;

  const response = await post("student/sessions", { student_id: LIAM });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    sessions: [
      {
        day: "2026-11-24T15:10:00Z",
        minutes: 6,
        kind: "homework",
        subject: "matematica",
        // Two at most, each a name of the catalogue's length.
        skills: ["Sumar hasta 20", "Restar hasta 10"],
        // How many were tried; how many were right is not the home's (a child lands there).
        tried: 4,
        breaks: 1,
        ending: "child_ended",
      },
      // What is not one of the platform's values is left out, and counts that are not counts are none.
      { day: "2026-11-23T20:00:00Z", minutes: null, kind: null, subject: null, skills: [], tried: 0, breaks: 0, ending: null },
      // A session shorter than a minute is one minute; more right than tried is no count at all.
      { day: "2026-11-22T20:00:00Z", minutes: 1, kind: null, subject: null, skills: [], tried: 0, breaks: 0, ending: "idle" },
    ],
    // How many of the review's summaries Configurar has: a count, so the home links them only then.
    summaries: 1,
  });
  // A start that is not a date is not shown; three at most.
  assert.equal(body.sessions.length, 3);
  // The topic typed on A04 · Detalles, the review's words and the platform's ids never reach the page.
  const sent = JSON.stringify(body);
  assert.ok(!sent.includes(MARK));
  assert.ok(!sent.includes("Practicó fracciones"), "the review's summary stays behind");
  for (const key of ["topic", "due", "id", "guardian_summary", "child_turns", "content", "right", "summary", "next_step"]) {
    assert.ok(!sent.includes(`"${key}"`), key);
  }
  assert.deepEqual(
    seen.map((call) => [call.method, call.path, call.auth]).sort(),
    [
      ["GET", `/v1/children/${LIAM}/reviews`, `Bearer ${TOKEN}`],
      ["GET", `/v1/children/${LIAM}/sessions/facts?limit=3`, `Bearer ${TOKEN}`],
    ],
  );
});

test("a student whose reviews cannot be read still has their latest sessions, and no summaries to link", async () => {
  failReviews = true;
  try {
    const response = await post("student/sessions", { student_id: LIAM });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.sessions.length, 3);
    assert.equal(body.summaries, 0);
  } finally {
    failReviews = false;
  }
});

test("a session carries what the family said it is for, and nothing when they said nothing", async () => {
  const objective = { kind: "exam_prep", subject: "comunicacion", topic: "el resumen", due: "2026-11-27" };
  assert.equal((await post("session", { student_id: LIAM, objective: { kind: "play" } })).status, 400);
  assert.equal(seen.length, 0, "a session is not asked for with an objective that is not one");

  await post("session", { student_id: LIAM, language: "es", objective });
  assert.deepEqual(seen.at(-1)?.body, { audience: "child", language: "es", child_id: LIAM, objective });

  await post("session", { student_id: LIAM, language: "es" });
  assert.deepEqual(seen.at(-1)?.body, { audience: "child", language: "es", child_id: LIAM });
});

test("a page set to the engine asks for it on an ordinary family session", async () => {
  const url = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;
  const withEngine = createPlayground(
    readSettings({ ...COMPLETE, AULE_PLATFORM_URL: url, AULE_ADMIN_TOKEN: "admin", PLAYGROUND_ENGINE: "1" }),
  );
  await new Promise<void>((resolve) => withEngine.listen(0, "127.0.0.1", resolve));
  try {
    const objective = { kind: "homework", subject: "matematica", topic: "fracciones", due: null };
    await fetch(`http://127.0.0.1:${(withEngine.address() as AddressInfo).port}/playground/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: COOKIE },
      body: JSON.stringify({ student_id: LIAM, language: "es", objective }),
    });
  } finally {
    withEngine.close();
  }

  assert.deepEqual(seen.at(-1)?.body, {
    audience: "child",
    language: "es",
    child_id: LIAM,
    objective: { kind: "homework", subject: "matematica", topic: "fracciones", due: null },
    engine: true,
  });
});

test("the BFF uses the child's selected guided activity only for the authorized, unedited question", async () => {
  const spanish = teachingResource("add-fractions", "es")!.practiceTopic;
  const english = teachingResource("add-fractions", "en")!.practiceTopic;
  const url = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;
  const server = createPlayground(readSettings({ ...COMPLETE, AULE_PLATFORM_URL: url, AULE_ADMIN_TOKEN: "admin", PLAYGROUND_ENGINE: "1" }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const session = (data: object) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/playground/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: COOKIE },
      body: JSON.stringify(data),
    });
    const objective = { kind: "explore", subject: "matematica", topic: spanish, due: null };
    const wanted = { student_id: LIAM, language: "es", objective, practice: "add-fractions" };
    for (const change of [
      { practice: "unknown" }, { practice: "compare-fractions" }, { language: "es-PE" }, { language: "en" },
      { objective: { ...objective, topic: "my own question" } },
    ]) assert.equal((await session({ ...wanted, ...change })).status, 400);
    assert.equal(seen.length, 0, "a mismatched handoff never reaches the platform");
    assert.equal((await session({ ...wanted, language: "en", objective: { ...objective, topic: english } })).status, 400);
    assert.equal(seen.at(-1)?.path, `/v1/children/${LIAM}`, "the language is checked as the guardian");
    assert.equal((await session(wanted)).status, 200);
    assert.deepEqual(seen.at(-1), { method: "POST", path: "/v1/sessions", auth: `Bearer ${TOKEN}`, body: {
      audience: "child", child_id: LIAM, language: "es", objective,
    } });
    assert.equal((await session({ ...wanted, practice: undefined, engine: false })).status, 200);
    assert.deepEqual(seen.at(-1)?.body, { audience: "child", child_id: LIAM, language: "es", objective, engine: true });
  } finally {
    server.close();
  }
});
