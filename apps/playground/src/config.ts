// Settings for the playground, read from the environment once at start. Every
// problem is reported together, and the server does not start with one.

export const LANGUAGES = ["es", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

export type Settings = {
  host: string;
  port: number;
  /** Path the page is served under, without a trailing slash ("" for the root). */
  basePath: string;
  /** LiveKit URL the browser connects to. */
  livekitUrl: string;
  /** Server-side RoomService address, taken from LIVEKIT_URL when set. */
  livekitServiceUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  accessCode: string;
  /** Credential sent only by the mobile API Worker over its dedicated tunnel. */
  mobileOriginSecret: string;
  agentName: string;
  sessionMinutes: number;
  /** Sessions one signed-in account may start in a day. */
  dailySessions: number;
  /** Temporary free access also bypasses the page's daily session cap. */
  freeAccess: boolean;
  /**
   * Who runs a family's sessions: with "engine" the platform is asked for the
   * session engine and uses it where it can; otherwise the tutor runs them.
   */
  /** Whether the session engine is asked to run the sessions this page starts. */
  engine: boolean;
  /** With a platform, sessions are created there and the supervisor takes part. */
  platform: { url: string; adminToken: string; childId: string | null } | null;
  /**
   * Where people reach this page, like https://playground.example.org: GitHub,
   * Meta and Apple send them back to it. Without it those sign-ins are off.
   */
  publicUrl: string | null;
  /**
   * The commit the image was built from (AULE_COMMIT, given when it is built),
   * or "unknown". It goes into pages, so only hex digits are taken.
   */
  commit: string;
};

export class ConfigError extends Error {}

const MIN_ACCESS_CODE_LENGTH = 16;

export function readSettings(env: Record<string, string | undefined>): Settings {
  const get = (name: string, fallback = "") => env[name]?.trim() || fallback;
  const problems: string[] = [];

  // PLAYGROUND_LIVEKIT_URL is the earlier name of AULE_LIVEKIT_PUBLIC_URL.
  const livekitUrl =
    get("AULE_LIVEKIT_PUBLIC_URL") || get("PLAYGROUND_LIVEKIT_URL") || get("LIVEKIT_URL");
  const livekitServiceUrl = (get("LIVEKIT_URL") || livekitUrl).replace(/^ws/, "http");
  if (!/^https?:\/\/[^\s/]+/.test(livekitServiceUrl)) problems.push("LIVEKIT_URL must be a valid LiveKit service URL");
  if (!/^wss?:\/\/[^\s/]+/.test(livekitUrl)) {
    problems.push("AULE_LIVEKIT_PUBLIC_URL (or LIVEKIT_URL) must be a ws:// or wss:// URL");
  }
  for (const name of ["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"]) {
    if (!get(name)) problems.push(`${name} is not set`);
  }

  const accessCode = get("PLAYGROUND_ACCESS_CODE");
  const mobileOriginSecret = get("MOBILE_API_ORIGIN_SECRET");
  if (accessCode.length < MIN_ACCESS_CODE_LENGTH) {
    problems.push(`PLAYGROUND_ACCESS_CODE must have at least ${MIN_ACCESS_CODE_LENGTH} characters`);
  }

  const basePath = get("PLAYGROUND_BASE_PATH", "/playground").replace(/\/+$/, "");
  if (basePath && !/^(\/[A-Za-z0-9_-]+)+$/.test(basePath)) {
    problems.push("PLAYGROUND_BASE_PATH must look like /playground");
  }

  const port = Number(get("PLAYGROUND_PORT", "8090"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push("PLAYGROUND_PORT must be a port number");
  }

  const sessionMinutes = Number(get("PLAYGROUND_SESSION_MINUTES", "20"));
  if (!Number.isInteger(sessionMinutes) || sessionMinutes < 1 || sessionMinutes > 120) {
    problems.push("PLAYGROUND_SESSION_MINUTES must be a whole number from 1 to 120");
  }
  const dailySessions = Number(get("PLAYGROUND_DAILY_SESSIONS", "3"));
  if (!Number.isInteger(dailySessions) || dailySessions < 1 || dailySessions > 100) {
    problems.push("PLAYGROUND_DAILY_SESSIONS must be a whole number from 1 to 100");
  }
  // Renamed: an old name left behind would turn the engine off without a word.
  if (get("PLAYGROUND_FLOW") !== "") {
    problems.push("PLAYGROUND_FLOW was renamed to PLAYGROUND_ENGINE (1 to turn the session engine on)");
  }
  const engine = get("PLAYGROUND_ENGINE");
  if (engine !== "" && engine !== "1" && engine !== "0") {
    problems.push("PLAYGROUND_ENGINE must be 1, 0 or left out");
  }
  const freeAccess = get("AULE_FREE_ACCESS");
  if (freeAccess !== "" && freeAccess !== "1" && freeAccess !== "0") {
    problems.push("AULE_FREE_ACCESS must be 1, 0 or left out");
  }

  const platformUrl = get("AULE_PLATFORM_URL").replace(/\/+$/, "");
  const adminToken = get("AULE_ADMIN_TOKEN");
  const childId = get("PLAYGROUND_CHILD_ID");
  if (platformUrl && !/^https?:\/\/[^\s/]+/.test(platformUrl)) {
    problems.push("AULE_PLATFORM_URL must be an http:// or https:// URL");
  }
  if (platformUrl && !adminToken) {
    problems.push("AULE_ADMIN_TOKEN is needed with AULE_PLATFORM_URL");
  }
  if (childId && !/^[0-9a-f-]{36}$/i.test(childId)) {
    problems.push("PLAYGROUND_CHILD_ID must be a child's id");
  }

  const publicUrl = get("PLAYGROUND_PUBLIC_URL").replace(/\/+$/, "");
  if (publicUrl && !/^(https:\/\/[^\s/]+|http:\/\/127\.0\.0\.1(:\d+)?)$/.test(publicUrl)) {
    problems.push("PLAYGROUND_PUBLIC_URL must be an https:// origin, like https://playground.example.org");
  }

  if (problems.length > 0) throw new ConfigError(problems.join("; "));

  return {
    host: get("PLAYGROUND_HOST", "127.0.0.1"),
    port,
    basePath,
    livekitUrl,
    livekitServiceUrl,
    livekitApiKey: get("LIVEKIT_API_KEY"),
    livekitApiSecret: get("LIVEKIT_API_SECRET"),
    accessCode,
    mobileOriginSecret: /^[0-9a-f]{64}$/.test(mobileOriginSecret) ? mobileOriginSecret : "",
    agentName: get("AULE_AGENT_NAME", "aule-tutor"),
    sessionMinutes,
    dailySessions,
    freeAccess: freeAccess === "1",
    engine: engine === "1",
    platform: platformUrl ? { url: platformUrl, adminToken, childId: childId || null } : null,
    publicUrl: publicUrl || null,
    commit: /^[0-9a-f]{7,40}$/.test(get("AULE_COMMIT")) ? get("AULE_COMMIT") : "unknown",
  };
}
