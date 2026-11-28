import assert from "node:assert/strict";
import { test } from "node:test";
import { linkedPractice, matchesPractice } from "../public/practice-intent.js";
import { teachingResource } from "../public/teaching-resources.js";

function tab(search = "") {
  const entries = new Map();
  const page = {
    location: { href: `https://example.test/session/${search}` },
    history: { replaceState: (_state, _title, url) => { page.location.href = url.href; } },
    sessionStorage: {
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => entries.set(key, value),
      removeItem: (key) => entries.delete(key),
    },
  };
  return { page, entries };
}

test("only the public sheet ID survives a sign-in redirect, once and in the selected student's language", () => {
  const { page, entries } = tab("?practice=compare-fractions&lang=es#home");
  linkedPractice(page);
  assert.equal(page.location.href, "https://example.test/session/?lang=es#home");
  assert.deepEqual([...entries.values()], ["compare-fractions"]);
  page.location.href = "https://example.test/session/";
  const take = linkedPractice(page);
  const sheet = take("en");
  assert.equal(sheet.practiceTopic, teachingResource("compare-fractions", "en").practiceTopic);
  assert.equal(take("es"), null);
  assert.equal(linkedPractice(page)("es"), null, "another student or a fresh load gets no sheet");
});

test("an unknown or ambiguous link discards any previous selection", () => {
  for (const query of ["practice=one", "practice=", "practice=add-fractions&practice=compare-fractions"]) {
    const { page, entries } = tab("?practice=add-fractions");
    linkedPractice(page);
    page.location.href = `https://example.test/session/?${query}`;
    assert.equal(linkedPractice(page)("es"), null);
    assert.equal(entries.size, 0);
    assert.equal(new URL(page.location.href).search, "");
  }
});

test("an explicit link can be used without allowing browser storage", () => {
  const { page } = tab("?practice=add-fractions");
  Object.defineProperty(page, "sessionStorage", { get() { throw new Error("blocked"); } });
  const take = linkedPractice(page);
  assert.equal(take("es").id, "add-fractions");
  assert.equal(take("es"), null);
});

test("only the matching topic, subject, kind and session language can use the guided activity", () => {
  const id = "add-fractions";
  const objective = { kind: "explore", subject: "matematica", topic: teachingResource(id, "es").practiceTopic, due: null };
  assert.equal(matchesPractice(id, "es", objective), true);
  assert.equal(matchesPractice(id, "en", objective), false);
  assert.equal(matchesPractice("compare-fractions", "es", objective), false);
  assert.equal(matchesPractice("unknown", "es", objective), false);
  for (const changes of [{ kind: "homework" }, { subject: "other" }, { topic: "fracciones" }, { due: "2026-06-01" }]) {
    assert.equal(matchesPractice(id, "es", { ...objective, ...changes }), false);
  }
});
