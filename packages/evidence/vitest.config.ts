import { defineConfig, mergeConfig } from "vitest/config";
import root, { CRITICAL_COVERAGE } from "../../vitest.config.ts";

// A wrong signature or a key outside the registry would seal evidence nobody can verify.
export default mergeConfig(
  root,
  defineConfig({ test: { coverage: { thresholds: CRITICAL_COVERAGE } } }),
);
