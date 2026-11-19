import { expect, test } from "vitest";

// Node test projects alias `server-only` to its empty module; a client bundle must still refuse it.
test("server-only throws when a client bundle imports it", async () => {
  await expect(import("server-only")).rejects.toThrow(
    "cannot be imported from a Client Component module",
  );
});
