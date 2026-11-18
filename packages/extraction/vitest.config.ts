import { defineConfig, mergeConfig } from "vitest/config";
import root, { CRITICAL_COVERAGE } from "../../vitest.config.ts";

// Extracted mentions become the score customers read; a wrong parse is a wrong report.
export default mergeConfig(
  root,
  defineConfig({ test: { coverage: { thresholds: CRITICAL_COVERAGE } } }),
);
