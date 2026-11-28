// The room's visible surface. A pointer is a part of the drawing, never a pixel
// coordinate or a transcript. It stays in this tab until the next voice turn reads it.
export const BOARD_RPC = "aule.board.v1";

function sceneOf(visual) {
  if (visual.kind === "rectangle" && visual.unit === "cm" &&
      [visual.width, visual.height].every(n => Number.isInteger(n) && n > 0 && n <= 50)) {
    return { kind: "rectangle", width: visual.width, height: visual.height };
  }
  if (visual.kind === "fraction_bars" && visual.fractions.length > 0 && visual.fractions.length <= 4) {
    const rows = visual.fractions.map(f => [f.numerator, f.denominator]);
    if (rows.every(([n, d]) => Number.isInteger(n) && Number.isInteger(d) && n >= 0 && n <= d && d >= 1 && d <= 12)) {
      return { kind: "bars", rows };
    }
  }
  return null;
}

function visualOf(scene, existing) {
  if (scene.kind === "rectangle") return { ...existing, kind: "rectangle", width: scene.width, height: scene.height, unit: "cm" };
  return {
    ...existing, kind: "fraction_bars", fractions: scene.rows.map(([numerator, denominator], i) =>
      ({ ...(existing?.fractions?.[i] ?? { labelled: false }), numerator, denominator })),
  };
}

export class Board {
  constructor({ element, visible, canApply, paint, language, display }) {
    this.element = element;
    this.visible = visible;
    this.canApply = canApply;
    this.display = display;
    this.paint = paint;
    this.language = language;
    this.enabled = false;
    this.reset();
  }

  reset() {
    this.visual = null;
    this.scene = null;
    this.point = null;
    this.interrupt();
  }

  interrupt() {
    this.revision = crypto.randomUUID();
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    if (this.scene) this.paint(this.visual, this.options());
  }

  options() {
    return this.enabled && this.scene ? { mark: this.scene.mark, point: this.point, language: this.language() } : undefined;
  }

  // Scripted exercises and existing show calls go through the same surface.
  replace(visual) {
    const scene = sceneOf(visual);
    const options = this.enabled && scene ? { language: this.language(), point: null } : undefined;
    this.paint(visual, options);
    this.visual = visual;
    this.scene = scene;
    this.point = null;
    this.interrupt();
  }

  view() {
    return this.visible() ? { revision: this.revision, scene: this.scene, point: this.point } : null;
  }

  handle(message) {
    this.enable();
    if (message.read === true) return { view: this.view() };
    if (!this.visible() || !this.canApply() || message.expect !== this.revision) return { applied: false, view: this.view() };
    if (message.replace) {
      this.display(message.replace);
      return { applied: true, view: this.view() };
    }
    const scene = message.scene;
    const visual = visualOf(scene, message.keepPoint ? this.visual : null);
    const point = message.keepPoint ? this.point : null;
    // Commit only after the same synchronous DOM paint used for ordinary drawings succeeds.
    this.paint(visual, { mark: scene.mark, point, language: this.language() });
    this.scene = scene;
    this.visual = visual;
    this.point = point;
    this.interrupt();
    return { applied: true, view: this.view() };
  }

  select(event) {
    if (!this.enabled || !this.scene || !this.visible()) return;
    if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
    const target = event.target.closest?.("[data-part]");
    if (!target || !this.element.contains(target)) return;
    event.preventDefault();
    // Space selects the focused part before the page's push-to-talk shortcut.
    if (event.type === "keydown") event.stopPropagation();
    if (this.point === target.dataset.part) return;
    this.element.querySelector('[aria-pressed="true"]')?.setAttribute("aria-pressed", "false");
    target.setAttribute("aria-pressed", "true");
    this.point = target.dataset.part;
    this.interrupt();
  }
}

export function registerBoard(room, board, isTutor) {
  room.localParticipant.registerRpcMethod(BOARD_RPC, async ({ callerIdentity, payload }) => {
    if (!isTutor(callerIdentity) || payload.length > 2048) return "{}";
    return JSON.stringify(board.handle(JSON.parse(payload)));
  });
}
