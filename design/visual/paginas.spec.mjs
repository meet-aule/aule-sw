import { expect, test } from "@playwright/test";

test("playground: página de entrada", async ({ page }) => {
  // Google's sign-in button comes from another domain: not in a regression run.
  await page.route(/accounts\.google\.com/, (route) => route.abort());
  await page.goto("/playground/");
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot("playground-entrada.png", { fullPage: true });
});
