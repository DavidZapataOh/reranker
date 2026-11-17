import { withSystem } from "@reranker/db";
import { sql } from "drizzle-orm";
import { InvalidInputError, JobAttemptsExhaustedError, NotFoundError } from "./errors";
import { assertOpaqueKey } from "./keys";
import type { JobPriority, PaidProvider } from "./providers";
import { createRegistry } from "./registry";
import { startOnce } from "./start-once";

export interface JobContext {
  attempt: number;
  jobId: string;
  /** Aborts when the job's time is up; pass it to every call the handler makes. */
  signal: AbortSignal;
}

export interface JobDefinition<P> {
  name: string;
  handler: (payload: P, ctx: JobContext) => Promise<void>;
  maxAttempts?: number;
  provider?: PaidProvider;
  timeoutMs?: number;
}

export type JobStarter = (input: {
  name: string;
  payload: unknown;
  runAt: string | null;
  jobId: string;
}) => Promise<{ runId: string }>;

// The run step allows nine retries, so a job can ask for up to ten attempts.
const DEFAULT_MAX_ATTEMPTS = 4;
const MAX_ATTEMPTS = 10;
// A step ends within 150 s; the rest of the budget records the outcome.
const MAX_TIMEOUT_MS = 140_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_INTERVAL_MS = 2 ** 31 - 1;
// No colon: the job id is `${name}:${dedupeKey}` and must split back unambiguously.
const NAME = /^[a-z][a-z0-9._-]{0,63}$/i;
const PRIORITIES: readonly JobPriority[] = ["critical", "high", "normal", "low"];
// Next.js compiles instrumentation and each route into separate module graphs, so the starter
// lives on the process, where every copy of this module finds the one registered at startup.
const STARTER = Symbol.for("@reranker/jobs/starter");

const jobs = createRegistry<JobDefinition<unknown>>("job");
const opportunistic = createRegistry<{ job: JobDefinition<void>; minIntervalMs: number }>(
  "opportunistic job",
);

function assertName(name: string, what: string): void {
  if (!NAME.test(name)) throw new InvalidInputError(`${what} name must be a short token`);
}

const isWhole = (value: number, min: number, max: number) =>
  Number.isInteger(value) && value >= min && value <= max;

/** Registers a single job; the module that owns it calls this at import. */
export function defineJob<P>(def: JobDefinition<P>): JobDefinition<P> {
  assertName(def.name, "Job");
  if (def.maxAttempts !== undefined && !isWhole(def.maxAttempts, 1, MAX_ATTEMPTS)) {
    throw new InvalidInputError(`maxAttempts must be between 1 and ${MAX_ATTEMPTS}`);
  }
  if (def.timeoutMs !== undefined && !isWhole(def.timeoutMs, 1, MAX_TIMEOUT_MS)) {
    throw new InvalidInputError(`timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
  }
  jobs.register(def.name, def as JobDefinition<unknown>);
  return def;
}

export function registerJobStarter(start: JobStarter): void {
  Reflect.set(globalThis, STARTER, start);
}

function starter(): JobStarter {
  const start: JobStarter | undefined = Reflect.get(globalThis, STARTER);
  if (!start) throw new Error("No job starter is registered; register one at server startup");
  return start;
}

function assertDefined(job: JobDefinition<unknown>): void {
  if (jobs.get(job.name) !== job) {
    throw new InvalidInputError(`Job ${job.name} was not created with defineJob`);
  }
}

// JSON values and dates only: IDs, keys and summaries, which any workflow runtime carries unchanged.
function assertPlainData(value: unknown, path: unknown[] = []): void {
  if (value === null || value === undefined) return;
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (Number.isFinite(value)) return;
      break;
    case "object": {
      if (path.includes(value)) break;
      const proto = Object.getPrototypeOf(value);
      if (value instanceof Date) return;
      if (Array.isArray(value) || proto === Object.prototype || proto === null) {
        for (const item of Object.values(value)) assertPlainData(item, [...path, value]);
        return;
      }
      break;
    }
  }
  throw new InvalidInputError("Job payload must be plain JSON data");
}

function assertPayload(payload: unknown): void {
  assertPlainData(payload);
  const bytes = Buffer.byteLength(JSON.stringify(payload) ?? "");
  if (bytes >= MAX_PAYLOAD_BYTES) {
    throw new InvalidInputError("Job payload must be under 64 KB; pass IDs, not documents");
  }
}

/**
 * Starts the job once per dedupe key: the same key returns the same job, however many callers
 * enqueue it at once. `runAt` is a durable sleep inside the run. Workflows have no queue priority,
 * so `priority` is only checked here; quotas and providers take it from the handler.
 */
export async function enqueue<P>(
  job: JobDefinition<P>,
  payload: P,
  opts: { dedupeKey: string; runAt?: Date; priority?: JobPriority },
): Promise<{ jobId: string; created: boolean }> {
  assertDefined(job as JobDefinition<unknown>);
  assertOpaqueKey(opts.dedupeKey, "Dedupe key");
  if (opts.runAt !== undefined && Number.isNaN(opts.runAt.getTime())) {
    throw new InvalidInputError("runAt must be a valid date");
  }
  if (opts.priority !== undefined && !PRIORITIES.includes(opts.priority)) {
    throw new InvalidInputError(`Unknown priority ${opts.priority}`);
  }
  assertPayload(payload);
  const start = starter();
  const jobId = `${job.name}:${opts.dedupeKey}`;
  const runAt = opts.runAt?.toISOString() ?? null;
  const { created } = await startOnce("job", jobId, () =>
    start({ name: job.name, payload, runAt, jobId }),
  );
  return { jobId, created };
}

function timeout(signal: AbortSignal): { expired: Promise<never>; clear: () => void } {
  let onAbort: () => void = () => undefined;
  const expired = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return { expired, clear: () => signal.removeEventListener("abort", onAbort) };
}

/**
 * Runs one attempt of a job inside its step. A failure before the last attempt is rethrown as is,
 * so the step's retry rules apply; on the last attempt the job ends for good.
 */
export async function runJob(
  name: string,
  payload: unknown,
  attempt: number,
  jobId: string,
): Promise<void> {
  const job = jobs.get(name);
  if (!job) throw new NotFoundError(`Job ${name} is not defined in this deployment`);
  const maxAttempts = job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (attempt > maxAttempts) throw new JobAttemptsExhaustedError(name, maxAttempts);

  const signal = AbortSignal.timeout(job.timeoutMs ?? MAX_TIMEOUT_MS);
  const { expired, clear } = timeout(signal);
  try {
    await Promise.race([job.handler(payload, { attempt, jobId, signal }), expired]);
  } catch (error) {
    if (attempt >= maxAttempts) throw new JobAttemptsExhaustedError(name, attempt, error);
    throw error;
  } finally {
    clear();
  }
}

/**
 * Work that should run "whenever jobs run" but at most once per interval across every instance,
 * since nothing polls: each job run offers it a turn after its own work.
 */
export function registerOpportunistic(
  name: string,
  job: JobDefinition<void>,
  opts: { minIntervalMs: number },
): void {
  assertName(name, "Opportunistic job");
  assertDefined(job as JobDefinition<unknown>);
  if (!isWhole(opts.minIntervalMs, 1, MAX_INTERVAL_MS)) {
    throw new InvalidInputError("minIntervalMs must be a positive whole number of milliseconds");
  }
  opportunistic.register(name, { job, minIntervalMs: opts.minIntervalMs });
}

/** Claims every opportunistic job whose interval has passed and enqueues those this call won. */
export async function runOpportunistic(): Promise<string[]> {
  const entries = [...opportunistic.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  if (entries.length === 0) return [];
  const names = entries.map(([name]) => name);
  const intervals = entries.map(([, entry]) => entry.minIntervalMs);
  // One statement claims them all; a concurrent claim waits on the row and then sees it fresh.
  const { rows } = await withSystem("jobs.opportunistic", (tx) =>
    tx.execute<{ name: string; last_run_at: Date | string }>(sql`
      with due (name, interval_ms) as (
        select * from unnest(${sql.param(names)}::text[], ${sql.param(intervals)}::int[])
      )
      insert into ops.opportunistic_runs as o (name, last_run_at)
      select name, now() from due order by name
      on conflict (name) do update set last_run_at = excluded.last_run_at
       where o.last_run_at <= excluded.last_run_at
             - (select make_interval(secs => d.interval_ms / 1000.0) from due d where d.name = o.name)
      returning o.name, o.last_run_at`),
  );
  const claimed = new Map(rows.map((row) => [row.name, new Date(row.last_run_at).getTime()]));
  const won: string[] = [];
  for (const [name, { job }] of entries) {
    const claimedAt = claimed.get(name);
    if (claimedAt === undefined) continue;
    // The claim instant keys the run, so the same turn is never started twice.
    await enqueue(job, undefined, { dedupeKey: `${name}-${claimedAt}` });
    won.push(name);
  }
  return won;
}
