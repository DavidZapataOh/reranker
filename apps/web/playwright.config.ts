import { defineConfig, devices } from "@playwright/test";
import { assertDeploymentUrl, bypassHeaders } from "@reranker/testing/playwright";

// Validated before bypassHeaders() so the secret never goes to an untrusted host.
const deploymentUrl = process.env.PLAYWRIGHT_BASE_URL
  ? assertDeploymentUrl(process.env.PLAYWRIGHT_BASE_URL, { allowProduction: true }).origin
  : undefined;
// `next start` reads PORT too, so both sides agree when 3000 is taken.
const localUrl = `http://localhost:${process.env.PORT ?? 3000}`;

export default defineConfig({
  testDir: "./e2e",
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
    extraHTTPHeaders: bypassHeaders(),
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
