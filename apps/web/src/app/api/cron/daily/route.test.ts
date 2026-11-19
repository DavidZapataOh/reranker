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
const { dailyMaintenanceWorkflow } = await import("../../../../workflows/maintenance/daily");

const CRON_SECRET = "cron-secret-with-enough-length";

function cron(headers: Record<string, string> = {}) {
  return GET(new Request("https://reranker.co/api/cron/daily", { headers }));
}

beforeEach(() => {
  vi.stubEnv("APP_ENV", "production");
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  resetAppEnv();
  vi.useFakeTimers({ toFake: ["Date"] });
  // 05:00 in Bogota, when Vercel calls it.
  vi.setSystemTime(new Date("2026-11-17T10:00:00Z"));
  api.start.mockReset();
  api.start.mockResolvedValue({ runId: "wrun_daily" });
  jobs.startOnce.mockReset();
  jobs.startOnce.mockImplementation(async (_kind, _key, start) => ({
    ...(await start()),
    created: true,
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetAppEnv();
});

test("starts the day's maintenance run once per Bogota date and answers with it", async () => {
  const response = await cron({ authorization: `Bearer ${CRON_SECRET}` });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ runId: "wrun_daily", created: true });
  expect(jobs.startOnce).toHaveBeenCalledExactlyOnceWith(
    "daily",
    "2026-11-17",
    expect.any(Function),
  );
  expect(api.start).toHaveBeenCalledExactlyOnceWith(dailyMaintenanceWorkflow, ["2026-11-17"]);
});

test("a repeated delivery answers with the run already started", async () => {
  jobs.startOnce.mockResolvedValue({ runId: "wrun_daily", created: false });
  const response = await cron({ authorization: `Bearer ${CRON_SECRET}` });
  expect(await response.json()).toEqual({ runId: "wrun_daily", created: false });
  expect(api.start).not.toHaveBeenCalled();
});

test.each([
  ["no bearer", {}],
  ["a wrong bearer", { authorization: "Bearer nope" }],
  ["the bare secret", { authorization: CRON_SECRET }],
])("rejects %s with 401 before touching the database", async (_, headers) => {
  const response = await cron(headers);
  expect(response.status).toBe(401);
  expect(jobs.startOnce).not.toHaveBeenCalled();
  expect(api.start).not.toHaveBeenCalled();
});

test("stays closed while the cron secret is unset", async () => {
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("CRON_SECRET", "");
  resetAppEnv();
  expect((await cron({ authorization: "Bearer " })).status).toBe(401);
  expect(jobs.startOnce).not.toHaveBeenCalled();
});
