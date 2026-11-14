import { defineConfig, mergeConfig } from "vitest/config";
import root, { CRITICAL_COVERAGE } from "../../vitest.config.ts";

export default mergeConfig(
  root,
  defineConfig({ test: { coverage: { thresholds: CRITICAL_COVERAGE } } }),
);
