import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { emulateReducedMotion } from "./packages/testing/src/vitest/browser-commands.ts";

const ignored = ["**/node_modules/**", "**/.next/**", "**/e2e/**"];

// Schema, evidence and statistics errors reach customers silently, so those packages hold a
// stricter bar: their vitest.config.ts is
// `mergeConfig(root, { test: { coverage: { thresholds: CRITICAL_COVERAGE } } })`.
export const CRITICAL_COVERAGE = { lines: 95, branches: 90 } as const;

// Next's server compilers and the workflow bundler both swap `server-only` for its empty module, so
// Node test projects do the same and load server code the way production does. Browser projects
// keep the throwing entry, like a client bundle. The package exports only its throwing entry to
// Node, hence the sibling path.
export const serverOnlyAlias = {
  "server-only": join(dirname(createRequire(import.meta.url).resolve("server-only")), "empty.js"),
};

// Globs are relative to the package that re-exports this config.
export default defineConfig({
  test: {
    // Vitest's defaults plus the cause of every attempt a retry hid.
    reporters: [
      "default",
      ...(process.env.GITHUB_ACTIONS === "true" ? ["github-actions"] : []),
      fileURLToPath(new URL("./packages/testing/src/vitest/retry-reporter.ts", import.meta.url)),
    ],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["**/*.test.*", "**/*.d.ts"],
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "./coverage",
      thresholds: { lines: 80, branches: 75 },
    },
    projects: [
      {
        test: {
          name: "unit",
          alias: serverOnlyAlias,
          environment: "node",
          include: ["**/{src,test}/**/*.test.ts"],
          exclude: [...ignored, "**/*.{int,contract,measure,browser,workflow,perf,heavy}.test.*"],
        },
      },
      // CPU-heavy checks, such as sampler validation or every Merkle tree size, run without
      // coverage: instrumentation slows their hot loops 5-10× and adds nothing, since the unit
      // project already covers those lines.
      {
        test: {
          name: "heavy",
          alias: serverOnlyAlias,
          environment: "node",
          include: ["**/{src,test}/**/*.heavy.test.ts"],
          exclude: ignored,
          // Each one runs thousands of cases by design; the 5 s default is sized for a unit test
          // and fails them on a slower CI runner.
          testTimeout: 60_000,
        },
      },
      // Timing budgets run on their own: coverage instrumentation and sibling workers would
      // measure something other than the code that ships.
      {
        test: {
          name: "perf",
          alias: serverOnlyAlias,
          include: ["**/{src,test}/**/*.perf.test.ts"],
          exclude: ignored,
          fileParallelism: false,
        },
      },
      {
        plugins: [react()],
        test: {
          name: "component",
          include: ["**/src/**/*.browser.test.tsx"],
          exclude: ignored,
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            commands: { emulateReducedMotion },
            instances: [{ browser: "chromium" }],
          },
        },
      },
      {
        test: {
          name: "integration",
          alias: serverOnlyAlias,
          include: ["**/{src,test}/**/*.int.test.ts"],
          exclude: ignored,
          pool: "forks",
          globalSetup: [
            fileURLToPath(
              new URL("./packages/testing/src/vitest/integration-setup.ts", import.meta.url),
            ),
          ],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "contract",
          alias: serverOnlyAlias,
          include: ["**/{src,test}/**/*.contract.test.ts"],
          exclude: ignored,
          retry: 1,
          testTimeout: 60_000,
        },
      },
      // Rates measured on live providers, weekly. A retry would keep the run that happens to pass.
      {
        test: {
          name: "measure",
          alias: serverOnlyAlias,
          include: ["**/{src,test}/**/*.measure.test.ts"],
          exclude: ignored,
          testTimeout: 300_000,
        },
      },
    ],
  },
});
