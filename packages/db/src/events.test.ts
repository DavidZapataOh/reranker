import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type DbEvent, emitDbEvent, setDbEventSink } from "./events.ts";

const exhausted: DbEvent = { name: "db_pool_exhausted", pool: "app" };

describe("emitDbEvent", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    setDbEventSink(null);
    vi.useRealTimers();
  });

  test("forwards rls violations and compute outages immediately", () => {
    const seen: DbEvent[] = [];
    setDbEventSink((event) => seen.push(event));
    emitDbEvent({ name: "db_rls_violation", pool: "app", pgCode: "42501" });
    emitDbEvent({ name: "db_compute_unavailable", pool: "system", pgCode: "57P03" });
    expect(seen).toEqual([
      { name: "db_rls_violation", pool: "app", pgCode: "42501" },
      { name: "db_compute_unavailable", pool: "system", pgCode: "57P03" },
    ]);
  });

  test("forwards pool exhaustion only after more than 5 occurrences within 10 minutes", () => {
    const seen: DbEvent[] = [];
    setDbEventSink((event) => seen.push(event));
    for (let i = 0; i < 5; i++) emitDbEvent(exhausted);
    expect(seen).toHaveLength(0);

    vi.advanceTimersByTime(9 * 60 * 1000);
    emitDbEvent(exhausted);
    expect(seen).toEqual([exhausted]);

    vi.advanceTimersByTime(10 * 60 * 1000);
    emitDbEvent(exhausted);
    expect(seen).toHaveLength(1);
  });

  test("never throws when the sink throws or is unset", () => {
    expect(() => emitDbEvent({ name: "db_rls_violation", pool: "app" })).not.toThrow();
    setDbEventSink(() => {
      throw new Error("sink down");
    });
    expect(() => emitDbEvent({ name: "db_rls_violation", pool: "app" })).not.toThrow();
  });
});
