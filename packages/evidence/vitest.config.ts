import { defineConfig, mergeConfig } from "vitest/config";
import root, { CRITICAL_COVERAGE } from "../../vitest.config.ts";

// A wrong signature or a key outside the registry would seal evidence nobody can verify.
// Sealing, log integration, publication and anchoring write to Postgres and are exercised by the
// integration project, so the unit run leaves them out.
export default mergeConfig(
  root,
  defineConfig({
    test: {
      coverage: {
        thresholds: CRITICAL_COVERAGE,
        exclude: [
          "src/seal.ts",
          "src/latency.ts",
          "src/jobs.ts",
          "src/log/integrate.ts",
          "src/log/tiles.ts",
          "src/anchors/anchor.ts",
        ],
      },
    },
  }),
);
