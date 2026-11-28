import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { objectiveFor, OWN_SUBJECT } from "../public/steps.js";
import { listTeachingResources, teachingResource } from "../public/teaching-resources.js";

const catalog = JSON.parse(await readFile(new URL("../../../curriculum/math-primaria.json", import.meta.url), "utf8"));
const ids = ["equivalent-fractions", "compare-fractions", "add-fractions"];

test("each activity opens in both languages and links to a fifth-grade curriculum skill", () => {
  for (const language of ["es", "en"]) {
    const choices = listTeachingResources(language);
    assert.deepEqual(choices.map((choice) => choice.id), ids);
    for (const { id, title } of choices) {
      const pack = teachingResource(id, language);
      assert.equal(pack.title, title);
      const skill = catalog.skills.find((skill) => skill.id === pack.skillId);
      assert.equal(skill?.grade, "P5", id);
      assert.equal(skill.subject, "math");
      for (const field of ["title", "goal", "prompt", "workedExample", "exitTicket", "answerKey", "practiceTopic"]) {
        assert.ok(pack[field].trim(), field);
        assert.notEqual(pack[field], teachingResource(id, language === "es" ? "en" : "es")[field], field);
      }
      assert.notEqual(pack.prompt, pack.exitTicket);
      for (const items of [pack.plan, pack.rubric]) {
        assert.equal(items.length, 3);
        assert.equal(new Set(items).size, 3);
        assert.ok(items.every((item) => item.trim()));
      }
      // The existing session form accepts a 200-character topic. Hand off the
      // exact exercise from the guide, leaving the worked example and exit key here.
      assert.ok(pack.practiceTopic.length <= 200);
      assert.ok(pack.practiceTopic.endsWith(`. ${pack.prompt}`));
      assert.ok(pack.practiceTopic.length > pack.prompt.length + 2);
      assert.ok(!pack.practiceTopic.includes(pack.workedExample));
      assert.ok(!pack.practiceTopic.includes(pack.answerKey));
      assert.deepEqual(objectiveFor("explore", { subject: OWN_SUBJECT, topic: pack.practiceTopic }), {
        kind: "explore", subject: "matematica", topic: pack.practiceTopic, due: null,
      });
    }
  }
});

test("locale variants resolve and an unknown resource never opens a different one", () => {
  const first = ids[0];
  assert.deepEqual(teachingResource(first, "en-US"), teachingResource(first, "en"));
  assert.deepEqual(listTeachingResources("EN"), listTeachingResources("en"));
  assert.deepEqual(teachingResource(first, "fr"), teachingResource(first, "es"));
  assert.deepEqual(listTeachingResources(), listTeachingResources("es"));
  for (const id of [null, undefined, "", "__proto__", "constructor", "missing"]) {
    assert.equal(teachingResource(id, "es"), null);
  }
});

function fractions(text) {
  return [...text.matchAll(/(\d+)\/(\d+)/g)].map((match) => [Number(match[1]), Number(match[2])]);
}

function equivalent([n, d], [m, k]) {
  assert.equal(n * k, m * d);
}

test("the worked examples and independent exit questions use correct fractions in both languages", () => {
  for (const language of ["es", "en"]) {
    const ribbon = teachingResource("equivalent-fractions", language);
    for (const [question, explanation, denominator] of [
      [ribbon.prompt, ribbon.workedExample, 12],
      [ribbon.exitTicket, ribbon.answerKey, 24],
    ]) {
      const [given] = fractions(question);
      const [before, after] = fractions(explanation);
      assert.deepEqual(given, before);
      assert.ok(question.includes(String(denominator)));
      assert.equal(after[1], denominator);
      equivalent(before, after);
    }

    const route = teachingResource("compare-fractions", language);
    for (const [question, explanation, divisions] of [
      [route.prompt, route.workedExample, 8],
      [route.exitTicket, route.answerKey, 18],
    ]) {
      const [[n, d], [m, k]] = fractions(question);
      const first = n * divisions / d;
      const second = m * divisions / k;
      assert.equal(first - second, 1);
      assert.ok(explanation.includes(`${first}/${divisions}`));
      assert.ok(explanation.includes(`${second}/${divisions}`));
    }

    const jug = teachingResource("add-fractions", language);
    for (const [question, explanation] of [
      [jug.prompt, jug.workedExample], [jug.exitTicket, jug.answerKey],
    ]) {
      const [[n, d], [m, k]] = fractions(question);
      const total = fractions(explanation).at(-1);
      equivalent(total, [n * k + m * d, d * k]);
    }
  }
});
