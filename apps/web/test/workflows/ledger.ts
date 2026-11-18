import { appendFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Steps run in the test process on the local world, so a file per run key is a ledger both the
// fixtures and the assertions can see without any shared infrastructure.
const DIR = join(tmpdir(), "reranker-workflow-tests");

/**
 * Each entry carries both clocks. Schedules are wall-clock instants, so "not before" is checked
 * on `at`. The wall clock can be stepped mid-run (NTP, a VM resyncing its clock), which reads as
 * seconds of delay that never happened, so "how late" is checked on `monotonicAt`.
 */
type Entry = { event: string; item?: string; attempt?: number; at: number; monotonicAt: number };

const fileOf = (runKey: string) => join(DIR, `${runKey}.jsonl`);

/** Epoch milliseconds from the monotonic clock, comparable across this process's threads. */
export const monotonicNow = () => performance.timeOrigin + performance.now();

export async function record(
  runKey: string,
  entry: Omit<Entry, "at" | "monotonicAt">,
): Promise<void> {
  await mkdir(DIR, { recursive: true });
  const line = { ...entry, at: Date.now(), monotonicAt: monotonicNow() };
  await appendFile(fileOf(runKey), `${JSON.stringify(line)}\n`);
}

export async function entriesOf(runKey: string, event?: string): Promise<Entry[]> {
  const raw = await readFile(fileOf(runKey), "utf8").catch(() => "");
  const entries = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Entry);
  return event === undefined ? entries : entries.filter((entry) => entry.event === event);
}

export const callCount = async (runKey: string) => (await entriesOf(runKey, "call")).length;
export const attemptsOf = async (runKey: string) => (await entriesOf(runKey, "attempt")).length;
