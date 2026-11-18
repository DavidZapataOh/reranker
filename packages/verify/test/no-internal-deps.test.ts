import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// Third parties install and audit this package on its own, so it must not pull in the monorepo.
test("package has no internal dependencies", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.peerDependencies };
  expect(Object.keys(deps).filter((d) => d.startsWith("@reranker/"))).toEqual([]);
  expect(Object.values(deps).filter((v) => String(v).startsWith("workspace:"))).toEqual([]);
  expect(pkg.license).toBe("Apache-2.0");
});
