import { afterEach, expect, test, vi } from "vitest";
import { type DbEvent, emitDbEvent, setDbEventSink } from "./events.ts";

afterEach(() => {
  setDbEventSink(null);
  vi.useRealTimers();
});

const exhausted: DbEvent = { name: "db_pool_exhausted", pool: "app" };

test("forwards rls violations and compute outages to the sink right away", () => {
  const sink = vi.fn();
  setDbEventSink(sink);
  const violation: DbEvent = { name: "db_rls_violation", pool: "app", pgCode: "42501" };
  const outage: DbEvent = { name: "db_compute_unavailable", pool: "system", pgCode: "57P03" };
  emitDbEvent(violation);
  emitDbEvent(outage);
  expect(sink.mock.calls).toEqual([[violation], [outage]]);
});

test("db_pool_exhausted reaches the sink only past 5 occurrences within 10 minutes", () => {
  vi.useFakeTimers();
  const sink = vi.fn();
  setDbEventSink(sink);
  for (let i = 0; i < 5; i++) emitDbEvent(exhausted);
  expect(sink).not.toHaveBeenCalled();
  vi.advanceTimersByTime(9 * 60_000);
  emitDbEvent(exhausted);
  expect(sink).toHaveBeenCalledTimes(1);

  // Ten minutes after the first five, only the sixth is still inside the window.
  vi.advanceTimersByTime(60_001);
  emitDbEvent(exhausted);
  expect(sink).toHaveBeenCalledTimes(1);
});

test("never throws when the sink throws or is unset", () => {
  expect(() => emitDbEvent({ name: "db_rls_violation", pool: "app" })).not.toThrow();
  setDbEventSink(() => {
    throw new Error("sink down");
  });
  expect(() => emitDbEvent({ name: "db_rls_violation", pool: "app" })).not.toThrow();
});
