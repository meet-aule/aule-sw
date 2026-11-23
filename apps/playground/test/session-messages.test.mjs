import assert from "node:assert/strict";
import { test } from "node:test";
import { endedMessage, recoveryMessage } from "../public/session-messages.js";

test("unknown provider details and prototype keys never become a lifecycle message", () => {
  for (const input of ["secret provider exception", "__proto__", "constructor", null, undefined]) {
    assert.equal(endedMessage(input), "La sesión terminó. Puedes volver a entrar.");
    assert.equal(recoveryMessage(input), "No se pudo continuar la sesión. Vuelve a intentarlo.");
  }
  assert.match(endedMessage("provider_error", "en"), /tutor service/);
  assert.match(recoveryMessage("resume", "en"), /Continue/);
});
