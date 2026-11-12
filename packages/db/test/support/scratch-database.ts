import { randomUUID } from "node:crypto";
import { getTestDatabaseUrl } from "@reranker/testing/neon";
import pg from "pg";

export const ownerUrl = (): string => getTestDatabaseUrl("migrations");

export async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
  await client.connect();
  return client;
}

/** Runs fn against a fresh, empty database on the CI branch and drops it afterwards. */
export async function withScratchDatabase<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const name = `scratch_${randomUUID().replaceAll("-", "")}`;
  const admin = await connect(ownerUrl());
  try {
    await admin.query(`create database ${name}`);
    const url = new URL(ownerUrl());
    url.pathname = `/${name}`;
    return await fn(url.toString());
  } finally {
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
  }
}
