import type { Cron } from "@reranker/telemetry/launch";

/**
 * The crons `vercel.json` registers, kept as code so the deployment can check them at runtime: a
 * JSON file outside `src` is not part of every function bundle. A test keeps both equal.
 */
export const CRONS: readonly Cron[] = [
  { path: "/api/cron/daily", schedule: "0 10 * * *" },
  { path: "/api/cron/evidence-hourly", schedule: "0 * * * *" },
];
