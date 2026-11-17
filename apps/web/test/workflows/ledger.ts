import { appendFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Steps run in the test process on the local world, so a file per run key is a ledger both the
// fixtures and the assertions can see without any shared infrastructure.
const DIR = join(tmpdir(), "reranker-workflow-tests");

type Entry = { event: string; item?: string; attempt?: number; at: number };

const fileOf = (runKey: string) => join(DIR, `${runKey}.jsonl`);

export async function record(runKey: string, entry: Omit<Entry, "at">): Promise<void> {
  await mkdir(DIR, { recursive: true });
  await appendFile(fileOf(runKey), `${JSON.stringify({ ...entry, at: Date.now() })}\n`);
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
