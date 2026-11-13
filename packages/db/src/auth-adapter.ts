import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { systemPool } from "./client";
import * as authTables from "./schema/auth";

let instance: NodePgDatabase<typeof authTables> | undefined;

function database(): NodePgDatabase<typeof authTables> {
  instance ??= drizzle({ client: systemPool(), schema: authTables, casing: "snake_case" });
  return instance;
}

// Better Auth runs its own statements outside withSystem, so this handle skips the per-transaction
// settings; lint keeps the import inside packages/auth. Built on first use so importing the module
// (e.g. while the auth config loads at build time) needs no database environment.
export const authDb = new Proxy({} as NodePgDatabase<typeof authTables>, {
  get(_, property) {
    const db = database();
    const value = Reflect.get(db, property, db);
    return typeof value === "function" ? value.bind(db) : value;
  },
  has: (_, property) => Reflect.has(database(), property),
});
