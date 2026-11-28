import { teachingResource } from "./teaching-resources.js";

// Only the public sheet ID crosses sign-in, never the student or an edited topic.
const KEY = "aule.practice";

/** A sheet selected in this tab is offered to the first student the family chooses. */
export function linkedPractice(page) {
  const address = new URL(page.location.href);
  const linked = address.searchParams.getAll("practice");
  let id = linked.length === 1 ? linked[0] : null;
  try {
    if (!linked.length) id = page.sessionStorage.getItem(KEY);
    if (teachingResource(id, "es")) page.sessionStorage.setItem(KEY, id);
    else page.sessionStorage.removeItem(KEY);
  } catch {
    // A blocked store still allows a sheet to be used in this visit.
  }
  if (linked.length) {
    address.searchParams.delete("practice");
    page.history.replaceState(page.history.state, "", address);
  }
  return (language) => {
    const sheet = teachingResource(id, language);
    id = null;
    try {
      page.sessionStorage.removeItem(KEY);
    } catch {
      // Nothing in this tab's memory can offer it again.
    }
    return sheet;
  };
}

/** Only the authored question may select guided practice in place of the generic fractions bank. */
export function matchesPractice(id, language, objective) {
  if (objective?.kind !== "explore" || objective.subject !== "matematica" || objective.due !== null) return false;
  const sheet = teachingResource(id, language);
  return sheet !== null && objective.topic === sheet.practiceTopic;
}
