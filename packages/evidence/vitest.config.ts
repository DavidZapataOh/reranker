import { defineConfig, mergeConfig } from "vitest/config";
import root, { CRITICAL_COVERAGE } from "../../vitest.config.ts";

// A wrong signature or a key outside the registry would seal evidence nobody can verify.
// Sealing writes in the caller's transaction and is exercised by the integration project, so the
// unit run leaves it out.
export default mergeConfig(
  root,
  defineConfig({ test: { coverage: { thresholds: CRITICAL_COVERAGE, exclude: ["src/seal.ts"] } } }),
);
