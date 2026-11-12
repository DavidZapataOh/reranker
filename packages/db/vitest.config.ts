import { defineConfig, mergeConfig } from "vitest/config";
import root from "../../vitest.config.ts";

// Pool construction and the auth adapter only do something against a real database, where the
// integration project covers them.
export default mergeConfig(
  root,
  defineConfig({ test: { coverage: { exclude: ["src/client.ts", "src/auth-adapter.ts"] } } }),
);
