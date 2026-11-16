import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CURRENCIES } from "@reranker/i18n";
import { getTableConfig } from "drizzle-orm/pg-core";
import { expect, test } from "vitest";
import { costMicrosColumn, moneyColumns } from "../src/schema";
import { moneyProbe } from "./probe/money-probe.schema";

const migrations = fileURLToPath(new URL("../migrations", import.meta.url));

function readMigration(name: string): string {
  const file = readdirSync(migrations).find((entry) => entry.endsWith(`_${name}.sql`));
  if (!file) throw new Error(`No migration named ${name}`);
  return readFileSync(`${migrations}/${file}`, "utf8");
}

// The migration is frozen once merged, so this fails when a currency is added to CURRENCIES
// without a migration that widens the domain.
test("the currency domain lists exactly CURRENCIES", () => {
  const list = /value in \(([^)]*)\)/i.exec(readMigration("money_domains"))?.[1];
  const codes = [...(list ?? "").matchAll(/'([A-Z]{3})'/g)].map(([, code]) => code);
  expect(codes).toEqual(Object.keys(CURRENCIES));
});

test("the migration only creates domains, each guarded for a rerun", () => {
  const sql = readMigration("money_domains").toLowerCase();
  expect(sql).not.toMatch(/\b(alter|drop)\s+table\b/);
  expect(sql.match(/create domain/g)).toHaveLength(3);
  expect(sql.match(/duplicate_object/g)).toHaveLength(3);
});

test("column names derive from the prefix", () => {
  expect(Object.keys(moneyColumns("price"))).toEqual(["price_amount_minor", "price_currency"]);
  expect(Object.keys(costMicrosColumn("cost"))).toEqual(["cost_amount_micros", "cost_currency"]);
});

test("columns are not null and typed by their domains", () => {
  const columns = Object.fromEntries(getTableConfig(moneyProbe).columns.map((c) => [c.name, c]));
  expect(columns.price_amount_minor?.getSQLType()).toBe("amount_minor");
  expect(columns.price_currency?.getSQLType()).toBe("currency_code");
  expect(columns.cost_amount_micros?.getSQLType()).toBe("amount_micros");
  expect(columns.cost_currency?.getSQLType()).toBe("currency_code");
  for (const column of Object.values(columns).filter((c) => c.name.includes("_")))
    expect(column.notNull).toBe(true);
});

test("amounts map between driver strings and numbers", () => {
  const column = getTableConfig(moneyProbe).columns.find((c) => c.name === "price_amount_minor");
  expect(column?.mapFromDriverValue("14900000")).toBe(14_900_000);
  expect(column?.mapToDriverValue(14_900_000)).toBe(14_900_000);
});
