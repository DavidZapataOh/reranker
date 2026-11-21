import { defineConfig, mergeConfig } from "vitest/config";
import root, { CRITICAL_COVERAGE } from "../../vitest.config.ts";

// Content hashes and ids seal every measured question set; a silent change breaks every proof.
// Resolving a set reads and writes Postgres, so the integration project exercises it instead.
export default mergeConfig(
  root,
  defineConfig({
    test: { coverage: { thresholds: CRITICAL_COVERAGE, exclude: ["src/intent-sets.ts"] } },
  }),
);
