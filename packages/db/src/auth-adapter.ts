import { drizzle } from "drizzle-orm/node-postgres";
import { getPool } from "./client.ts";
import * as schema from "./schema/index.ts";

// Better Auth runs its own statements without a transaction wrapper, so it gets the system pool directly.
// Lint forbids importing this outside the auth package.
export const authDb = drizzle({ client: getPool("system"), schema, casing: "snake_case" });
