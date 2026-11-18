import { defineConfig, mergeConfig } from "vitest/config";
import root, { CRITICAL_COVERAGE } from "../../vitest.config.ts";

// Extracted mentions become the score customers read; a wrong parse is a wrong report.
// The database-backed store is exercised by the integration project, so the unit run leaves it out.
export default mergeConfig(
  root,
  defineConfig({
    test: { coverage: { thresholds: CRITICAL_COVERAGE, exclude: ["src/store.ts"] } },
  }),
);
