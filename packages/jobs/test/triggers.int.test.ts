import { randomUUID } from "node:crypto";
import { endPools, withSystem } from "@reranker/db";
import { type SQL, sql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";
import { providerVolume, spendCapPressure } from "../src/triggers";

afterAll(() => endPools());

const system = async (query: SQL) => withSystem("test.triggers", (tx) => tx.execute(query));

// A far-away month of its own, so other tests' rows and earlier runs never meet these.
const year = 3000 + Math.floor(Math.random() * 5000);
const month = `${year}-05`;

describe("spendCapPressure", () => {
  afterAll(() =>
    system(
      sql`delete from ops.spend_counters where day between ${`${month}-01`}::date and ${`${month}-31`}::date`,
    ),
  );

  test("reads the free report counters of the day and the two before", async () => {
    await system(sql`insert into ops.spend_counters
      (day, scope, cap_amount_micros, cap_currency, used_amount_micros, used_currency) values
      (${`${month}-10`}::date, 'purpose:free-report', 50000000, 'USD', 35000000, 'USD'),
      (${`${month}-11`}::date, 'purpose:free-report', 50000000, 'USD', 40000000, 'USD'),
      (${`${month}-12`}::date, 'purpose:free-report', 50000000, 'USD', 50000000, 'USD'),
      (${`${month}-12`}::date, 'global', 75000000, 'USD', 75000000, 'USD')`);
    await expect(spendCapPressure(`${month}-12`)).resolves.toEqual({
      days: [
        { day: `${month}-10`, ratio: 0.7 },
        { day: `${month}-11`, ratio: 0.8 },
        { day: `${month}-12`, ratio: 1 },
      ],
      fired: true,
    });
    expect((await spendCapPressure(`${month}-13`)).fired).toBe(false);
  });
});

describe("providerVolume", () => {
  afterAll(() => system(sql`delete from ops.spend_ledger where ref_id like ${`${month}:%`}`));

  async function ledger(day: string, status: string, refType: string, n: number) {
    await system(sql`insert into ops.spend_ledger
      (day, provider, purpose, scopes, ref_type, ref_id, reserved_amount_micros, reserved_currency,
       actual_currency, status)
      select ${day}::date, 'dataforseo', 'free-report', array['global'], ${refType},
             ${`${month}:${randomUUID()}`} || ':' || i, 1000, 'USD', 'USD', ${status}
        from generate_series(1, ${n}) i`);
  }

  test("counts the month's reservations that were not released, probes aside", async () => {
    await ledger(`${month}-01`, "settled", "free-report", 4);
    await ledger(`${month}-31`, "reserved", "free-report", 2);
    await ledger(`${month}-15`, "released", "free-report", 3);
    await ledger(`${month}-15`, "settled", "latency-probe", 5);
    await ledger(`${year}-06-01`, "settled", "free-report", 7);
    await expect(providerVolume(month)).resolves.toEqual({ calls: 6, fired: false });
  });
});
