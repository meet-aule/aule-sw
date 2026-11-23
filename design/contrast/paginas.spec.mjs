import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { contrastProblems, controlProblems, placeholderProblems } from "../contrast-dom.mjs";
import { readDesign } from "../tokens.mjs";

const { state } = readDesign(join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "DESIGN.md"));
const component = (name, prop) => state.components.get(name).properties.get(prop).hex;
const rgb = (css) => "#" + css.match(/\d+/g).slice(0, 3).map((v) => Number(v).toString(16).padStart(2, "0")).join("");

// A computed colour with its alpha, as the eight hex digits of the tokens.
const rgba = (css) => {
  const [r, g, b, a = 1] = css.match(/[\d.]+/g).map(Number);
  const hex = (v) => Math.round(v).toString(16).padStart(2, "0");
  return "#" + hex(r) + hex(g) + hex(b) + (a < 1 ? hex(a * 255) : "");
};

async function open(page) {
  // Google's sign-in button comes from another domain: not in this run.
  await page.route(/accounts\.google\.com/, (route) => route.abort());
  await page.goto("/playground/");
  await page.evaluate(() => document.fonts.ready);
}

async function expectReadable(page, label) {
  const { measured, problems } = await contrastProblems(page);
  expect(measured, `${label}: nothing was measured`).toBeGreaterThan(5);
  expect(problems, label).toEqual([]);
}

test("the entry page: every text reaches 4.5:1", async ({ page }) => {
  await open(page);
  await expectReadable(page, "entry");
});

// The page builds most of its screens with `hidden` and the app's script. A run
// without a session cannot open them, so each one is shown as it is in the HTML.
test("every screen of the page, shown: every text reaches 4.5:1", async ({ page }) => {
  await open(page);
  await page.evaluate(() => document.querySelectorAll("[hidden]").forEach((el) => el.removeAttribute("hidden")));
  await expectReadable(page, "all screens");
});

test("the buttons, all disabled or sending: still readable, and never faded", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    document.querySelectorAll("[hidden]").forEach((el) => el.removeAttribute("hidden"));
    document.querySelectorAll("button").forEach((b) => (b.disabled = true));
  });
  const opacities = await page.evaluate(() => [...document.querySelectorAll("button")].map((b) => getComputedStyle(b).opacity));
  expect(new Set(opacities)).toEqual(new Set(["1"]));
  await expectReadable(page, "disabled buttons");
});

test("the buttons that switch (on and off) are readable in both states", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    document.querySelectorAll("[hidden]").forEach((el) => el.removeAttribute("hidden"));
    document.querySelectorAll("button[aria-pressed]").forEach((b, i) => b.setAttribute("aria-pressed", i % 2 ? "true" : "false"));
  });
  await expectReadable(page, "switches");
});

test("an error message", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const message = document.getElementById("message");
    message.textContent = "No pudimos entrar. Revisa el código e inténtalo de nuevo.";
    message.removeAttribute("hidden");
  });
  await expectReadable(page, "error message");
  const style = await page.locator("#message").evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.color, border: s.borderTopColor };
  });
  expect(rgb(style.color)).toBe(component("notice-error", "textColor"));
});

test("the buttons of the page are the variants of DESIGN.md", async ({ page }) => {
  await open(page);
  await page.evaluate(() => document.querySelectorAll("[hidden]").forEach((el) => el.removeAttribute("hidden")));
  const read = (selector) =>
    page.locator(selector).first().evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, color: s.color, radius: s.borderRadius };
    });
  const filled = await read("#join");
  expect(rgb(filled.bg)).toBe(component("button-primary", "backgroundColor"));
  expect(rgb(filled.color)).toBe(component("button-primary", "textColor"));
  expect(filled.radius).toBe("8px");
  const quiet = await read("#back");
  expect(rgb(quiet.bg)).toBe(component("button-secondary", "backgroundColor"));
  expect(rgb(quiet.color)).toBe(component("button-secondary", "textColor"));
  const danger = await read("#end");
  expect(rgb(danger.bg)).toBe(component("button-danger", "backgroundColor"));
  expect(rgb(danger.color)).toBe(component("button-danger", "textColor"));
});

const showEverything = (page) =>
  page.evaluate(() => {
    document.querySelectorAll("[hidden]").forEach((el) => el.removeAttribute("hidden"));
    document.querySelectorAll("details").forEach((d) => (d.open = true));
  });

test("the edge of every form control reaches 3:1 (WCAG 1.4.11)", async ({ page }) => {
  await open(page);
  await showEverything(page);
  const { measured, problems } = await controlProblems(page);
  expect(measured, "no control was measured").toBeGreaterThan(10);
  expect(problems).toEqual([]);
});

test("the edge of the controls is field-border, and it is not the line", async ({ page }) => {
  await open(page);
  await showEverything(page);
  const edges = await page.evaluate(() => {
    const read = (selector) => getComputedStyle(document.querySelector(selector)).borderTopColor;
    return { text: read("#student-name"), select: read("#student-grade"), area: read("#explanation-text"), box: read("#consent"), card: read("form#entry") };
  });
  const field = state.colors.get("field-border").hex;
  for (const key of ["text", "select", "area", "box"]) expect(rgb(edges[key]), key).toBe(field);
  // a card keeps the line
  expect(edges.card).not.toBe(edges.text);
});

test("mutation: controls with the line as their edge are below 3:1, and the check says so", async ({ page }) => {
  await open(page);
  await showEverything(page);
  await page.addStyleTag({
    content: "input, select, textarea, label.chip span, .student span, label.tone span { border-color: var(--aule-color-line) !important; }",
  });
  const { problems } = await controlProblems(page);
  expect(problems.length).toBeGreaterThan(8);
  expect(problems.join("\n")).toMatch(/is 1\.[0-3]\d:1/);
});

test("the placeholder of every empty field reaches 4.5:1, and it is the muted token", async ({ page }) => {
  await open(page);
  await showEverything(page);
  const { measured, problems } = await placeholderProblems(page);
  expect(measured, "no placeholder was measured").toBeGreaterThan(3);
  expect(problems).toEqual([]);
  const color = await page.locator("#topic").evaluate((el) => getComputedStyle(el, "::placeholder").color);
  expect(rgba(color)).toBe(component("field-placeholder", "textColor"));
});

test("mutation: a placeholder at 50% of the ink (what the framework's reset does) fails the check", async ({ page }) => {
  await open(page);
  await showEverything(page);
  await page.addStyleTag({ content: "::placeholder { color: color-mix(in srgb, currentColor 50%, transparent) !important; }" });
  const { problems } = await placeholderProblems(page);
  expect(problems.length).toBeGreaterThan(3);
  expect(problems.join("\n")).toMatch(/is [23]\.\d\d:1/);
});

test("the switches (aria-pressed) have a 3:1 edge in both states, and it is field-border", async ({ page }) => {
  await open(page);
  await showEverything(page);
  const field = state.colors.get("field-border").hex;
  for (const pressed of ["true", "false"]) {
    await page.evaluate((value) => document.querySelectorAll("button[aria-pressed]:not(.talk)").forEach((b) => b.setAttribute("aria-pressed", value)), pressed);
    const edges = await page.evaluate(() => [...document.querySelectorAll("button[aria-pressed]:not(.talk)")].map((b) => getComputedStyle(b).borderTopColor));
    expect(edges.length, "no switch").toBeGreaterThan(3);
    for (const edge of edges) expect(rgb(edge), pressed).toBe(field);
    const { problems } = await controlProblems(page);
    expect(problems, pressed).toEqual([]);
    const measured = await page.evaluate(() => document.querySelectorAll("button[aria-pressed]").length);
    expect(measured).toBeGreaterThan(3);
  }
});

test("the measure of edges walks the switches too: with the line as their edge it fails", async ({ page }) => {
  await open(page);
  await showEverything(page);
  await page.addStyleTag({ content: "button[aria-pressed] { border-color: var(--aule-color-line) !important; }" });
  const { problems } = await controlProblems(page);
  expect(problems.some((p) => p.includes("button[aria-pressed="))).toBe(true);
  expect(problems.join("\n")).toMatch(/is 1\.[0-3]\d:1/);
});

test("the destructive buttons under the pointer are the hover variants of DESIGN.md, and readable", async ({ page }) => {
  await open(page);
  await showEverything(page);
  const read = (locator) =>
    locator.evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, color: s.color };
    });
  const erase = page.locator("button[type=submit].danger").first();
  await expect(erase).toBeVisible();
  const rest = await read(erase);
  expect(rgb(rest.bg)).toBe(component("button-destructive", "backgroundColor"));
  await erase.hover();
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });
  const hovered = await read(erase);
  expect(rgb(hovered.bg)).toBe(component("button-destructive-hover", "backgroundColor"));
  expect(rgb(hovered.color)).toBe(component("button-destructive-hover", "textColor"));
  expect(rgb(hovered.bg)).not.toBe("#8f1d14"); // not a blend with black
  expect((await contrastProblems(page)).problems).toEqual([]);

  const outlined = page.locator("button.danger:not([type=submit])").first();
  await expect(outlined).toBeVisible();
  await outlined.hover();
  const out = await read(outlined);
  expect(rgb(out.color)).toBe(component("button-danger-hover", "textColor"));
  expect(rgb(out.bg)).toBe(component("button-danger-hover", "backgroundColor"));
  expect((await contrastProblems(page)).problems).toEqual([]);

  const link = page.locator("button.danger-text").first();
  await expect(link).toBeVisible();
  await link.hover();
  expect(rgb((await read(link)).color)).toBe(component("button-danger-link-hover", "textColor"));
});

test("the pointer over every visible button leaves it readable (4.5:1)", async ({ page }) => {
  await open(page);
  await showEverything(page);
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; }" });
  const buttons = page.locator("button");
  const count = await buttons.count();
  let hovered = 0;
  for (let i = 0; i < count; i++) {
    const button = buttons.nth(i);
    if (!(await button.isVisible()) || (await button.isDisabled())) continue;
    await button.scrollIntoViewIfNeeded();
    await button.hover({ force: true });
    hovered += 1;
    const { problems } = await contrastProblems(page);
    expect(problems, `hovering button ${i}`).toEqual([]);
  }
  expect(hovered).toBeGreaterThan(10);
});

test("mutation: the old hover of the destructive button, danger blended with black, is not the token", async ({ page }) => {
  await open(page);
  await showEverything(page);
  await page.addStyleTag({ content: "button[type=submit].danger:hover { background: color-mix(in srgb, var(--aule-color-danger) 80%, black) !important; }" });
  const erase = page.locator("button[type=submit].danger").first();
  await erase.hover();
  const bg = await erase.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(rgb(bg)).not.toBe(component("button-destructive-hover", "backgroundColor"));
});

test("mutation: a hover that leaves the text unreadable fails the pointer test", async ({ page }) => {
  await open(page);
  await showEverything(page);
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; } button:hover:not(:disabled) { background: var(--aule-color-primary) !important; color: var(--aule-color-secondary-text) !important; }" });
  const button = page.locator("button.quiet:visible, button#back").first();
  await button.hover({ force: true });
  const { problems } = await contrastProblems(page);
  expect(problems.length).toBeGreaterThan(0);
});
