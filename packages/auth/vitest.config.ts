import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Every code sent takes from the current hour of the email brake, which the database branch
// shares with every test file and with whatever its parent branch already counted. The quota test
// sets its own limit.
const TEST_EMAIL_QUOTA = {
  QUOTA_RESEND_EMAILS_HOURLY_FLOOR: "100000",
};

const PURGE_TEST = "src/purge.int.test.ts";
const EXPIRY_TEST = "src/email-otp.int.test.ts";
const TELEMETRY_TEST = "src/telemetry.int.test.ts";
const HOUSE_TEST = "src/house.int.test.ts";

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
          exclude: [PURGE_TEST, EXPIRY_TEST, TELEMETRY_TEST, HOUSE_TEST],
        },
      },
      // Better Auth deletes every expired verification and idle rate-limit row on the requests it
      // serves, so the files that expire rows on purpose run alone, after the files that sign in.
      {
        test: {
          ...integration,
          name: "integration-expiry",
          include: [EXPIRY_TEST],
          sequence: { groupOrder: 1 },
        },
      },
      {
        test: {
          ...integration,
          name: "integration-purge",
          include: [PURGE_TEST],
          sequence: { groupOrder: 2 },
        },
      },
      // The sign-in velocity window is global, so the alert test runs after every file that signs in.
      {
        test: {
          ...integration,
          name: "integration-telemetry",
          include: [TELEMETRY_TEST],
          sequence: { groupOrder: 3 },
        },
      },
      // Only one house may exist per database. This file commits one and hides any house already
      // there, while other files insert one in a transaction they roll back, so it runs alone.
      {
        test: {
          ...integration,
          name: "integration-house",
          include: [HOUSE_TEST],
          sequence: { groupOrder: 4 },
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
