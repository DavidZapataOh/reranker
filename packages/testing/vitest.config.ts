import { defineConfig, mergeConfig } from "vitest/config";
import root, { CRITICAL_COVERAGE } from "../../vitest.config.ts";

// Browser commands run inside the Vitest server, which coverage does not instrument; the Playwright fixtures only run under the e2e runner.
export default mergeConfig(
  root,
  defineConfig({
    test: {
      coverage: { thresholds: CRITICAL_COVERAGE, exclude: ["src/vitest/**", "src/playwright.ts"] },
    },
  }),
);
