const API = "https://console.neon.tech/api/v2";

export type WaitForCiBranchSlotOptions = {
  apiKey: string;
  projectId: string;
  max?: number;
  attempts?: number;
  delayMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export function countLiveCiBranches(branches: { name: string }[]): number {
  return branches.filter((b) => b.name.startsWith("ci/")).length;
}

// Neon caps branches per project; queueing here keeps parallel runs from failing on the limit.
export async function waitForCiBranchSlot({
  apiKey,
  projectId,
  max = 8,
  attempts = 5,
  delayMs = 60_000,
  fetch: request = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: WaitForCiBranchSlotOptions): Promise<{ live: number; attempt: number }> {
  let live = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // The search narrows the page to CI branches and the API's maximum limit keeps it from truncating.
    const url = `${API}/projects/${encodeURIComponent(projectId)}/branches?search=ci%2F&limit=10000`;
    const response = await request(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error(`Neon API ${response.status}`);
    const { branches } = (await response.json()) as { branches: { name: string }[] };
    live = countLiveCiBranches(branches);
    console.log(`live=${live} attempt=${attempt}`);
    if (live < max) return { live, attempt };
    if (attempt < attempts) await sleep(delayMs);
  }
  throw new Error(`No free Neon CI branch slot after ${attempts} attempts (${live} live)`);
}
