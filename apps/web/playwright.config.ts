import { defineConfig, devices } from "@playwright/test";
import { assertDeploymentUrl } from "@reranker/testing/playwright";

// The fixtures send the bypass secret only to this origin, so it must be ours.
const deploymentUrl = process.env.PLAYWRIGHT_BASE_URL
  ? assertDeploymentUrl(process.env.PLAYWRIGHT_BASE_URL, { allowProduction: true }).origin
  : undefined;
// `next start` reads PORT too, so both sides agree when 3000 is taken.
const localUrl = `http://localhost:${process.env.PORT ?? 3000}`;

export default defineConfig({
  testDir: "./e2e",
  // Parity baselines are per environment and never committed.
  snapshotPathTemplate: `e2e/__ui-baseline__/{arg}-${process.env.UI_BASELINE ?? "local"}-{projectName}{ext}`,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  failOnFlakyTests: process.env.STRICT_FLAKY === "1",
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }], ["json", { outputFile: "results.json" }]]
    : "list",
  use: {
    baseURL: deploymentUrl ?? localUrl,
    trace: "on-first-retry",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
    { name: "mobile-webkit", use: { ...devices["iPhone 15"] } },
  ],
  ...(deploymentUrl
    ? {}
    : {
        webServer: {
          command: "pnpm start",
          url: localUrl,
          reuseExistingServer: !process.env.CI,
        },
      }),
});
