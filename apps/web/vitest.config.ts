import { defineConfig } from "vitest/config";
import root from "../../vitest.config.ts";

const { include: _all, ...coverage } = root.test?.coverage ?? {};

// Next pages are covered by E2E, so unit coverage only counts files that tests load.
// mergeConfig would concatenate the root `include`, hence the explicit rebuild.
export default defineConfig({ ...root, test: { ...root.test, coverage } });
