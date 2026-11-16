import { defineConfig, mergeConfig } from "vitest/config";
import root, { CRITICAL_COVERAGE } from "../../vitest.config.ts";

// Spend caps and retry mapping decide what real money is spent and retried.
// Database-backed modules are exercised by the integration project, so the unit run leaves them out.
export default mergeConfig(
  root,
  defineConfig({
    test: { coverage: { thresholds: CRITICAL_COVERAGE, exclude: ["src/start-once.ts"] } },
  }),
);
