import { costMicrosColumn, moneyColumns, tenantTable } from "../../src/schema";

// Test-only table: it exercises both money builders without adding a migration.
export const moneyProbe = tenantTable("money_probe", {
  ...moneyColumns("price"),
  ...costMicrosColumn("cost"),
});
