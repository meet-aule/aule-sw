import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../public/signin.js", import.meta.url), "utf8");
// Exercise the page's plan presentation without loading sign-in widgets or a DOM.
const presentation = source.slice(source.indexOf("const DAY_MS"), source.indexOf("\nfunction show(account"));

test("free access keeps entry open with no remaining-session number in both languages", () => {
  for (const [lang, text] of [["es", "Acceso gratuito: sesiones sin límite."], ["en", "Free access: unlimited sessions."]]) {
    const line = runInNewContext(`${presentation}\nplanLine`, { document: { documentElement: { lang } } });
    const free = line({ plan: "free", left: null, allowed: null, ends_at: null });
    assert.equal(free.open, true);
    assert.equal(free.text, text);
    assert.equal(line({ plan: "none", left: 0 }).open, false);
    assert.equal(line({ plan: "trial", ends_at: "2026-11-21", left: 0 }).open, false);
  }
});
