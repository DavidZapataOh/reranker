import { describe, expect, test } from "vitest";
import { InvalidInputError } from "../src/errors";
import { createRegistry } from "../src/registry";

describe("createRegistry", () => {
  test("returns what was registered and nothing for an unknown key", () => {
    const registry = createRegistry<number>("thing");
    registry.register("a", 1);
    expect(registry.get("a")).toBe(1);
    expect(registry.get("b")).toBeUndefined();
    expect([...registry.keys()]).toEqual(["a"]);
  });

  test("registering the same value again is a no-op and a different one is rejected", () => {
    const registry = createRegistry<object>("thing");
    const first = {};
    registry.register("a", first);
    registry.register("a", first);
    expect(() => registry.register("a", {})).toThrow(InvalidInputError);
    expect(registry.get("a")).toBe(first);
  });
});
