import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Board, BOARD_RPC, registerBoard } from "../public/board.js";
import { renderVisual } from "../public/visuals.js";

const examples = JSON.parse(readFileSync(new URL("../../../contracts/board/lesson.v1.example.json", import.meta.url)));

function tab(language = "es") {
  let markup = "", visible = true, canApply = true;
  const element = { contains: () => true, querySelector: () => null };
  const board = new Board({ element, language: () => language, visible: () => visible, canApply: () => canApply,
    paint: (visual, options) => { markup = renderVisual(visual, options); } });
  let rpc;
  registerBoard({ localParticipant: { registerRpcMethod(name, handler) {
    assert.equal(name, BOARD_RPC);
    rpc = async (data, callerIdentity = "tutor") => JSON.parse(await handler({ callerIdentity, payload: JSON.stringify(data) }));
  } } }, board, identity => identity === "tutor");
  const read = async () => (await rpc({ read: true })).view;
  async function apply(item, keepPoint = false) {
    return await rpc({ expect: (await read()).revision, scene: item.scene, keepPoint });
  }
  function point(id, type = "click", key) {
    assert.ok(markup.includes(`data-part="${id}"`));
    const target = { dataset: { part: id }, setAttribute() {} };
    let stopped = false;
    board.select({ type, key, target: { closest: () => target }, preventDefault() {}, stopPropagation() { stopped = true; } });
    return stopped;
  }
  return { board, rpc, read, apply, point, markup: () => markup, visible: v => { visible = v; }, canApply: v => { canApply = v; } };
}

test("an actual cell and side are selectable and labelled in either session language", async () => {
  for (const language of ["en", "es"]) {
    const page = tab(language);
    assert.equal((await page.apply(examples.fraction[0])).applied, true);
    assert.equal((await page.apply(examples.fraction[1], true)).applied, true);
    assert.equal((page.markup().match(/role="button"/g) || []).length, 6);
    assert.ok(page.markup().includes(language === "en" ? "Bar 2, part 3 of 4" : "Barra 2, parte 3 de 4"));
    page.point("r2c3");
    assert.equal((await page.read()).point, "r2c3");
    assert.equal((await page.apply(examples.fraction[2], true)).view.point, "r2c3");
    assert.equal((await page.apply(examples.perimeter[0])).view.point, null);
    assert.ok(page.markup().includes(language === "en" ? "Right side" : "Lado derecho"));
    assert.ok(page.point("right", "keydown", "Enter"));
    assert.equal((await page.read()).point, "right");
    assert.ok(page.point("left", "keydown", " "));
    assert.equal((await page.read()).point, "left");
  }
});

test("an interruption or new point invalidates an in-flight step while retaining the exact drawing", async () => {
  const page = tab();
  await page.apply(examples.fraction[0]);
  const before = await page.read(), drawing = page.markup();
  page.board.interrupt();
  const late = await page.rpc({ expect: before.revision, scene: examples.fraction[1].scene, keepPoint: true });
  assert.equal(late.applied, false);
  assert.deepEqual(late.view.scene, before.scene);
  assert.equal(page.markup(), drawing);
  const after = await page.read();
  page.point("r1c2");
  assert.equal((await page.rpc({ expect: after.revision, scene: examples.perimeter[0].scene })).applied, false);
  assert.equal((await page.read()).point, "r1c2");
  page.canApply(false);
  assert.equal((await page.apply(examples.fraction[1])).applied, false);
  page.visible(false);
  assert.equal(await page.read(), null);
  assert.deepEqual(await page.rpc({ read: true }, "someone-else"), {});
  page.visible(true);
  page.board.reset();
  assert.equal((await page.read()).scene, null);
  assert.equal((await page.rpc({ expect: before.revision, scene: examples.fraction[1].scene })).applied, false);
});

test("scripted visuals keep their authored labels and replace the previous selection", async () => {
  const page = tab();
  await page.read();
  page.board.replace({ kind: "fraction_bars", fractions: [{ numerator: 1, denominator: 2, label: "A" }] });
  page.point("r1c2");
  await page.apply(examples.fraction[1], true);
  assert.ok(page.markup().includes(">A<"));
  page.board.replace({ kind: "exercise", lines: ["7 + 5"] });
  assert.equal((await page.read()).point, null);
  assert.equal((await page.read()).scene, null);
});
