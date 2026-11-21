import { defineConfig, mergeConfig } from "vitest/config";
import root, { CRITICAL_COVERAGE } from "../../vitest.config.ts";

// Captures are the evidence every report and verification rests on.
// Measurements and captures are stored in Postgres and sealed as evidence, so the integration
// project exercises them and the unit run leaves them out.
export default mergeConfig(
  root,
  defineConfig({
    test: {
      coverage: {
        thresholds: CRITICAL_COVERAGE,
        exclude: [
          "src/measurement.ts",
          "src/capture.ts",
          "src/persist.ts",
          "src/queue.ts",
          "src/answers.ts",
          "src/control/plan.ts",
        ],
      },
    },
  }),
);
