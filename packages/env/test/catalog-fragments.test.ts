import { expect, test } from "vitest";
import { fragments as webFragments } from "../../../apps/web/src/env";
import { authEnv } from "../../auth/src/env";
import { dbEnv } from "../../db/src/env";
import { inCatalog } from "../src/catalog";

// A variable added to a fragment must be declared in the catalog in the same change.
const declared = [...webFragments, dbEnv, authEnv].flatMap((fragment) =>
  Object.keys(fragment.shape),
);

test("every variable the fragments declare exists in the catalog", () => {
  const undeclared = [...new Set(declared)].filter((name) => !inCatalog(name));
  expect(undeclared).toEqual([]);
});
