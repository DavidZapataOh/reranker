import { resetAppEnv } from "@reranker/env";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const telemetry = vi.hoisted(() => ({
  log: { info: vi.fn() },
  runAfter: vi.fn(),
  requestIdFrom: (headers: Headers) => headers.get("x-vercel-id") ?? "local",
}));
vi.mock("@reranker/telemetry", () => telemetry);

const { GET } = await import("./route");

function fault(kind: string | null, headers: Record<string, string> = {}) {
  const url = new URL("https://reranker.co/api/ops/fault");
  if (kind) url.searchParams.set("kind", kind);
  return GET(new Request(url, { headers }));
}

beforeEach(() => {
  vi.stubEnv("APP_ENV", "preview");
  resetAppEnv();
  telemetry.log.info.mockClear();
  telemetry.runAfter.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetAppEnv();
});

test("handler throws for Next to report", async () => {
  await expect(fault("handler")).rejects.toThrowError("ops fault: handler");
});

test("pii throws an error that carries an email and a phone", async () => {
  await expect(fault("pii")).rejects.toThrowError(
    "ops fault: ana.prueba@reranker.co +57 310 555 1234",
  );
});

test("after answers first and throws inside runAfter", async () => {
  const response = await fault("after");
  expect(response.status).toBe(202);
  expect(telemetry.runAfter).toHaveBeenCalledOnce();
  const task = telemetry.runAfter.mock.calls[0]?.[0] as () => Promise<void>;
  await expect(task()).rejects.toThrowError("ops fault: after");
});

test("log writes one line tied to the request", async () => {
  const response = await fault("log", { "x-vercel-id": "iad1::abc" });
  expect(response.status).toBe(200);
  expect(telemetry.log.info).toHaveBeenCalledWith("ops fault: log", { request_id: "iad1::abc" });
});

test("an unknown kind is a client error", async () => {
  expect((await fault("nope")).status).toBe(400);
  expect((await fault(null)).status).toBe(400);
});

test("production hides the route without the cron bearer", async () => {
  vi.stubEnv("APP_ENV", "production");
  vi.stubEnv("CRON_SECRET", "");
  resetAppEnv();
  expect((await fault("handler")).status).toBe(404);
  expect(telemetry.runAfter).not.toHaveBeenCalled();
});
