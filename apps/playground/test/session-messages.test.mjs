import assert from "node:assert/strict";
import { test } from "node:test";
import { ENDINGS, RECOVERY_KEYS, endedMessage, languageOf, recoveryMessage } from "../public/session-messages.js";

test("unknown provider details and prototype keys never become a lifecycle message", () => {
  for (const input of ["secret provider exception", "__proto__", "constructor", null, undefined]) {
    assert.equal(endedMessage(input), "Cuando quieras, empezamos otra.");
    assert.equal(recoveryMessage(input), "No pudimos seguir con la sesión; vuelve a intentarlo.");
    // Nor does a language the page does not have: the words are Spanish.
    assert.equal(endedMessage("child_ended", input), endedMessage("child_ended"));
  }
  assert.match(endedMessage("provider_error", "en"), /tutor service/);
  assert.match(recoveryMessage("resume", "en"), /Continue/);
});

test("the language an element is marked with is the one its words are in", () => {
  assert.equal(languageOf("en"), "en");
  assert.equal(languageOf("es"), "es");
  // A language the page has no words in is shown, and marked, in Spanish.
  for (const input of ["qu", "EN", "__proto__", "constructor", "", null, undefined]) assert.equal(languageOf(input), "es", String(input));
  for (const language of ["es", "en", "qu", "__proto__", null, undefined]) {
    assert.equal(recoveryMessage("resume_title", language), recoveryMessage("resume_title", languageOf(language)));
    assert.equal(endedMessage("idle", language), endedMessage("idle", languageOf(language)));
  }
  // Each language the page marks has words of its own.
  assert.notEqual(recoveryMessage("resume_title", "en"), recoveryMessage("resume_title", "es"));
  assert.notEqual(endedMessage("idle", "en"), endedMessage("idle", "es"));
});

test("when Aule does not arrive, the title, the line under it and the end screen have words in both languages", () => {
  for (const key of ["missing_title", "tutor_missing", "no_tutor"]) {
    const es = recoveryMessage(key, "es");
    const en = recoveryMessage(key, "en");
    // Words of their own, not the fallback for a key the table does not have.
    for (const text of [es, en]) {
      assert.ok(text.trim(), key);
      assert.notEqual(text, recoveryMessage("failed", "es"), key);
      assert.notEqual(text, recoveryMessage("failed", "en"), key);
      assert.doesNotMatch(text, /[!¡]/, `${key}: calm, nobody's fault`);
    }
    assert.notEqual(es, en, key);
  }
  // The title says what happened, the line under it whose fault it is not, and nothing is said
  // twice: «La sesión empezó.» is not the title of a session Aule never came to (the review of 24 Nov).
  assert.equal(recoveryMessage("missing_title", "es"), "Aule no pudo llegar");
  // A15's title is the session's own, in the student's language like the rest.
  assert.equal(recoveryMessage("started", "es"), "La sesión empezó.");
  assert.equal(recoveryMessage("started", "en"), "The session started.");
  assert.match(recoveryMessage("tutor_missing", "es"), /no es tu culpa/i);
  assert.match(recoveryMessage("tutor_missing", "en"), /not your fault/i);
  assert.doesNotMatch(recoveryMessage("tutor_missing", "es"), /no pudo llegar/);
  assert.ok(!RECOVERY_KEYS.includes("tutor_missing_short"), "no second «Aule no pudo llegar.» under the sad face");
  assert.match(recoveryMessage("no_tutor", "es"), /no cuenta/);
  assert.match(recoveryMessage("no_tutor", "en"), /doesn't count/);
});

test("no ending says goodbye with an exclamation mark, in either language: calm, as the tutor speaks", () => {
  const reasons = ["child_ended", "parent_ended", "budget_reached", "idle", "device_offline", "not_working", "provider_error", "error", "unknown"];
  assert.deepEqual([...ENDINGS], reasons);
  for (const language of ["es", "en"]) {
    for (const reason of reasons) assert.doesNotMatch(endedMessage(reason, language), /[!¡]/, `${reason} in ${language}`);
  }
  assert.equal(endedMessage("child_ended", "es"), "Gracias por la sesión de hoy, nos vemos pronto.");
  assert.equal(endedMessage("budget_reached", "es"), "Buen trabajo, se nos acabó el tiempo.");
});

test("a line on the child's screen is one sentence, here as in first-steps.js (D33)", () => {
  // A sentence ends at «.», «?» or «…» before a space or the end; a line's own closing «…» is no break.
  const ends = (text) => (text.replace(/…$/, "").match(/[.?…](\s|$)/g) ?? []).length;
  for (const language of ["es", "en"]) {
    for (const reason of ENDINGS) assert.ok(ends(endedMessage(reason, language)) <= 1, `${reason} in ${language}: «${endedMessage(reason, language)}»`);
    for (const key of RECOVERY_KEYS) {
      const text = recoveryMessage(key, language);
      assert.ok(text.trim(), `${key} has words in ${language}`);
      assert.doesNotMatch(text, /[!¡]/, `${key} in ${language}`);
      assert.ok(ends(text) <= 1, `${key} in ${language}: «${text}»`);
    }
  }
  // Each key is written in each language.
  for (const key of RECOVERY_KEYS) {
    if (!["missing_title"].includes(key)) assert.notEqual(recoveryMessage(key, "es"), recoveryMessage(key, "en"), key);
  }
});
