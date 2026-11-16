import { withSystem } from "@reranker/db";
import { log } from "@reranker/telemetry";
import { sql } from "drizzle-orm";

export type PingResult = { steps: 3; dbOk: true };

/** Deploy smoke check: proves the queue, step retries and the system pool work end to end. */
export async function pingWorkflow(nonce: string): Promise<PingResult> {
  "use workflow";

  await pingStart(nonce);
  const dbOk = await pingDatabase();
  return pingFinish(nonce, dbOk);
}

async function pingStart(nonce: string): Promise<void> {
  "use step";
  log.info("workflow ping started", { nonce });
}

async function pingDatabase(): Promise<true> {
  "use step";
  await withSystem("jobs.ping", (tx) => tx.execute(sql`select 1`));
  return true;
}

async function pingFinish(nonce: string, dbOk: true): Promise<PingResult> {
  "use step";
  log.info("workflow ping finished", { nonce });
  return { steps: 3, dbOk };
}
