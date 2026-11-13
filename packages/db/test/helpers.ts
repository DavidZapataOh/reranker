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
    drop: () => withAdmin(`drop database if exists ${name} with (force)`),
  };
}
