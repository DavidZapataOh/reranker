import { defineConfig, mergeConfig } from "vitest/config";
import root, { CRITICAL_COVERAGE } from "../../vitest.config.ts";

// Tenant isolation lives here, so the package holds the stricter coverage bar.
export default mergeConfig(
  root,
  defineConfig({ test: { coverage: { thresholds: CRITICAL_COVERAGE } } }),
);
