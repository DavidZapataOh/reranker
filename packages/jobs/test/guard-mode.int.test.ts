import { randomUUID } from "node:crypto";
import { endPools, withSystem } from "@reranker/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { InvalidInputError } from "../src/errors";
import { guardModeStatus, tripGuardMode } from "../src/guard-mode";

beforeAll(() => {
  process.env.DB_POOL_MAX = "20";
});
afterAll(() => endPools());

const name = (label: string) => `test-${label}-${randomUUID()}`;
const HALF_HOUR = 30 * 60_000;

// Moves the mode into the past instead of waiting, so the lazy release is observable.
async function shiftGuardMode(n: string, ms: number) {
  await withSystem("test.guard-mode", (tx) =>
    tx.execute(
      sql`update ops.guard_modes set active_until = active_until - ${ms} * interval '1 millisecond',
                 tripped_at = tripped_at - ${ms} * interval '1 millisecond' where name = ${n}`,
    ),
  );
}

describe("guard modes", () => {
  test("trip twice extends and only the first is newly tripped; release happens once", async () => {
    const n = name("verify");
    const a = await tripGuardMode(n, "spike", HALF_HOUR);
    const b = await tripGuardMode(n, "spike", HALF_HOUR);
    expect([a.newlyTripped, b.newlyTripped]).toEqual([true, false]);
    expect(b.activeUntil.getTime()).toBeGreaterThanOrEqual(a.activeUntil.getTime());
    expect(await guardModeStatus(n)).toMatchObject({
      active: true,
      reason: "spike",
      releasedNow: false,
    });

    await shiftGuardMode(n, 31 * 60_000);
    expect(await guardModeStatus(n)).toMatchObject({ active: false, releasedNow: true });
    expect(await guardModeStatus(n)).toMatchObject({ active: false, releasedNow: false });
  });

  test("tripping after a release is newly tripped again", async () => {
    const n = name("again");
    await tripGuardMode(n, "first", HALF_HOUR);
    await shiftGuardMode(n, 31 * 60_000);
    await guardModeStatus(n);
    const again = await tripGuardMode(n, "second", HALF_HOUR);
    expect(again.newlyTripped).toBe(true);
    expect(await guardModeStatus(n)).toMatchObject({
      active: true,
      reason: "second",
      releasedNow: false,
    });
  });

  test("tripping an expired mode that nobody read yet starts it again", async () => {
    const n = name("unread");
    await tripGuardMode(n, "first", HALF_HOUR);
    await shiftGuardMode(n, 31 * 60_000);
    expect((await tripGuardMode(n, "second", HALF_HOUR)).newlyTripped).toBe(true);
  });

  test("a shorter hold never shortens an active mode", async () => {
    const n = name("longer");
    const long = await tripGuardMode(n, "spike", HALF_HOUR);
    const short = await tripGuardMode(n, "spike", 1_000);
    expect(short.activeUntil.getTime()).toBe(long.activeUntil.getTime());
  });

  test("a name never tripped is off", async () => {
    expect(await guardModeStatus(name("none"))).toEqual({
      active: false,
      activeUntil: null,
      reason: null,
      releasedNow: false,
    });
  });

  test("concurrent trips produce exactly one newly tripped", async () => {
    const n = name("race");
    const results = await Promise.all(
      Array.from({ length: 10 }, () => tripGuardMode(n, "spike", HALF_HOUR)),
    );
    expect(results.filter((r) => r.newlyTripped)).toHaveLength(1);
  });

  test("concurrent reads after expiry release exactly once", async () => {
    const n = name("release-race");
    await tripGuardMode(n, "spike", HALF_HOUR);
    await shiftGuardMode(n, 31 * 60_000);
    const results = await Promise.all(Array.from({ length: 10 }, () => guardModeStatus(n)));
    expect(results.filter((r) => r.releasedNow)).toHaveLength(1);
  });

  test("rejects a bad name, reason or hold", async () => {
    await expect(tripGuardMode("", "spike", 1_000)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(tripGuardMode(name("r"), "  ", 1_000)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(tripGuardMode(name("h"), "spike", 0)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(tripGuardMode(name("h"), "spike", 1.5)).rejects.toBeInstanceOf(InvalidInputError);
    await expect(tripGuardMode(name("h"), "spike", 2 ** 31)).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(guardModeStatus("bad name!")).rejects.toBeInstanceOf(InvalidInputError);
  });
});
