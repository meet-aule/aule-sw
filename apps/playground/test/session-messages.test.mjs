import assert from "node:assert/strict";
import { test } from "node:test";
import { endedMessage, languageOf, recoveryMessage } from "../public/session-messages.js";

test("unknown provider details and prototype keys never become a lifecycle message", () => {
  for (const input of ["secret provider exception", "__proto__", "constructor", null, undefined]) {
    assert.equal(endedMessage(input), "Cuando quieras, empezamos otra.");
    assert.equal(recoveryMessage(input), "No pudimos seguir con la sesión. Vuelve a intentarlo.");
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
