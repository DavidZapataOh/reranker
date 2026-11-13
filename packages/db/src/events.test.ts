import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { toDbError } from "./errors";
import {
  type DbEvent,
  dbPoolHitCountForTest,
  emitDbEvent,
  resetDbEventsForTest,
  setDbEventSink,
} from "./events";

const exhausted = () =>
  toDbError(new Error("timeout exceeded when trying to connect"), { pool: "app" });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  resetDbEventsForTest();
});

test("db_pool_exhausted reaches the sink only after more than 5 occurrences within 10 minutes", () => {
  const sink = vi.fn<(e: DbEvent) => void>();
  setDbEventSink(sink);
  for (let i = 0; i < 5; i++) exhausted();
  expect(sink).not.toHaveBeenCalled();
  exhausted();
  expect(sink).toHaveBeenCalledTimes(1);

  vi.advanceTimersByTime(10 * 60 * 1000);
  for (let i = 0; i < 5; i++) exhausted();
  expect(sink).toHaveBeenCalledTimes(1);
  exhausted();
  expect(sink).toHaveBeenCalledTimes(2);
});

test("a long storm keeps the hit log bounded", () => {
  setDbEventSink(() => {});
  for (let i = 0; i < 1000; i++) exhausted();
  expect(dbPoolHitCountForTest()).toBeLessThanOrEqual(6);
});

test("emitDbEvent never throws when the sink throws or is unset", () => {
  const event: DbEvent = { name: "db_rls_violation", pool: "app" };
  expect(() => emitDbEvent(event)).not.toThrow();
  setDbEventSink(() => {
    throw new Error("sink down");
  });
  expect(() => emitDbEvent(event)).not.toThrow();
});
