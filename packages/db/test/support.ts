import { getTestDatabaseUrl } from "@reranker/testing/neon";
import pg from "pg";

export type Role = "app" | "system" | "migrations";

export async function connect(role: Role): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: getTestDatabaseUrl(role) });
  await client.connect();
  return client;
}

export async function withClient<T>(role: Role, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = await connect(role);
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// Runs fn inside a transaction that is always rolled back, so catalog probes leave nothing behind.
export function inRolledBackTx<T>(role: Role, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  return withClient(role, async (client) => {
    await client.query("begin");
    try {
      return await fn(client);
    } finally {
      await client.query("rollback");
    }
  });
}

export async function rejectionCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  throw new Error("expected the query to fail");
}

export const uniqueSuffix = () => `${Date.now().toString(36)}${process.pid.toString(36)}`;
