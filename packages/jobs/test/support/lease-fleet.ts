import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { WorkerJob, WorkerResult } from "./lease-worker";

const WORKER = fileURLToPath(new URL("./lease-worker.ts", import.meta.url));

/** Starts one fleet process; its pool has one connection more than it has lanes. */
export function startWorker(job: WorkerJob): ChildProcess {
  return fork(WORKER, [JSON.stringify(job)], {
    execArgv: ["--import", "tsx"],
    env: { ...process.env, DB_POOL_MAX: String(job.lanes + 1) },
  });
}

/** A fleet process that waits for `go()` once loaded, then runs its acquisitions. */
export function runWorker(job: WorkerJob): {
  ready: Promise<void>;
  go(): void;
  results: Promise<WorkerResult[]>;
} {
  const child = startWorker(job);
  const ready = new Promise<void>((resolve) => child.once("message", () => resolve()));
  const results = new Promise<WorkerResult[]>((resolve, reject) => {
    child.on("message", (m: { results?: WorkerResult[] }) => m.results && resolve(m.results));
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`worker exited with ${code}`)));
  });
  return { ready, go: () => child.send("go"), results };
}
