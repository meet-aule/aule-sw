import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { contrastProblems, controlProblems } from "../contrast-dom.mjs";
import { readDesign } from "../tokens.mjs";

const { state } = readDesign(join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "DESIGN.md"));
const component = (name, prop) => state.components.get(name).properties.get(prop).hex;
const rgb = (css) => "#" + css.match(/\d+/g).slice(0, 3).map((v) => Number(v).toString(16).padStart(2, "0")).join("");

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

const showEverything = (page) => page.evaluate(() => document.querySelectorAll("[hidden]").forEach((el) => el.removeAttribute("hidden")));

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
