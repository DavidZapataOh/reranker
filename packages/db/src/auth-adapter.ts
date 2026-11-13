import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { systemPool } from "./client";
import * as authTables from "./schema/auth";

// Better Auth runs its own statements outside withSystem, so this handle skips the per-transaction
// settings; lint keeps the import inside packages/auth.
export const authDb: NodePgDatabase<typeof authTables> = drizzle({
  client: systemPool(),
  schema: authTables,
  casing: "snake_case",
});
