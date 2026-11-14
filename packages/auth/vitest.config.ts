import { defineConfig } from "vitest/config";

// The shared config only picks up .ts tests, and the email tests render JSX.
export default defineConfig({
  test: {
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
          environment: "node",
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: ["**/*.{int,contract}.test.*"],
        },
      },
      {
        test: {
          name: "contract",
          include: ["src/**/*.contract.test.ts"],
          retry: 1,
          testTimeout: 60_000,
        },
      },
    ],
  },
});
