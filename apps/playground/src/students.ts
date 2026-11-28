// A family's students: who each one is for the tutor, what the family allows,
// and what is kept about them. Every call here is made as the signed-in
// guardian, never as the team, so the platform only answers for their family.

import { LANGUAGES, type Language, type Settings } from "./config.ts";
import { PlatformError, platform, type Session } from "./session.ts";

export const GRADES = ["P1", "P2", "P3", "P4", "P5", "P6", "S1", "S2", "S3", "S4", "S5"] as const;
export type Grade = (typeof GRADES)[number];
/** How the tutor talks. Its name is never the family's to change. */
export const TONES = ["calido", "jugueton", "aventurero", "tranquilo"] as const;
export type Tone = (typeof TONES)[number];
export const SUBJECTS = ["matematica", "comunicacion", "ciencia", "personal_social", "ingles"] as const;
export type Subject = (typeof SUBJECTS)[number];
export const OBJECTIVE_KINDS = ["homework", "exam_prep", "exam_review", "explore"] as const;
/**
 * What a guardian can be to a student, as the platform codes it (FHIR R4
 * RelatedPerson.relationship, HL7 v3 RoleCode): mother, father, stepmother,
 * stepfather, grandmother, grandfather, aunt, uncle, sibling, legal guardian,
 * other family member.
 */
export const RELATIONSHIPS = [
  "MTH",
  "FTH",
  "STPMTH",
  "STPFTH",
  "GRMTH",
  "GRFTH",
  "AUNT",
  "UNCLE",
  "SIB",
  "GUARD",
  "FAMMEMB",
] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];
export type ObjectiveKind = (typeof OBJECTIVE_KINDS)[number];

export type Profile = {
  name: string;
  /** Not asked for by default: a family may leave it out. */
  grade: Grade | null;
  language: Language;
  interests: string[];
  tone: Tone;
  /** One line from the family about how to talk to the student; empty for none. */
  note: string;
  /** Null when the platform does not keep subjects, so the page does not offer them. */
  subjects: Subject[] | null;
  /** What is remembered between sessions. */
  remembers: boolean;
  keepsTranscripts: boolean;
  /** What the signed-in guardian is to the student; null when they would rather not say. */
  relationship: Relationship | null;
};

export type Student = Profile & { id: string };

/** What the family says a session is for, before it starts. */
export type Objective = {
  kind: ObjectiveKind;
  subject: Subject | "other";
  topic: string;
  /** The day a homework is due or an evaluation is, as YYYY-MM-DD. */
  due: string | null;
};

const MAX_NAME_CHARS = 40;
const MAX_INTERESTS = 10;
const MAX_INTEREST_CHARS = 40;
const MAX_NOTE_CHARS = 200;
const MAX_TOPIC_CHARS = 200;
// The terms a guardian agrees to on this page; recorded with each consent.
// "-v8": the text of the Figma's P04 (voice, and the notebook's pictures when
// the camera is used), so each record says which text the guardian saw.
const POLICY_VERSION = "playground-2026-11-v8";

function oneOf<T extends string>(known: readonly T[], value: unknown): T | null {
  return known.find((item) => item === value) ?? null;
}

const absent = (value: unknown) => value === undefined || value === null || value === "";

function texts(value: unknown, most: number, longest: number): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > most) return null;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") return null;
    const text = item.trim();
    if (!text || text.length > longest) return null;
    seen.add(text);
  }
  return [...seen];
}

/** The profile in what the page sent, or null when any part of it is not one. */
export function profileFrom(body: Record<string, unknown>): Profile | null {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const grade = absent(body.grade) ? null : oneOf(GRADES, body.grade);
  const interests = texts(body.interests, MAX_INTERESTS, MAX_INTEREST_CHARS);
  const tone = body.tone === undefined ? "calido" : oneOf(TONES, body.tone);
  const note = body.note === undefined ? "" : typeof body.note === "string" ? body.note.trim() : null;
  const subjects = absent(body.subjects) ? [] : texts(body.subjects, SUBJECTS.length, 40);
  const relationship = absent(body.relationship) ? null : oneOf(RELATIONSHIPS, body.relationship);
  const flags = [body.remembers, body.keeps_transcripts].every(
    (flag) => flag === undefined || typeof flag === "boolean",
  );
  if (
    !name ||
    name.length > MAX_NAME_CHARS ||
    (grade === null && !absent(body.grade)) ||
    interests === null ||
    tone === null ||
    note === null ||
    note.length > MAX_NOTE_CHARS ||
    subjects === null ||
    subjects.some((subject) => oneOf(SUBJECTS, subject) === null) ||
    (relationship === null && !absent(body.relationship)) ||
    !flags
  ) {
    return null;
  }
  return {
    name,
    grade,
    language: oneOf(LANGUAGES, body.language) ?? "es",
    interests,
    tone,
    note,
    subjects: absent(body.subjects) ? null : (subjects as Subject[]),
    // Kept only on the guardian's own yes: what was not sent was not chosen.
    remembers: body.remembers === true,
    keepsTranscripts: body.keeps_transcripts === true,
    relationship,
  };
}

/**
 * The objective in what the page sent: undefined when there is none, null when
 * what was sent is not one.
 */
export function objectiveFrom(value: unknown): Objective | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const sent = value as Record<string, unknown>;
  const kind = oneOf(OBJECTIVE_KINDS, sent.kind);
  const subject = sent.subject === "other" ? "other" : oneOf(SUBJECTS, sent.subject);
  const topic = sent.topic === undefined ? "" : typeof sent.topic === "string" ? sent.topic.trim() : null;
  const due = absent(sent.due) ? null : sent.due;
  const dated = due === null || (typeof due === "string" && isDay(due));
  if (kind === null || subject === null || topic === null || topic.length > MAX_TOPIC_CHARS || !dated) {
    return null;
  }
  return { kind, subject, topic, due: due as string | null };
}

/** A real day written as YYYY-MM-DD. */
function isDay(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const day = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === text;
}

type Child = {
  id?: unknown;
  nickname?: unknown;
  birth_year?: unknown;
  grade?: unknown;
  language?: unknown;
  interests?: unknown;
  notes?: unknown;
  tutor_persona?: unknown;
  tutor_persona_note?: unknown;
  subjects?: unknown;
};
type Consent = { memory?: unknown; transcripts?: unknown };

function studentOf(child: Child, consent: Consent, relationship: unknown): Student {
  if (typeof child.id !== "string" || typeof child.nickname !== "string") {
    throw new PlatformError("the platform sent no student");
  }
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return {
    id: child.id,
    name: child.nickname,
    grade: oneOf(GRADES, child.grade),
    language: oneOf(LANGUAGES, child.language) ?? "es",
    interests: strings(child.interests),
    tone: oneOf(TONES, child.tutor_persona) ?? "calido",
    note: typeof child.tutor_persona_note === "string" ? child.tutor_persona_note : "",
    subjects:
      "subjects" in child
        ? strings(child.subjects).flatMap((subject) => oneOf(SUBJECTS, subject) ?? [])
        : null,
    remembers: consent.memory === true,
    keepsTranscripts: consent.transcripts === true,
    relationship: oneOf(RELATIONSHIPS, relationship),
  };
}

const pathOf = (id: string) => `/v1/children/${encodeURIComponent(id)}`;

async function fetchChild(
  settings: Settings,
  token: string,
  id: string,
): Promise<{ child: Child; consent: Consent; relationship: unknown }> {
  const answer = (await platform(settings, pathOf(id), undefined, token)) as {
    child?: Child;
    consent?: Consent;
    relationship?: unknown;
  };
  return { child: answer.child ?? {}, consent: answer.consent ?? {}, relationship: answer.relationship };
}

export async function readStudent(settings: Settings, token: string, id: string): Promise<Student> {
  const kept = await fetchChild(settings, token, id);
  return studentOf(kept.child, kept.consent, kept.relationship);
}

/** Each student of a family as the page shows them; one that cannot be read keeps only its name. */
export function readStudents(
  settings: Settings,
  token: string,
  list: { id: string; name: string }[],
): Promise<({ id: string; name: string } | Student)[]> {
  return Promise.all(
    list.map((student) =>
      readStudent(settings, token, student.id).catch((error: unknown) => {
        if (error instanceof PlatformError) return student;
        throw error;
      }),
    ),
  );
}

function consent(settings: Settings, token: string, id: string, purpose: string, granted: boolean) {
  const body = { purpose, granted, policy_version: POLICY_VERSION };
  return platform(settings, `${pathOf(id)}/consents`, body, token);
}

function childBody(profile: Profile, keepsSubjects: boolean): Record<string, unknown> {
  return {
    nickname: profile.name,
    grade: profile.grade,
    language: profile.language,
    interests: profile.interests,
    tutor_persona: profile.tone,
    // An empty note removes the one that was there; so does an empty relationship.
    tutor_persona_note: profile.note,
    relationship: profile.relationship ?? "",
    ...(keepsSubjects && profile.subjects ? { subjects: profile.subjects } : {}),
  };
}

/**
 * A new student in the signed-in guardian's family, with the consent they just
 * gave on the page: the voice is processed to answer; what is remembered and
 * whether the written conversation is kept are theirs to choose.
 */
export async function createStudent(
  settings: Settings,
  token: string,
  familyId: string,
  profile: Profile,
): Promise<{ id: string; name: string }> {
  const created = (await platform(
    settings,
    `/v1/families/${encodeURIComponent(familyId)}/children`,
    // Subjects are sent along; a platform that does not keep them leaves them out.
    childBody(profile, true),
    token,
  )) as { id?: unknown; child?: { id?: unknown } };
  const id = typeof created.id === "string" ? created.id : created.child?.id;
  if (typeof id !== "string") throw new PlatformError("the platform sent no student");
  await consent(settings, token, id, "voice", true);
  await consent(settings, token, id, "memory", profile.remembers);
  await consent(settings, token, id, "transcripts", profile.keepsTranscripts);
  return { id, name: profile.name };
}

/**
 * Changes a student's profile and what the family allows. What the page does
 * not show (the year of birth, the team's notes) is kept as it was, and a
 * consent is recorded only when it changed.
 */
export async function saveStudent(settings: Settings, token: string, id: string, profile: Profile): Promise<Student> {
  const kept = await fetchChild(settings, token, id);
  const body = {
    ...childBody(profile, "subjects" in kept.child),
    ...(typeof kept.child.birth_year === "number" ? { birth_year: kept.child.birth_year } : {}),
    ...(typeof kept.child.notes === "string" ? { notes: kept.child.notes } : {}),
  };
  await platform(settings, pathOf(id), body, token, "PUT");
  if ((kept.consent.memory === true) !== profile.remembers) {
    await consent(settings, token, id, "memory", profile.remembers);
  }
  if ((kept.consent.transcripts === true) !== profile.keepsTranscripts) {
    await consent(settings, token, id, "transcripts", profile.keepsTranscripts);
  }
  return readStudent(settings, token, id);
}

/** Removes one student of the signed-in guardian's family, and everything kept about them. */
export function removeStudent(settings: Settings, token: string, id: string): Promise<unknown> {
  return platform(settings, pathOf(id), undefined, token, "DELETE");
}

export type Known = {
  /** Skills the student has by now, and skills they have started on. */
  mastered: number;
  practising: number;
  /** Named skills with recorded attempts that the model suggests practising or revisiting. */
  practice: { revisit: string[]; ongoing: string[] };
  /** What comes next, by name. */
  next: string[];
  memories: { id: string; text: string }[];
  sessions: { day: string; summary: string; next: string }[];
};

const MAX_MEMORIES = 20;
const MAX_SESSIONS = 5;
const MAX_NEXT = 3;

type Reviews = { reviews?: { created_at?: unknown; summary?: unknown; next_step?: unknown }[] };

/** The review's summaries Configurar shows for a student (`known`), newest first: what the home counts too. */
function summariesOf(reviews: Reviews): Known["sessions"] {
  return (reviews.reviews ?? [])
    .flatMap((review) =>
      typeof review.summary === "string" && typeof review.created_at === "string"
        ? [
            {
              day: review.created_at.slice(0, 10),
              summary: review.summary,
              next: typeof review.next_step === "string" ? review.next_step : "",
            },
          ]
        : [],
    )
    .slice(0, MAX_SESSIONS);
}

/** What is kept about a student, for the family to read and to prune. */
export async function known(settings: Settings, token: string, id: string): Promise<Known> {
  const [skills, memories, reviews] = (await Promise.all([
    platform(settings, `${pathOf(id)}/skills`, undefined, token),
    platform(settings, `${pathOf(id)}/memories?limit=${MAX_MEMORIES}`, undefined, token),
    platform(settings, `${pathOf(id)}/reviews`, undefined, token),
  ])) as [
    {
      skills?: { skill_id?: unknown; mastered?: unknown; attempts?: unknown }[];
      next?: { skill_id?: unknown; name?: unknown; reason?: unknown }[];
    },
    { memories?: { id?: unknown; content?: unknown }[] },
    Reviews,
  ];
  const worked = (skills.skills ?? []).filter((skill) => typeof skill.attempts === "number" && skill.attempts > 0);
  const mastered = worked.filter((skill) => skill.mastered === true).length;
  const workedIds = new Set(worked.map((skill) => skill.skill_id).filter((id): id is string => typeof id === "string" && id.length > 0));
  const practiceNames = (reason: "review_due" | "in_progress") => (skills.next ?? [])
    .filter((item) => item.reason === reason && typeof item.skill_id === "string" && workedIds.has(item.skill_id))
    .flatMap((item) => typeof item.name === "string" && item.name.trim() ? [item.name.trim()] : [])
    .slice(0, MAX_NEXT);
  return {
    mastered,
    practising: worked.length - mastered,
    practice: { revisit: practiceNames("review_due"), ongoing: practiceNames("in_progress") },
    next: (skills.next ?? [])
      .flatMap((item) => (typeof item.name === "string" && item.name ? [item.name] : []))
      .slice(0, MAX_NEXT),
    memories: (memories.memories ?? [])
      .flatMap((memory) =>
        typeof memory.id === "string" && typeof memory.content === "string"
          ? [{ id: memory.id, text: memory.content }]
          : [],
      )
      .slice(0, MAX_MEMORIES),
    sessions: summariesOf(reviews),
  };
}

/** Forgets one thing remembered about a student. */
export function forget(settings: Settings, token: string, id: string, memoryId: string): Promise<unknown> {
  return platform(settings, `${pathOf(id)}/memories/${encodeURIComponent(memoryId)}`, undefined, token, "DELETE");
}

/** The ways a session ends that the home can say something about (the platform's end_reason). */
export const END_REASONS = [
  "child_ended",
  "parent_ended",
  "budget_reached",
  "idle",
  "device_offline",
  "not_working",
  "provider_error",
  "error",
] as const;
export type EndReason = (typeof END_REASONS)[number];

/**
 * One of a student's latest sessions, as the family's home says it: facts only.
 * Never what was said or typed, the topic written on A04 · Detalles, nor the
 * review's words, which the platform does not send here either.
 */
export type SessionFacts = {
  /** When it started, as the platform's ISO date and time. */
  day: string;
  /** How long it lasted, in whole minutes and at least one; null when it is not known. */
  minutes: number | null;
  /** What it was for, when the family said it. */
  kind: ObjectiveKind | null;
  subject: Subject | "other" | null;
  /** The catalogue's names of the skills it practised, two at most. */
  skills: string[];
  /** The exercises checked in it. How many were right is not the home's to say: a child lands there. */
  tried: number;
  breaks: number;
  /** How it ended; null for an ending the platform did not say or the page does not know. */
  ending: EndReason | null;
};

const LATEST_SESSIONS = 3;
const MAX_SKILLS_SHOWN = 2;
const MAX_SKILL_CHARS = 80;
const MAX_EXERCISES = 50;
const MAX_BREAKS = 20;

const whole = (value: unknown, most: number): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= most ? value : null;

function factsOf(session: Record<string, unknown>): SessionFacts | null {
  const day = typeof session.started_at === "string" && !Number.isNaN(Date.parse(session.started_at)) ? session.started_at : null;
  if (day === null) return null;
  const seconds = session.seconds;
  const objective = typeof session.objective === "object" && session.objective !== null ? (session.objective as Record<string, unknown>) : {};
  const exercises = typeof session.exercises === "object" && session.exercises !== null ? (session.exercises as Record<string, unknown>) : {};
  const tried = whole(exercises.tried, MAX_EXERCISES);
  const right = whole(exercises.right, MAX_EXERCISES);
  const counted = tried !== null && right !== null && right <= tried;
  const skills = Array.isArray(session.skills) ? session.skills : [];
  return {
    day,
    minutes: typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? Math.max(1, Math.round(seconds / 60)) : null,
    kind: oneOf(OBJECTIVE_KINDS, objective.kind),
    subject: objective.subject === "other" ? "other" : oneOf(SUBJECTS, objective.subject),
    skills: skills
      .filter((skill): skill is string => typeof skill === "string" && skill.trim().length > 0 && skill.length <= MAX_SKILL_CHARS)
      .slice(0, MAX_SKILLS_SHOWN),
    tried: counted ? tried : 0,
    breaks: whole(session.breaks, MAX_BREAKS) ?? 0,
    ending: oneOf(END_REASONS, session.end_reason),
  };
}

/**
 * A student's latest sessions as facts the home can show (FIGMA.md D35), from
 * the platform's guardian-scoped GET /v1/children/{id}/sessions/facts: when, how
 * long, what for, which skills, the exercises and the breaks, and how it
 * ended. Anything else in the answer is left behind, and a session whose
 * start is not a date is not shown. With them, how many of the review's
 * summaries Configurar has (`summaries`, a count and never their words), so
 * the home links them only once there are some; a review that cannot be read
 * counts none and takes nothing from the lines.
 */
export async function latestSessions(
  settings: Settings,
  token: string,
  id: string,
): Promise<{ sessions: SessionFacts[]; summaries: number }> {
  const [answer, reviews] = (await Promise.all([
    platform(settings, `${pathOf(id)}/sessions/facts?limit=${LATEST_SESSIONS}`, undefined, token),
    platform(settings, `${pathOf(id)}/reviews`, undefined, token).catch(() => ({})),
  ])) as [{ sessions?: unknown }, Reviews];
  const sessions = Array.isArray(answer.sessions) ? answer.sessions : [];
  return {
    sessions: sessions
      .flatMap((session) => (typeof session === "object" && session !== null ? (factsOf(session as Record<string, unknown>) ?? []) : []))
      .slice(0, LATEST_SESSIONS),
    summaries: summariesOf(reviews).length,
  };
}

/**
 * A session for one of the signed-in guardian's students, for what the family
 * said it is for. Where this page is set to, the session engine is asked for;
 * the platform uses it when it covers what the session is for, and the tutor
 * runs the session otherwise.
 */
export async function startSession(
  settings: Settings,
  token: string,
  id: string,
  language: Language,
  objective?: Objective,
  practicing = false,
): Promise<Session> {
  const body = {
    audience: "child",
    language,
    child_id: id,
    ...(objective ? { objective } : {}),
    // The engine selects its own exercise; the conversational tutor can use this sheet's question.
    ...(settings.engine && !practicing ? { engine: true } : {}),
  };
  return (await platform(settings, "/v1/sessions", body, token)) as Session;
}
