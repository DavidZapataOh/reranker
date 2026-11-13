import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// Some sandboxes hang on Chromium screenshots unless GPU rasterization is off; CI leaves this unset.
const chromiumArgs = process.env.PLAYWRIGHT_CHROMIUM_ARGS?.split(/\s+/).filter(Boolean);

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
        // Pre-bundling must share one React between the components and the renderer, or hooks see a null dispatcher.
        optimizeDeps: {
          include: [
            "react",
            "react/jsx-dev-runtime",
            "react-dom",
            "react-dom/client",
            "vitest-browser-react",
          ],
        },
        test: {
          name: "component",
          include: ["src/**/*.browser.test.tsx", "test/**/*.browser.test.tsx"],
          setupFiles: ["./test/browser-setup.ts"],
          browser: {
            enabled: true,
            provider: playwright(
              chromiumArgs?.length ? { launchOptions: { args: chromiumArgs } } : {},
            ),
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
