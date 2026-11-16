import { fileURLToPath } from "node:url";
import { workflow } from "@workflow/vitest";
import { defineConfig } from "vitest/config";

// Workflows run in-process on the local world; their steps reach the real database, so this
// project shares the integration setup that checks the connection strings first.
export default defineConfig({
  plugins: [workflow()],
  resolve: { tsconfigPaths: true },
  test: {
    name: "workflow",
    include: ["test/**/*.workflow.test.ts"],
    environment: "node",
    // The local world is a development runtime; telemetry reads APP_ENV to stay local.
    env: { APP_ENV: "development" },
    globalSetup: [
      fileURLToPath(
        new URL("../../packages/testing/src/vitest/integration-setup.ts", import.meta.url),
      ),
    ],
    testTimeout: 60_000,
    // The step bundle leaves `next` external, and Node's ESM resolver cannot load `next/server`
    // (next ships no exports map); Vite's module runner resolves it like Next's bundler does.
    server: { deps: { inline: [/@workflow\/vitest/] } },
  },
});
