import { expect, it } from "vitest";
import { newTenantSeed } from "./factories.ts";

it("creates distinct v4 UUIDs and applies overrides", () => {
  const a = newTenantSeed();
  const b = newTenantSeed({ name: "Acme" });
  expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(a.id).not.toBe(b.id);
  expect(b.name).toBe("Acme");
  expect(a.slug).toContain(a.id.slice(0, 8));
});
