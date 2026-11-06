import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const ignored = ["**/node_modules/**", "**/.next/**", "**/e2e/**"];

export const CRITICAL_COVERAGE = { lines: 95, branches: 90 } as const;

// Globs are relative to the package that re-exports this config.
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
          include: ["**/{src,test}/**/*.test.ts"],
          exclude: [...ignored, "**/*.{int,contract,browser}.test.*"],
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
            instances: [{ browser: "chromium" }],
          },
        },
      },
      {
        test: {
          name: "integration",
          include: ["**/{src,test}/**/*.int.test.ts"],
          exclude: ignored,
          pool: "forks",
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "contract",
          include: ["**/src/**/*.contract.test.ts"],
          exclude: ignored,
          retry: 1,
          testTimeout: 60_000,
        },
      },
    ],
  },
});
