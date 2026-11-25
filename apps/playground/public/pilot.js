// The pilot's numbers as the team's panel shows them. The platform counts the
// four per week of sign-up and link (GET /v1/metrics/weekly); these add them
// up per week and per link, and say its two figures about the children. Pure
// functions: the tests import them as they are.

/**
 * What each line of the platform's answer counts, all of them families. A
 * number that takes time comes with the families whose time for it is over:
 * `repeated` and `paying` out of `week1_over`, `week4` out of `week4_over`.
 */
const COUNTS = ["families", "started", "week1_over", "repeated", "week4_over", "week4", "paying"];

const zero = () => Object.fromEntries(COUNTS.map((name) => [name, 0]));

/** The counts of a line, read as whole numbers: anything else counts as none. */
function counts(line) {
  return Object.fromEntries(COUNTS.map((name) => [name, Number.isInteger(line?.[name]) ? line[name] : 0]));
}

function add(total, line) {
  for (const name of COUNTS) total[name] += line[name];
  return total;
}

/**
 * The weeks, newest first, each with its total and, when any of its families
 * came by a link, a line per link with the families without one last.
 */
export function byWeek(cohorts) {
  const weeks = new Map();
  for (const line of cohorts ?? []) {
    if (typeof line?.week !== "string") continue;
    const week = weeks.get(line.week) ?? { week: line.week, total: zero(), sources: [] };
    const own = counts(line);
    add(week.total, own);
    week.sources.push({ source: typeof line.source === "string" ? line.source : null, ...own });
    weeks.set(line.week, week);
  }
  return [...weeks.values()]
    .sort((a, b) => b.week.localeCompare(a.week))
    .map((week) => ({
      ...week,
      sources: week.sources.some((line) => line.source) ? week.sources.sort(bySourceName) : [],
    }));
}

function bySourceName(a, b) {
  if (a.source === b.source) return 0;
  if (a.source === null) return 1;
  if (b.source === null) return -1;
  return a.source.localeCompare(b.source);
}

/** Every link over all the weeks shown, the one with most families first; the families without one last. */
export function bySource(cohorts) {
  const sources = new Map();
  for (const line of cohorts ?? []) {
    if (typeof line?.week !== "string") continue;
    const source = typeof line.source === "string" ? line.source : null;
    const kept = sources.get(source) ?? { source, ...zero() };
    sources.set(source, add(kept, counts(line)));
  }
  return [...sources.values()].sort((a, b) => {
    if ((a.source === null) !== (b.source === null)) return a.source === null ? 1 : -1;
    return b.families - a.families || bySourceName(a, b);
  });
}

const percent = (count, of) => `${Math.round((count / of) * 100)} %`;

/** «3 (75 %)»: a count and its share of the families it is out of, or the count alone when there are none. */
export function share(count, of) {
  return of > 0 ? `${count} (${percent(count, of)})` : String(count);
}

/**
 * «2 de 4 (50 %)»: a number that takes time, out of the families whose time
 * for it is over; a dash while none is, so a week still running does not read
 * as none.
 */
export function outOf(count, of) {
  return of > 0 ? `${count} de ${of} (${percent(count, of)})` : "—";
}

const whole = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);

/**
 * The pilot's two figures about the children, from the platform's weekly
 * answer (`children` and `talk`), each as [label, value]: the children back
 * within seven days of their first session, out of those whose seven days are
 * over, with all of them so far beside it; and the median of a child's turns
 * per minute in a session, with Peru's decimal comma and how many sessions it
 * is of. A dash while there is nothing to say yet.
 */
export function childFigures(weekly) {
  const children = weekly?.children ?? {};
  const talk = weekly?.talk ?? {};
  const median = talk.median_child_turns_per_minute;
  const known = typeof median === "number" && Number.isFinite(median) && median >= 0;
  const sessions = whole(talk.sessions);
  return [
    [
      `niños que volvieron en 7 días (hasta hoy: ${whole(children.back_so_far)} de ${whole(children.with_a_session)})`,
      outOf(whole(children.back_in_week1), whole(children.week1_over)),
    ],
    [
      known ? `turnos del niño por minuto (mediana), en ${sessions} ${sessions === 1 ? "sesión" : "sesiones"}` : "turnos del niño por minuto (mediana)",
      known ? median.toFixed(1).replace(".", ",") : "—",
    ],
  ];
}

/** Where the platform's weeks start and end: Peru's time, or the offset it was set to. */
export function zoneLabel(offsetMinutes) {
  if (offsetMinutes === -300 || !Number.isInteger(offsetMinutes)) return "en hora de Perú";
  const hours = Math.abs(offsetMinutes) / 60;
  return `en hora UTC${offsetMinutes < 0 ? "−" : "+"}${Number.isInteger(hours) ? hours : hours.toFixed(1)}`;
}

/** «Semana del 23 nov.» for the Monday the platform names as 2026-11-23, read as that day wherever the panel is opened. */
export function weekLabel(week) {
  const [year, month, day] = String(week).split("-").map(Number);
  if (!year || !month || !day) return String(week);
  return `Semana del ${new Date(year, month - 1, day).toLocaleDateString("es-PE", { day: "numeric", month: "short" })}`;
}
