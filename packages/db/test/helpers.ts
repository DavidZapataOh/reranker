import { randomBytes } from "node:crypto";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import pg from "pg";

export type ScratchDatabase = { name: string; url: string; drop: () => Promise<void> };

// Databases are disposable; the cluster-wide roles they depend on are never dropped.
export async function createScratchDatabase(prefix: string): Promise<ScratchDatabase> {
  const ownerUrl = getTestDatabaseUrl("migrations");
  const name = `${prefix}_${randomBytes(6).toString("hex")}`;
  const withAdmin = async (sql: string) => {
    const admin = new pg.Client({ connectionString: ownerUrl });
    await admin.connect();
    try {
      await admin.query(sql);
    } finally {
      await admin.end();
    }
  };
  await withAdmin(`create database ${name}`);
  const url = new URL(ownerUrl);
  url.pathname = `/${name}`;
  return {
    name,
    url: url.toString(),
    drop: () => dropWithRetry(() => withAdmin(`drop database if exists ${name} with (force)`)),
  };
}

// A compute that has just woken up connects to every database as a superuser for its own
// maintenance, and FORCE cannot terminate those sessions; they end within seconds.
async function dropWithRetry(drop: () => Promise<void>, attempts = 15): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await drop();
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (attempt >= attempts || (code !== "42501" && code !== "55006")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}
