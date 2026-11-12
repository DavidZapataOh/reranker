import { defineConfig, mergeConfig } from "vitest/config";
import root from "../../vitest.config.ts";

// client.ts, tenancy.ts and auth-adapter.ts open real connections; the integration project
// covers them against a Neon branch, so unit coverage measures the pure modules only.
export default mergeConfig(
  root,
  defineConfig({
    test: {
      coverage: { exclude: ["src/client.ts", "src/auth-adapter.ts", "src/index.ts"] },
    },
  }),
);
