import { language, onLanguage, t } from "./i18n.js";
import { listTeachingResources, teachingResource } from "./teaching-resources.js";

const byId = (id) => document.getElementById(id);
const picker = byId("resource");
const activity = byId("activity");
let selected = new URL(location.href).searchParams.get("activity");

function showList(id, items) {
  byId(id).replaceChildren(...items.map((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    return li;
  }));
}

function render() {
  const options = listTeachingResources(language());
  const pack = teachingResource(selected, language()) ?? teachingResource(options[0].id, language());
  selected = pack.id;
  picker.replaceChildren(...options.map(({ id, title }) => new Option(title, id)));
  picker.value = selected;
  byId("activity-title").textContent = pack.title;
  document.title = `${pack.title} · Aule`;
  for (const id of ["goal", "prompt", "workedExample", "exitTicket", "answerKey"]) byId(id).textContent = pack[id];
  showList("plan", pack.plan);
  showList("rubric", pack.rubric);
  for (const detail of activity.querySelectorAll("details")) detail.open = false;
  const query = new URLSearchParams({ practice: pack.id, lang: language() });
  byId("practice").href = `./?${query}`;
  activity.hidden = false;
}

picker.addEventListener("change", () => {
  selected = picker.value;
  const address = new URL(location.href);
  address.searchParams.set("activity", selected);
  history.replaceState(history.state, "", address);
  render();
});

byId("print").addEventListener("click", () => window.print());

byId("download").addEventListener("click", () => {
  const pack = teachingResource(selected, language());
  const sections = [
    ["goal", pack.goal], ["prompt", pack.prompt],
    ["plan", pack.plan.map((line, i) => `${i + 1}. ${line}`).join("\n")],
    ["example", pack.workedExample], ["rubric", pack.rubric.map((line) => `- ${line}`).join("\n")],
    ["exit", pack.exitTicket], ["key", pack.answerKey],
  ];
  const blocks = sections.map(([label, text]) => `## ${t(`resources.${label}`)}\n\n${text}`);
  const attribution = `${t("resources.source")} · SPDX-License-Identifier: Apache-2.0\nhttps://www.apache.org/licenses/LICENSE-2.0`;
  const file = new Blob([[`# ${pack.title}`, ...blocks, attribution].join("\n\n"), "\n"], { type: "text/markdown;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = `aule-${pack.id}-${language()}.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

onLanguage(render);
render();
