import { defineConfig, mergeConfig } from "vitest/config";
import root, { CRITICAL_COVERAGE } from "../../vitest.config.ts";

// Kill switches decide whether paid, legally sensitive capture runs at all.
export default mergeConfig(
  root,
  defineConfig({
    test: {
      // Tests without definitions wait out the 3 s cold-start grace before failing closed.
      testTimeout: 15_000,
      coverage: { thresholds: CRITICAL_COVERAGE, exclude: ["**/*.test-d.ts"] },
    },
  }),
);
