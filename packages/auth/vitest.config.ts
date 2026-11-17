import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Every code sent takes from today's critical email quota, which the database branch shares with
// every test file and with whatever its parent branch already counted today. The quota test sets
// its own allocation.
const TEST_EMAIL_QUOTA = {
  QUOTA_RESEND_EMAILS_DAILY: "100070",
  QUOTA_RESEND_EMAILS_SPLIT: "100000/16/50/4",
};

const PURGE_TEST = "src/purge.int.test.ts";

const integration = {
  pool: "forks" as const,
  globalSetup: [
    fileURLToPath(new URL("../testing/src/vitest/integration-setup.ts", import.meta.url)),
  ],
  testTimeout: 30_000,
  env: TEST_EMAIL_QUOTA,
};

// The shared config only picks up .ts tests, and the email tests render JSX.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["**/*.test.*", "**/*.d.ts", "**/*.conf"],
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "./coverage",
      thresholds: { lines: 80, branches: 75 },
    },
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["{src,scripts,test}/**/*.test.{ts,tsx}"],
          exclude: ["**/*.{int,contract}.test.*"],
        },
      },
      {
        test: {
          ...integration,
          name: "integration",
          include: ["src/**/*.int.test.ts"],
          exclude: [PURGE_TEST],
        },
      },
      // Better Auth deletes every expired verification and idle rate-limit row on the requests it
      // serves, so the purge test runs alone, after the files that sign in.
      {
        test: {
          ...integration,
          name: "integration-purge",
          include: [PURGE_TEST],
          sequence: { groupOrder: 1 },
        },
      },
      {
        test: {
          name: "contract",
          include: ["src/**/*.contract.test.ts"],
          retry: 1,
          testTimeout: 60_000,
          env: TEST_EMAIL_QUOTA,
        },
      },
    ],
  },
});
