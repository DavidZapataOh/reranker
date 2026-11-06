import { defineConfig, devices } from "@playwright/test";
import { assertDeploymentUrl, bypassHeaders } from "@reranker/testing/playwright";

const deploymentUrl = process.env.PLAYWRIGHT_BASE_URL;
// `next start` reads PORT too, so both sides agree when 3000 is taken.
const localUrl = `http://localhost:${process.env.PORT ?? 3000}`;
if (deploymentUrl) assertDeploymentUrl(deploymentUrl, { allowProduction: true });

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
