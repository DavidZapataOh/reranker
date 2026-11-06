import pg from "pg";
import { type DatabaseKind, getTestDatabaseUrl, VARIABLES } from "../neon.ts";

// Fails early naming the variable at fault and wakes the Neon compute once for the whole run.
export default async function setup(): Promise<void> {
  await Promise.all(
    (Object.keys(VARIABLES) as DatabaseKind[]).map(async (kind) => {
      // Bounded so an unreachable host fails here instead of hanging the run.
      const client = new pg.Client({
        connectionString: getTestDatabaseUrl(kind),
        connectionTimeoutMillis: 15_000,
      });
      try {
        await client.connect();
      } catch (cause) {
        throw new Error(`Cannot connect to ${VARIABLES[kind]}`, { cause });
      } finally {
        await client.end();
      }
    }),
  );
}
