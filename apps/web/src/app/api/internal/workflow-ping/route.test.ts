import { resetAppEnv } from "@reranker/env";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("workflow/api", () => api);

const { POST } = await import("./route");
const { pingWorkflow } = await import("../../../../workflows/diagnostics/ping");

const CRON_SECRET = "cron-secret-with-enough-length";

function ping(headers: Record<string, string> = {}) {
  return POST(
    new Request("https://reranker.co/api/internal/workflow-ping", { method: "POST", headers }),
  );
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  api.start.mockReset();
  api.start.mockResolvedValue({ runId: "wrun_test" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetAppEnv();
});

test("starts the ping workflow with a fresh nonce and answers with its run id", async () => {
  const response = await ping({ authorization: `Bearer ${CRON_SECRET}` });
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ runId: "wrun_test" });
  expect(api.start).toHaveBeenCalledWith(pingWorkflow, [expect.any(String)]);
  const nonce = api.start.mock.calls[0]?.[1]?.[0];
  await ping({ authorization: `Bearer ${CRON_SECRET}` });
  expect(api.start.mock.calls[1]?.[1]?.[0]).not.toBe(nonce);
});

test.each([
  ["no bearer", {}],
  ["a wrong bearer", { authorization: "Bearer nope" }],
  ["the bare secret", { authorization: CRON_SECRET }],
])("rejects %s without starting a run", async (_, headers) => {
  const response = await ping(headers);
  expect(response.status).toBe(401);
  expect(api.start).not.toHaveBeenCalled();
});

test("stays closed while the cron secret is unset", async () => {
  vi.stubEnv("CRON_SECRET", "");
  expect((await ping({ authorization: "Bearer " })).status).toBe(401);
  expect(api.start).not.toHaveBeenCalled();
});
