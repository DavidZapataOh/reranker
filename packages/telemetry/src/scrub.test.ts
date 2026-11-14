import { BANNED_PROPERTY_KEYS } from "@reranker/analytics";
import { resetAppEnv } from "@reranker/env";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FORBIDDEN_KEYS, scrub, scrubEvent } from "./scrub";

afterEach(() => {
  vi.unstubAllEnvs();
  resetAppEnv();
});

describe("scrub", () => {
  test("re-exports the analytics deny list", () => {
    expect(FORBIDDEN_KEYS).toBe(BANNED_PROPERTY_KEYS);
  });

  test("redacts emails and Colombian phones in strings", () => {
    expect(scrub("write ana@x.co or +57 310 555 1234")).toBe("write [redacted] or [redacted]");
    expect(scrub("3105551234")).toBe("[redacted]");
    expect(scrub("310-555-1234")).toBe("[redacted]");
    expect(scrub("573105551234")).toBe("[redacted]");
  });

  test.each([
    ["+52 55 1234 5678"],
    ["+34 612 345 678"],
    ["+1 (415) 555-2671"],
    ["+1-415-555-2671"],
    ["+14155552671"],
  ])("redacts the international phone %s", (phone) => {
    expect(scrub(`call ${phone}.`)).toBe("call [redacted].");
  });

  test("keeps long ids and numbers that are not phones", () => {
    const id = "0b6f2d3c-3105-4551-9234-1f0a5c3d9e7b";
    expect(scrub({ report_id: id, n: 12345 })).toEqual({ report_id: id, n: 12345 });
    expect(scrub("version 1.2.3 build 20261114")).toBe("version 1.2.3 build 20261114");
  });

  test("redacts forbidden keys at any depth", () => {
    expect(scrub({ a: [{ business_name: "Panadería", ok: 1 }] })).toEqual({
      a: [{ business_name: "[redacted]", ok: 1 }],
    });
    expect(scrub({ x: { y: { Email: "z", $ip: "1.2.3.4" } } })).toEqual({
      x: { y: { Email: "[redacted]", $ip: "[redacted]" } },
    });
  });

  test("redacts every banned key", () => {
    const input = Object.fromEntries(FORBIDDEN_KEYS.map((key) => [key, "v"]));
    expect(Object.values(scrub(input)).every((v) => v === "[redacted]")).toBe(true);
  });

  test("redacts inside Error message, stack and cause", () => {
    const e = new Error("fail for ana@x.co", { cause: new Error("phone 3105551234") });
    const s = scrub(e);
    expect(s).toBeInstanceOf(Error);
    expect(s.message).not.toMatch(/ana@x\.co/);
    expect(s.stack).not.toMatch(/ana@x\.co/);
    expect(String((s.cause as Error).message)).not.toMatch(/3105551234/);
    expect((s.cause as Error).stack).not.toMatch(/3105551234/);
  });

  test("redacts personal data nested in a cause chain, arrays and non-Error causes", () => {
    const e = new Error("outer", {
      cause: new Error("middle", {
        cause: { list: ["a@b.co", { phone: "x" }], note: "+57 300 111 2222" },
      }),
    });
    const s = scrub(e);
    const leaf = ((s.cause as Error).cause ?? {}) as { list: unknown[]; note: string };
    expect(leaf.list).toEqual(["[redacted]", { phone: "[redacted]" }]);
    expect(leaf.note).toBe("[redacted]");
  });

  test("keeps the class, name and extra fields of an error", () => {
    class PgError extends Error {
      code = "23505";
    }
    const s = scrub(new PgError("dup for ana@x.co"));
    expect(s).toBeInstanceOf(PgError);
    expect(s.name).toBe("Error");
    expect((s as PgError).code).toBe("23505");
  });

  test("scrubs the errors of an AggregateError", () => {
    const s = scrub(new AggregateError([new Error("a@b.co")], "many"));
    expect(String(s.errors[0])).not.toMatch(/a@b\.co/);
  });

  test("scrubs Map and Set contents", () => {
    const s = scrub({ m: new Map([["k", "a@b.co"]]), s: new Set(["3105551234"]) });
    expect([...s.m.values()]).toEqual(["[redacted]"]);
    expect([...s.s]).toEqual(["[redacted]"]);
  });

  test("survives cycles", () => {
    const o: Record<string, unknown> = { email: "a@b.co", note: "c@d.co" };
    o.self = o;
    const e = new Error("x@y.co");
    e.cause = e;
    expect(() => scrub(o)).not.toThrow();
    expect(() => scrub(e)).not.toThrow();
    const s = scrub(o);
    expect(s.email).toBe("[redacted]");
    expect(s.self).toBe("[circular]");
  });

  test("copies shared references that are not cycles", () => {
    const shared = { note: "a@b.co" };
    expect(scrub({ a: shared, b: shared })).toEqual({
      a: { note: "[redacted]" },
      b: { note: "[redacted]" },
    });
  });

  test("keeps tenant_id, report_id, request_id, primitives and dates", () => {
    expect(scrub({ tenant_id: "t", report_id: "r", request_id: "q" })).toEqual({
      tenant_id: "t",
      report_id: "r",
      request_id: "q",
    });
    const when = new Date(0);
    expect(scrub({ n: 1, b: true, z: null, u: undefined, when })).toEqual({
      n: 1,
      b: true,
      z: null,
      u: undefined,
      when,
    });
  });

  test("does not mutate its input", () => {
    const input = { business_name: "x", nested: [{ email: "a@b.co" }] };
    scrub(input);
    expect(input).toEqual({ business_name: "x", nested: [{ email: "a@b.co" }] });
  });

  test("stops at a depth limit instead of overflowing the stack", () => {
    let deep: Record<string, unknown> = { leaf: "a@b.co" };
    for (let i = 0; i < 500; i++) deep = { deep };
    expect(() => scrub(deep)).not.toThrow();
  });
});

describe("scrubEvent", () => {
  test("drops $ip, disables geoip and tags the environment", () => {
    vi.stubEnv("APP_ENV", "production");
    expect(scrubEvent({ event: "x", properties: { $ip: "1.2.3.4" } })?.properties).toEqual({
      $geoip_disable: true,
      app_env: "production",
    });
  });

  test("scrubs properties and the distinct id", () => {
    vi.stubEnv("APP_ENV", "preview");
    const out = scrubEvent({
      distinctId: "ana@x.co",
      event: "$exception",
      properties: {
        $exception_list: [{ type: "Error", value: "boom for 3105551234" }],
        email: "a@b.co",
      },
    });
    expect(out?.distinctId).toBe("[redacted]");
    expect(out?.properties).toMatchObject({
      $exception_list: [{ type: "Error", value: "boom for [redacted]" }],
      email: "[redacted]",
    });
  });

  test("keeps events without properties", () => {
    vi.stubEnv("APP_ENV", "development");
    expect(scrubEvent({ event: "x" })?.properties).toEqual({
      $geoip_disable: true,
      app_env: "development",
    });
  });
});
