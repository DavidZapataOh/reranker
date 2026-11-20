import { defineConfig, mergeConfig, type TestProjectInlineConfiguration } from "vitest/config";
import root, { CRITICAL_COVERAGE } from "../../vitest.config.ts";

// The KMS contract test needs the AWS credentials that only the nightly `evidence-kms` job
// assumes through GitHub OIDC, so it runs as its own project instead of with the other contracts.
const KMS_TEST = "test/kms.contract.test.ts";

const projects = (root.test?.projects ?? []).flatMap((project) => {
  const config = project as TestProjectInlineConfiguration;
  if (typeof project !== "object" || config.test?.name !== "contract") return [project];
  return [
    { ...config, test: { ...config.test, exclude: [...(config.test.exclude ?? []), KMS_TEST] } },
    { ...config, test: { ...config.test, name: "kms", include: [KMS_TEST] } },
  ];
});

// A wrong signature or a key outside the registry would seal evidence nobody can verify.
// Sealing, log integration, publication, anchoring and bundles read or write Postgres and are
// exercised by the integration project, so the unit run leaves them out.
export default mergeConfig(
  { ...root, test: { ...root.test, projects } },
  defineConfig({
    test: {
      coverage: {
        thresholds: CRITICAL_COVERAGE,
        exclude: [
          "src/seal.ts",
          "src/announce.ts",
          "src/latency.ts",
          "src/jobs.ts",
          "src/log/integrate.ts",
          "src/log/tiles.ts",
          "src/anchors/anchor.ts",
          "src/bundle.ts",
          "src/bundle-latency.ts",
          "src/removal.ts",
        ],
      },
    },
  }),
);
