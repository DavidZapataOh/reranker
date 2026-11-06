import pg from "pg";
import { getTestDatabaseUrl } from "../neon.ts";

const KINDS = ["app", "system", "migrations"] as const;

// Fails early naming the missing variable and wakes the Neon compute once for the whole run.
export default async function setup(): Promise<void> {
  const urls = KINDS.map((kind) => getTestDatabaseUrl(kind));
  for (const url of urls) {
    const client = new pg.Client(url);
    await client.connect();
    await client.end();
  }
}
