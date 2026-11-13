import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.ts"],
          exclude: ["**/*.browser.test.tsx"],
        },
      },
      {
        plugins: [tailwindcss()],
        test: {
          name: "component",
          include: ["src/**/*.browser.test.tsx", "test/**/*.browser.test.tsx"],
          setupFiles: ["./test/browser-setup.ts"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
