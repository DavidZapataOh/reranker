import { endPools, withSystem } from "@reranker/db";
import { workflowStarts } from "@reranker/db/schema";
import { resetAppEnv } from "@reranker/env";
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeEach, expect, test, vi } from "vitest";

// The run itself is covered by the workflow project; here only the start is replaced, so the
// claim in ops.workflow_starts is the real one.
const api = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("workflow/api", () => api);
// Next and the workflow bundler resolve it to an empty module; plain Node does not.
vi.mock("server-only", () => ({}));

const { GET } = await import("../src/app/api/cron/daily/route");

const CRON_SECRET = "cron-secret-with-enough-length";
const url = "https://reranker.co/api/cron/daily";

// Each run claims a date of its own, far from any real one, so reruns on the same database start
// from an empty claim.
const year = 3000 + Math.floor(Math.random() * 5000);
const date = `${year}-06-01`;

beforeEach(() => {
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  resetAppEnv();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${date}T10:00:00Z`));
  let runs = 0;
  api.start.mockImplementation(async () => ({ runId: `wrun_daily_${++runs}` }));
});

afterAll(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetAppEnv();
  await withSystem("test.cron", (tx) =>
    tx
      .delete(workflowStarts)
      .where(and(eq(workflowStarts.kind, "daily"), eq(workflowStarts.key, date))),
  );
  await endPools();
});

const startsFor = async (kind: string, key: string) => {
  const [row] = await withSystem("test.cron", (tx) =>
    tx
      .select({ n: count() })
      .from(workflowStarts)
      .where(and(eq(workflowStarts.kind, kind), eq(workflowStarts.key, key))),
  );
  return row?.n ?? 0;
};

test("cron without bearer is 401", async () => {
  expect((await GET(new Request(url))).status).toBe(401);
});

test("cron with bearer starts the daily workflow once per date even if called 3 times", async () => {
  const res = await Promise.all(
    [1, 2, 3].map(() =>
      GET(new Request(url, { headers: { authorization: `Bearer ${CRON_SECRET}` } })),
    ),
  );
  const bodies = await Promise.all(res.map((r) => r.json()));
  expect(res.map((r) => r.status)).toEqual([200, 200, 200]);
  expect(new Set(bodies.map((b) => b.runId)).size).toBe(1);
  expect(bodies.filter((b) => b.created)).toHaveLength(1);
  expect(api.start).toHaveBeenCalledTimes(1);
  expect(await startsFor("daily", date)).toBe(1);
});
