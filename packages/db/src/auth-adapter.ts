import { getDb } from "./client.ts";

// The auth library manages its own queries and transactions, so it gets the system pool without
// a tenant transaction. Lint forbids importing this subpath outside packages/auth.
export const authDb = getDb("system");
