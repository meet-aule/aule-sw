// The family's summaries, separate from profile settings (FIGMA.md D43).
// The guardian-scoped read supplies session summaries and named practice
// suggestions. Memories, skill scores and conversations stay off this screen.
import { $, call } from "./students.js";
import { current, getAccount, go, need, onAccount, onHide, onShow } from "./screens.js";
import { homeWords } from "./summaries.js";
import { language, locale } from "./i18n.js";

let studentId = null;
let read = 0;
const studentNow = () => (getAccount().students ?? []).find((student) => student.id === studentId);
const words = (key, values) => homeWords(key, language(), values);

need("summaries", () => studentNow() !== undefined);

export function openSummaries(student) {
  studentId = student.id;
  go("summaries");
}

function clear() {
  read += 1;
  showSkills("revisit", []);
  showSkills("ongoing", []);
  $("summary-list").replaceChildren();
  $("summaries-title").textContent = "";
  $("summaries-status").textContent = "";
  $("summaries-retry").hidden = true;
}

function showSkills(group, names) {
  const items = names.map((name) => {
    const item = document.createElement("li");
    // The curriculum supplies its skill names in Spanish, even on the English interface.
    item.lang = "es";
    item.textContent = name;
    return item;
  });
  $(`practice-${group}-list`).replaceChildren(...items);
  $(`practice-${group}`).hidden = items.length === 0;
}

function reviewItem(session) {
  const item = document.createElement("li");
  const date = new Date(`${session.day}T12:00:00`);
  const title = document.createElement("h3");
  title.textContent = Number.isNaN(date.getTime()) ? words("summary") : date.toLocaleDateString(
    locale(), { day: "numeric", month: "long", year: "numeric" },
  );
  const summary = document.createElement("p");
  summary.textContent = session.summary;
  item.append(title, summary);
  if (session.next) {
    const next = document.createElement("h4");
    next.textContent = words("next_session");
    const text = document.createElement("p");
    text.textContent = session.next;
    item.append(next, text);
  }
  return item;
}

async function load() {
  const student = studentNow();
  if (!student) return;
  clear();
  const attempt = read;
  $("summaries-title").textContent = words("summaries_title", { name: student.name });
  $("summaries-help").textContent = words("summaries_help");
  $("summaries-back").textContent = words("back_home");
  $("summary-list").setAttribute("aria-label", words("summary_list"));
  $("summaries-status").textContent = words("summaries_loading");
  const stillHere = () => attempt === read && current() === "summaries" && studentNow()?.id === student.id;
  try {
    const known = await call("api/student/known", { student_id: student.id });
    if (!stillHere()) return;
    showSkills("revisit", known.practice?.revisit ?? []);
    showSkills("ongoing", known.practice?.ongoing ?? []);
    $("summary-list").replaceChildren(...known.sessions.map(reviewItem));
    $("summaries-status").textContent = known.sessions.length ? "" : words("summaries_empty");
    $("summaries-retry").textContent = words("refresh");
  } catch {
    if (!stillHere()) return;
    $("summaries-status").textContent = words("summaries_failed");
    $("summaries-retry").textContent = words("retry");
  }
  $("summaries-retry").hidden = false;
}

onShow("summaries", load);
onHide("summaries", clear);
$("summaries-retry").addEventListener("click", load);
onAccount((account) => {
  if (account.signed_in === true && studentNow()) return;
  studentId = null;
  clear();
});
