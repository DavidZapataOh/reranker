import { resetAppEnv } from "@reranker/env";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("workflow/api", () => api);
const jobs = vi.hoisted(() => ({ startOnce: vi.fn() }));
vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  startOnce: jobs.startOnce,
}));

const { GET } = await import("./route");
const { hourlyEvidenceWorkflow } = await import("../../../../workflows/evidence/hourly");

const CRON_SECRET = "cron-secret-with-enough-length";
const bearer = { authorization: `Bearer ${CRON_SECRET}` };

function cron(headers: Record<string, string> = {}) {
  return GET(new Request("https://reranker.co/api/cron/evidence-hourly", { headers }));
}

beforeEach(() => {
  vi.stubEnv("APP_ENV", "production");
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  resetAppEnv();
  vi.useFakeTimers({ toFake: ["Date"] });
  // Vercel Cron delivers within the scheduled minute, sometimes a little late.
  vi.setSystemTime(new Date("2026-11-18T14:00:37Z"));
  api.start.mockReset();
  api.start.mockResolvedValue({ runId: "wrun_hourly" });
  // One claim per key, as the workflow_starts table enforces.
  const claimed = new Set<string>();
  jobs.startOnce.mockReset();
  jobs.startOnce.mockImplementation(async (kind, key, start) => {
    if (claimed.has(`${kind}:${key}`)) return { runId: "wrun_hourly", created: false };
    claimed.add(`${kind}:${key}`);
    return { ...(await start()), created: true };
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetAppEnv();
});

test("one run per UTC hour even if the cron is delivered three times", async () => {
  const responses = [await cron(bearer), await cron(bearer), await cron(bearer)];
  expect(await Promise.all(responses.map((r) => r.json()))).toEqual([
    { runId: "wrun_hourly", created: true },
    { runId: "wrun_hourly", created: false },
    { runId: "wrun_hourly", created: false },
  ]);
  expect(jobs.startOnce).toHaveBeenCalledWith(
    "evidence-hourly",
    "2026-11-18T14",
    expect.any(Function),
  );
  expect(api.start).toHaveBeenCalledExactlyOnceWith(hourlyEvidenceWorkflow, ["2026-11-18T14"]);
});

test("the next hour starts its own run", async () => {
  await cron(bearer);
  vi.setSystemTime(new Date("2026-11-18T15:00:02Z"));
  expect(await (await cron(bearer)).json()).toEqual({ runId: "wrun_hourly", created: true });
  expect(api.start).toHaveBeenLastCalledWith(hourlyEvidenceWorkflow, ["2026-11-18T15"]);
});

test.each([
  ["no bearer", {}],
  ["a wrong bearer", { authorization: "Bearer nope" }],
])("rejects %s with 401 before touching the database", async (_, headers) => {
  const response = await cron(headers);
  expect(response.status).toBe(401);
  expect(jobs.startOnce).not.toHaveBeenCalled();
  expect(api.start).not.toHaveBeenCalled();
});
