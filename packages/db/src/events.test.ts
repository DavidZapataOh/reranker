import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type DbEvent, emitDbEvent, setDbEventSink } from "./events.ts";

const exhausted: DbEvent = { name: "db_pool_exhausted", pool: "app" };

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  setDbEventSink(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("other events reach the sink immediately", () => {
  const sink = vi.fn();
  setDbEventSink(sink);
  emitDbEvent({ name: "db_rls_violation", pool: "app", pgCode: "42501" });
  expect(sink).toHaveBeenCalledExactlyOnceWith({
    name: "db_rls_violation",
    pool: "app",
    pgCode: "42501",
  });
});

test("db_pool_exhausted reaches the sink only after more than 5 occurrences within 10 minutes", () => {
  const sink = vi.fn();
  setDbEventSink(sink);
  for (let i = 0; i < 5; i++) emitDbEvent(exhausted);
  expect(sink).not.toHaveBeenCalled();
  emitDbEvent(exhausted);
  expect(sink).toHaveBeenCalledTimes(1);

  vi.advanceTimersByTime(10 * 60 * 1000);
  for (let i = 0; i < 5; i++) emitDbEvent(exhausted);
  expect(sink).toHaveBeenCalledTimes(1);
});

test("occurrences spread over more than 10 minutes never alert", () => {
  const sink = vi.fn();
  setDbEventSink(sink);
  for (let i = 0; i < 20; i++) {
    emitDbEvent(exhausted);
    vi.advanceTimersByTime(2 * 60 * 1000 + 1);
  }
  expect(sink).not.toHaveBeenCalled();
});

test("emitDbEvent never throws when the sink throws or is unset", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(() => emitDbEvent({ name: "db_compute_unavailable", pool: "system" })).not.toThrow();
  setDbEventSink(() => {
    throw new Error("sink down");
  });
  expect(() => emitDbEvent({ name: "db_compute_unavailable", pool: "system" })).not.toThrow();
  expect(log).toHaveBeenCalledOnce();
});
