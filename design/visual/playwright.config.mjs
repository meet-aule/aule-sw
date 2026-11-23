// Regression screenshots of the playground's entry page, desktop and phone.
// They run on the Chrome installed on the machine (no browser download) and
// against a local server with made-up settings, so nothing leaves the machine.
// Pixels differ between operating systems: the baselines in `base/` were taken
// on macOS and this check is run by hand, not in CI.
import { defineConfig } from "@playwright/test";

const PORT = 8195;

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.mjs",
  snapshotPathTemplate: "{testDir}/base/{projectName}/{arg}{ext}",
  fullyParallel: false,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, channel: "chrome", colorScheme: "light", locale: "es-PE" },
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: "disabled" } },
  projects: [
    { name: "escritorio-1440", use: { viewport: { width: 1440, height: 900 } } },
    { name: "movil-390", use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: "node src/server.ts",
    cwd: "../../apps/playground",
    url: `http://127.0.0.1:${PORT}/playground/`,
    reuseExistingServer: false,
    env: {
      PLAYGROUND_PORT: String(PORT),
      LIVEKIT_URL: "wss://livekit.example.org",
      LIVEKIT_API_KEY: "key",
      LIVEKIT_API_SECRET: "a-secret-that-is-long-enough-for-hs256",
      PLAYGROUND_ACCESS_CODE: "correct horse battery",
    },
  },
});
